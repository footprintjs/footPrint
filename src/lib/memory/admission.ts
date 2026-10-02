/**
 * admission.ts — the admitted record's check (9.30.0): does a commit's bundle
 * fold back to what its stage read? (docs/design/2026-10-admitted-record.md)
 *
 * THE LAW: a commit is admitted only if its bundle, replayed onto the state
 * the stage began from, gives back the stage's read-your-writes view at every
 * path the stage touched — and at every container and array slot its writes
 * made on the way there, below the stage's address.
 *
 * Pure: handed the candidate rows, the stage's diff base, its working copy,
 * its op trace and its address, {@link lossyFamilies} answers which families
 * of touched paths do not fold back. `TransactionBuffer · admit` asks once per
 * commit that staged a `merge` or a nested op, and lays the rows out again
 * with those families written as what the stage read. The fold is the one
 * verb switch ({@link dryFold}, no clone); the compare is {@link deepEqual}.
 */

import { isContainer, nativeGet as _get, ownChild } from './pathOps.js';
import type { MemoryPatch, TraceEntry } from './types.js';
import { deepEqual, DELIM, dryFold } from './utils.js';

/** The rows a payload is built from, before the commit names its redacted paths. */
export type Rows = { overwrite: MemoryPatch; updates: MemoryPatch; trace: TraceEntry[] };

/** One staged op, as `TransactionBuffer` records it. */
export type StagedOp = { path: string; verb: string; readKeys?: string[] };

/** A staged path in a {@link Family}, with its last op's read prefix. */
export type Member = { path: string; readKeys?: string[] };

/**
 * A family of TOUCHED paths: every staged path under its shallowest staged
 * ancestor-or-self — the unit the check verifies and, when it does not fold
 * back, the unit re-encoded. Two families never overlap.
 */
export type Family = {
  root: string;
  rootSegments: string[];
  /** Its staged paths, by last touch. */
  members: Member[];
  /** Index in the op trace of the family's last op: where its re-encoded rows go. */
  slot: number;
};

/** The families whose rows did not fold back, and which family every staged path is in. */
export type Lossy = { rootOf: Map<string, string>; families: Map<string, Family> };

/**
 * The families of `ops` whose candidate rows do not fold back to what the
 * stage read — `undefined` when every family does. Each family ROOT is
 * compared: its value ({@link deepEqual} — a root covers every descendant, an
 * own `undefined` is a deleted key) and the way down to it ({@link spineHeld}).
 */
export function lossyFamilies(
  candidate: Rows,
  base: unknown,
  workingCopy: unknown,
  ops: readonly StagedOp[],
  address: readonly string[],
): Lossy | undefined {
  const fold = dryFold(base, candidate.updates, candidate.overwrite, candidate.trace);
  const { rootOf, families } = touchedFamilies(ops);
  let lossy: Map<string, Family> | undefined;
  for (const family of families.values()) {
    const segments = family.rootSegments;
    const held =
      deepEqual(_get(fold, segments), _get(workingCopy, segments)) && spineHeld(fold, workingCopy, segments, address);
    if (!held) (lossy ??= new Map()).set(family.root, family);
  }
  return lossy === undefined ? undefined : { rootOf, families: lossy };
}

/**
 * Every staged path grouped under its SHALLOWEST staged ancestor-or-self —
 * over TOUCHED paths, not surviving ones: an op the net-change filter drops
 * can still have changed what the stage reads (L-1). Members are listed by
 * last touch; a family's slot is its last op.
 */
export function touchedFamilies(ops: readonly StagedOp[]): {
  rootOf: Map<string, string>;
  families: Map<string, Family>;
} {
  const touches = new Map<string, { last: number; readKeys?: string[] }>();
  for (let i = 0; i < ops.length; i++) {
    touches.delete(ops[i].path); // re-insert: the Map's order is last-touch order
    touches.set(ops[i].path, { last: i, readKeys: ops[i].readKeys });
  }
  const rootOf = new Map<string, string>();
  const families = new Map<string, Family>();
  for (const [path, touch] of touches) {
    const root = shallowestIn(path, touches);
    rootOf.set(path, root);
    let family = families.get(root);
    if (family === undefined) {
      family = { root, rootSegments: root.split(DELIM), members: [], slot: touch.last };
      families.set(root, family);
    }
    family.members.push({ path, readKeys: touch.readKeys });
    if (touch.last > family.slot) family.slot = touch.last;
  }
  return { rootOf, families };
}

/**
 * How many leading segments of `path` are the stage's `address` — its length
 * when `path` lies strictly below it, else 0.
 */
export function addressDepthOf(path: readonly (string | number)[], address: readonly string[]): number {
  const depth = address.length;
  if (depth === 0 || path.length <= depth) return 0;
  for (let i = 0; i < depth; i++) if (String(path[i]) !== address[i]) return 0;
  return depth;
}

/**
 * L-1: a nested op through an absent or primitive parent makes that parent a
 * container in the working copy — and when the op itself changes nothing (a
 * delete of a key that was never there) no row is left to make it in the
 * fold, so the stage reads back a container the record never mentions. The
 * same op on an ARRAY parent past its end grows it (`delete a.0` on `[]`
 * reads back `[undefined]`). Every container the working copy holds on the
 * way to `segments`, and every array slot each step lands in, must be one the
 * fold holds too — below the stage's address, whose containers are where it
 * writes, not a value it reads.
 */
function spineHeld(fold: unknown, workingCopy: unknown, segments: string[], address: readonly string[]): boolean {
  const from = addressDepthOf(segments, address);
  let f: unknown = fold;
  let w: unknown = workingCopy;
  for (let i = 0; i < segments.length; i++) {
    if (i >= from && !slotHeld(f, w, segments[i])) return false;
    if (i === segments.length - 1) return true;
    f = ownChild(f, segments[i]);
    w = ownChild(w, segments[i]);
    if (!isContainer(w)) return true;
    if (i >= from && (!isContainer(f) || Array.isArray(f) !== Array.isArray(w))) return false;
  }
  return true;
}

/**
 * Does the fold hold every array slot the working copy's container `w` holds
 * at `key`? Only an array can be grown by a write that changes nothing else
 * (an index past its end, set to `undefined`); an object's own `undefined`
 * key is a deleted key to every reader, so objects always pass.
 */
function slotHeld(f: unknown, w: unknown, key: string): boolean {
  if (!Array.isArray(w)) return true;
  const index = Number(key);
  if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= w.length) return true;
  return Array.isArray(f) && index < f.length;
}

/** The shallowest of `path` and its ancestors that `touched` holds — its family's root. */
function shallowestIn(path: string, touched: ReadonlyMap<string, unknown>): string {
  if (path.indexOf(DELIM) === -1) return path;
  const segments = path.split(DELIM);
  for (let i = 1; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join(DELIM);
    if (touched.has(ancestor)) return ancestor;
  }
  return path;
}
