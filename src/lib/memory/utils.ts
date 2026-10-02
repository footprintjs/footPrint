/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */

import { deepSmartMerge } from './merge.js';
import {
  nativeDelete,
  nativeGet as _get,
  nativeHas as _has,
  nativeSet as _set,
  own,
  ownedRootOf,
  ownSpine,
} from './pathOps.js';
import { DELIM } from './paths.js';
import type { MemoryPatch, TraceEntry } from './types.js';

// The L0 leaves this file used to hold — re-exported so no importer moved.
export { deepEqual } from './equality.js';
export { deepSmartMerge } from './merge.js';
export { DELIM, normalisePath, pathSegments } from './paths.js';

type NestedObject = { [key: string]: any };

/**
 * Resolves run-namespaced and global paths.
 * Each flowchart execution (run) stores data under `runs/{id}/` to prevent collisions.
 */
export function getRunAndGlobalPaths(runId?: string, path: (string | number)[] = []) {
  return {
    runPath: runId ? ['runs', runId, ...path] : undefined,
    globalPath: [...path],
  };
}

/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 */
export function setNestedValue<T>(
  obj: NestedObject,
  runId: string,
  _path: string[],
  field: string,
  value: T,
  defaultValues?: unknown,
): NestedObject {
  const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
  const path = runPath || globalPath;
  const pathCopy = [...path];
  let current: NestedObject = obj;
  while (pathCopy.length > 0) {
    const key = pathCopy.shift() as string;
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = key === runId && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }
  current[field] = value;
  return obj;
}

/**
 * Deep-merges a value into the object at the specified path.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
export function updateNestedValue<T>(
  obj: any,
  runId: string | undefined,
  _path: (string | number)[],
  field: string | number,
  value: T,
  defaultValues?: unknown,
): any {
  const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
  const path = runPath || globalPath;
  const pathCopy = [...path];
  let current: NestedObject = obj;
  while (pathCopy.length > 0) {
    const key = pathCopy.shift() as string;
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = key === runId && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }
  updateValue(current, field, value);
  return obj;
}

/**
 * In-place value update with merge semantics.
 * - Arrays (non-empty): concatenate onto existing
 * - Arrays (empty):     direct replace — writing `[]` clears the field
 * - Objects (non-empty): shallow merge (spread)
 * - Objects (empty):    direct replace — writing `{}` clears the field
 * - Primitives: direct assignment
 *
 * Note on empty arrays: both `value && Array.isArray(value)` and
 * `Array.isArray(value)` evaluate the same for arrays — `[]` is truthy in
 * JavaScript, so the `&&` guard was never the issue. The actual bug was the
 * concat path: `[...cur, ...[]]` silently returned `cur` unchanged when `value`
 * was `[]`, making `updateValue(obj, 'tags', [])` a no-op instead of a clear.
 * The fix is the explicit `value.length === 0` early-return branch.
 */
export function updateValue(object: any, key: string | number, value: any): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      object[key] = value; // clear: [] replaces whatever was there
    } else {
      const cur = object[key] as any;
      object[key] = cur === undefined ? value : [...cur, ...value];
    }
  } else if (value && typeof value === 'object' && Object.keys(value).length) {
    const cur = object[key] as any;
    object[key] = cur === undefined ? value : { ...cur, ...value };
  } else {
    object[key] = value;
  }
}

/**
 * Gets a value at a nested path with prototype-pollution protection.
 */
export function getNestedValue(root: any, path: (string | number)[], field?: string | number): any {
  const node = path && path.length > 0 ? _get(root, path) : root;
  if (field === undefined || node === undefined) return node;
  if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
    return node[field];
  }
  return undefined;
}

/**
 * Redacts sensitive values in a patch for logging/debugging.
 */
export function redactPatch(patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch {
  const out = structuredClone(patch);
  for (const flat of redactedSet) {
    const pathArr = flat.split(DELIM);
    if (_has(out, pathArr)) {
      const curr = _get(out, pathArr);
      if (typeof curr !== 'undefined') {
        _set(out, pathArr, 'REDACTED');
      }
    }
  }
  return out;
}

/**
 * Is row `i` a `set` that the NEXT row sets again — same path, same verb — so
 * that applying it is work the next row redoes?
 *
 * The one skip every replay iterator shares (9.22.1). A `set` row writes a
 * clone of the recorded value at its path; the next row, a `set` of the same
 * path, writes a clone of the SAME recorded value over it (the bundle's patch
 * tree is fixed), and nothing runs in between — so the first write is
 * unobservable, container creation and key order included. Only CONSECUTIVE
 * rows qualify: a row in between (an ancestor `merge`, a sibling `set` that
 * creates a container) can see the intermediate value, and a `merge`,
 * `append` or `delete` next row depends on what is there. Rows are never
 * dropped from the log — the 9.22.0 element-write funnel records N
 * whole-array `set` rows on one path, and this is what makes replaying them
 * O(N) instead of O(N × rows).
 *
 * Asked by `replayRows` — live state and the redacted mirror through
 * {@link nextGeneration}, `EventLog.materialise` and `stateAt` through
 * {@link applySmartMergeInto}, the public {@link applySmartMerge}, and the
 * admitted record's {@link dryFold} (9.30.0; the delta encoder's own
 * per-family replay, which asked it too, was deleted then).
 * `commitValueAt` needs no skip: it anchors at the LAST `set` by construction.
 */
export function supersededByNextSet(rows: readonly { path: string; verb: string }[], i: number): boolean {
  const row = rows[i];
  if (row.verb !== 'set') return false;
  const next = rows[i + 1];
  return next !== undefined && next.verb === 'set' && next.path === row.path;
}

/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Guarantees "last writer wins" semantics.
 *
 * Returns a FULLY DETACHED result: the base is deep-cloned first and every
 * value the replay writes is its own (`set` / `append` clone the recorded
 * value; the `merge` arm reads a detached copy of `updates`), so the result
 * shares no container with `base`, `updates` or `overwrite`. This is the
 * public (`footprintjs/advanced`) contract, unchanged by copy-on-write
 * (9.29.0) — byte-identical to 9.28.0 for every caller. The engine's own
 * commit does NOT come here: `SharedMemory.applyPatch` builds the next
 * generation with `nextGeneration`, which copies only the written
 * paths. Both run the ONE verb switch, `replayRows`.
 *
 * Verb arms:
 *   - `'set'`    — overwrite with `overwrite[path]` (the full final value).
 *   - `'merge'`  — `deepSmartMerge` the accumulated `updates[path]` delta in.
 *   - `'append'` — (#13c-B delta mode) `overwrite[path]` holds ONLY the tail;
 *     reconstruct by concatenating it onto the current array. When the
 *     current value or the recorded tail is not an array (out-of-order
 *     replay base, or a REDACTED tail — `redactPatch` replaces matched
 *     payloads with the `'REDACTED'` string), degrade to a direct set of the
 *     recorded value — the same terminal value a redacted/corrupt `'set'`
 *     produces.
 *   - `'delete'` — (#13c-B delta mode) remove the key (`nativeDelete`,
 *     prototype-pollution-safe). The path stays enumerated in `overwrite`
 *     (value `undefined`) for key-set consumers; replay ignores that value.
 *
 * Work, not bytes (9.22.1): a `set` row the NEXT row re-sets is skipped
 * ({@link supersededByNextSet}) — the rows stay in the log, only the clone
 * each would have paid is not. Every consumer inherits the skip from
 * `replayRows`; there is no second replay loop to keep in step.
 */
export function applySmartMerge(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  return replayRows(structuredClone(base), updates, overwrite, trace, false);
}

/**
 * The engine's commit (copy-on-write, 9.29.0 — docs/design/2026-10-copy-on-
 * write-commit.md): the NEXT committed generation. A copy of `base`'s ROOT
 * plus a copy of every container on each written path; every other subtree
 * is SHARED with `base`, which is never edited — committed state is
 * immutable-after-swap, so sharing is safe, and a commit costs O(what it
 * wrote), not O(state). `SharedMemory.applyPatch` (live state and the
 * redacted mirror) is its caller. Internal: the public replay is
 * {@link applySmartMerge}.
 */
export function nextGeneration(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  return replayRows(ownedRootOf(base), updates, overwrite, trace, true);
}

/**
 * The same replay, INTO `target` — no clone of its own. For a caller that
 * already holds a private working copy (the read-side folds: `stateAt` in
 * `time-travel/stateAt.ts` and `EventLog.materialise` clone their base ONCE
 * and then apply every bundle here), so a fold over N bundles costs N row
 * applications, not N clones of the whole state. Never hand it committed
 * state: it mutates the ROOT in place. Below the root it follows the live
 * commit's law ({@link nextGeneration}) — a container this call did not
 * create is copied before a write passes through it — so a fold and the live
 * state give the same value at every path, aliased subtrees included.
 * The values it writes are its own, so `target` never aliases the log.
 */
export function applySmartMergeInto(
  target: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: TraceEntry[],
): any {
  return replayRows(target, updates, overwrite, trace, true);
}

/**
 * The fold, for COMPARISON only (9.30.0 — the admitted record): `base` with
 * the bundle replayed by the one verb switch, copy-on-write below the root,
 * every recorded value placed BY REFERENCE — no clone, so it costs what the
 * bundle wrote and nothing more. It aliases the payload and every subtree of
 * `base` the bundle did not write, and edits neither. Never hand it out,
 * store it or write through it: `TransactionBuffer` builds one to ask whether
 * a bundle folds back to what the stage read, then drops it.
 */
export function dryFold(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  return replayRows(ownedRootOf(base), updates, overwrite, trace, true, false);
}

/** Does any row write THROUGH a container (a delimited, nested path)? */
function hasNestedRow(trace: TraceEntry[]): boolean {
  for (let i = 0; i < trace.length; i++) if (trace[i].path.indexOf(DELIM) !== -1) return true;
  return false;
}

/**
 * THE verb switch — the replay replica of CLAUDE.md's "THREE verb-switch
 * replicas in lockstep" (four before 9.30.0 deleted the delta encoder's);
 * every replay above runs it, there is no other.
 * `out` is the caller's: a fresh deep clone ({@link applySmartMerge}), the
 * owned root of a new generation ({@link nextGeneration}), a fold's private
 * working copy ({@link applySmartMergeInto}) or the comparison fold's owned
 * root ({@link dryFold}).
 *
 * `copyOnWrite` — before a row that writes THROUGH a container (a nested
 * path), {@link ownSpine} copies the containers on its path that this replay
 * did not create, so no row edits a container another generation (or the
 * log) holds. Each value an arm creates is marked owned, so later rows of the
 * same bundle write into it in place. A bundle of root-key rows — the typed
 * scope's only kind — allocates no ownership set at all. With
 * `copyOnWrite: false` the target is private through and through (a deep
 * clone) and is edited in place, exactly as before 9.29.0.
 *
 * `detach` — `true` for every fold that keeps its result: the `set` /
 * `append` arms write a clone of the recorded value and the merge arm reads
 * a detached copy of `updates`, so the result never aliases the payload.
 * `false` only for {@link dryFold}, which compares and drops its result: the
 * recorded values are placed by reference and never marked owned (a later
 * row that writes through one copies it first, so the payload is never
 * edited), and the merge arm reads `updates` itself.
 */
function replayRows(
  out: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: TraceEntry[],
  copyOnWrite: boolean,
  detach = true,
): any {
  const owned = copyOnWrite && hasNestedRow(trace) ? new WeakSet<object>() : undefined;
  own(out, owned);
  // The bundle's merge deltas, detached ONCE per replay (lazily — a bundle
  // with no merge row pays nothing): `deepSmartMerge` places an array
  // delta's ELEMENTS by reference, and the redacted mirror and the folds
  // replay the LOG's own `updates`, so without the copy they would share
  // containers with the record (D2 — before copy-on-write the next commit's
  // whole-state clone hid that). Once, not per row: two merge rows of one
  // bundle replay the same accumulated delta, and `deepSmartMerge` dedups an
  // array union BY REFERENCE, so the rows must keep seeing the same objects
  // (a per-row clone duplicated elements — the differential caught it).
  let deltas: MemoryPatch | undefined;
  for (let i = 0; i < trace.length; i++) {
    if (supersededByNextSet(trace, i)) continue;
    const { path, verb } = trace[i];
    const segs = path.split(DELIM);
    if (owned !== undefined && segs.length > 1) ownSpine(out, segs, owned);
    if (verb === 'set') {
      const recorded = _get(overwrite, segs);
      const value = detach ? structuredClone(recorded) : recorded;
      if (detach) own(value, owned);
      _set(out, segs, value);
    } else if (verb === 'append') {
      const recorded = _get(overwrite, segs);
      const tail = detach ? structuredClone(recorded) : recorded;
      const current = _get(out, segs);
      const next = Array.isArray(current) && Array.isArray(tail) ? [...current, ...tail] : tail;
      if (detach) own(next, owned);
      _set(out, segs, next);
    } else if (verb === 'delete') {
      nativeDelete(out, segs);
    } else {
      deltas ??= detach ? structuredClone(updates) : updates;
      const current = _get(out, segs) ?? {};
      const merged = deepSmartMerge(current, _get(deltas, segs));
      own(merged, owned);
      _set(out, segs, merged);
    }
  }
  return out;
}
