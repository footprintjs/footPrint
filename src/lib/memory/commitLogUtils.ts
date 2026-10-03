/**
 * Typed utilities for querying the commit log.
 *
 * The commitLog is an ordered array of CommitBundle — one per stage commit.
 * These helpers provide type-safe queries without (b: any) casts.
 */

import type { RegisteredCode } from './honesty.js';
import { queryWork, relation, rootOf, writesOnlyInside } from './keyPaths.js';
import { leavesStringAbove, logModel, memoisedModel } from './logModel.js';
import { nativeGet } from './pathOps.js';
import { DELIM } from './paths.js';
import type { CommitBundle } from './types.js';
import { type Touch, foldKey, isTotal, isVerb, UnknownVerbError } from './verbs.js';

// Every key query here follows the writer rule and the value rule of `keyPaths.ts` (F3, 9.33.0):
// a key is written by a row ON it, INSIDE it, or AROUND it when that changed it — never by an
// exact path match alone, which called every subflow seed and merge-back "never written". The
// read model that answers them at a cost proportional to the answer is `logModel.ts`; a frozen
// log's model is memoised, and a single question on a log that is not frozen first tries a
// backward scan that stops at the answer.

/**
 * Find the first commit by `stageId`, optionally the first one that WROTE `key` — under the writer
 * rule: a row on the key, inside it, or around it that changed it (see {@link writersOf}).
 */
export function findCommit(commitLog: CommitBundle[], stageId: string, key?: string): CommitBundle | undefined {
  if (!key) return commitLog.find((b) => b.stageId === stageId);
  const writers = new Set(logModel(commitLog).writersOf(key));
  return commitLog.find((b, i) => b.stageId === stageId && writers.has(i));
}

/** Find all commits by stageId. */
export function findCommits(commitLog: CommitBundle[], stageId: string): CommitBundle[] {
  return commitLog.filter((b) => b.stageId === stageId);
}

/**
 * Find the last commit that WROTE `key` before `beforeIdx` (exclusive; default: the whole log) —
 * the anchor of every backward question ("who made it this?").
 *
 * The writer rule (`keyPaths.ts`): a commit writes `key` when one of its rows is ON the key,
 * INSIDE it (a subflow's input seed writes `cfg␟a`; an outputMapper merge-back writes `cfg␟b`;
 * either is a write of `cfg`), or AROUND it with the value at the key different across the commit
 * (a `set` of `cfg` writes `cfg␟a`; a `merge` of `cfg` that never reaches `a` does not). A write
 * found through a row INSIDE the key wrote only PART of its value — the slice readers say so with
 * the `'nested-rows'` note.
 *
 * @param key  A DELIM-joined path (`normalisePath`); a top-level key is a one-segment path.
 */
export function findLastWriter(commitLog: CommitBundle[], key: string, beforeIdx?: number): CommitBundle | undefined {
  const end = Math.min(beforeIdx ?? commitLog.length, commitLog.length);
  const model = memoisedModel(commitLog);
  if (model !== undefined) {
    const at = model.lastWriterBefore(key, end);
    return at >= 0 ? commitLog[at] : undefined;
  }
  // Not frozen: scan back and stop at the first write on or inside the key. A row AROUND the key
  // (or a nested `delete`, which cannot replace a string container) needs a verdict — the model's.
  const nested = rootOf(key) !== key;
  for (let i = end - 1; i >= 0; i--) {
    let write = false;
    let needsVerdict = false;
    queryWork.units += commitLog[i].trace.length;
    for (const t of commitLog[i].trace) {
      const r = relation(t.path, key);
      if (r === 'around') needsVerdict = true;
      else if (r !== undefined) {
        if (t.verb !== 'delete' || !nested) write = true;
        else needsVerdict = true;
      }
    }
    if (write && (!needsVerdict || !leavesStringAbove(commitLog[i], key))) return commitLog[i];
    if (needsVerdict) {
      const at = logModel(commitLog).lastWriterBefore(key, end);
      return at >= 0 ? commitLog[at] : undefined;
    }
  }
  return undefined;
}

/** What {@link writersOf} is asked. */
export interface WritersOptions {
  /** The last commit ARRAY index considered, inclusive. Default: the whole log. */
  readonly end?: number;
}

/**
 * The ARRAY positions (ascending) of every commit in `commitLog[0..end]` that WROTE `key` — the
 * writer rule of `keyPaths.ts`, the one definition every key query shares (`logModel.ts` applies it).
 */
export function writersOf(commitLog: readonly CommitBundle[], key: string, options: WritersOptions = {}): number[] {
  const end = options.end ?? commitLog.length - 1;
  return logModel(commitLog)
    .writersOf(key)
    .filter((i) => i <= end);
}

/**
 * Every row under `key`'s TOP-LEVEL key in `commitLog[0..end]`, in commit order — the rows the value
 * rule folds ({@link foldKey}), each with its {@link Touch.relation} to `key` (absent for a sibling
 * under the same top-level key: applied, not observed) — found through the log's index. A row whose
 * verb is not one of the four is refused with {@link UnknownVerbError} naming the row — whether or
 * not the fold would have reached it: the answer must not depend on where an optimisation starts.
 */
export function rowsUnderRoot(commitLog: readonly CommitBundle[], key: string, end: number): Touch[] {
  return logModel(commitLog).rowsUnderRoot(key, end);
}

/**
 * Reconstruct the FULL value of `key` as of commit array index `idx`
 * (inclusive) — the migration helper for the "read `bundle.overwrite[key]`
 * as the full value written" pattern (#13c-B).
 *
 * The value rule (`keyPaths.ts`, 9.33.0): every row under the key's TOP-LEVEL
 * key in `commitLog[0..idx]` is folded, anchored at that key's last `set` /
 * `delete`, with the SAME step and clone discipline the replay uses
 * (`verbs.ts` · `foldKey`), and the result is read at `key`. So the answer is
 * the value `stateAt` gives at that path when it folds the log alone — rows
 * INSIDE the key (a subflow seed, an outputMapper merge-back) and AROUND it (a
 * `set` of the container) count; before 9.33.0 only rows on the exact path did,
 * and a seeded `cfg` read as `undefined`. Under `commitValues: 'delta'`, an
 * `append` row's `overwrite[key]` holds only the TAIL; the fold puts the array
 * back together. Two `merge` rows of one bundle see one copy of the bundle's
 * delta, as the replay's do.
 *
 * @param key  A DELIM-joined path (`normalisePath`); a top-level key is a
 *   one-segment path.
 * @param idx  CommitBundle ARRAY index (the `bundle.idx` position),
 *   inclusive. NOT the executionIndex from a runtimeStageId.
 * @returns The reconstructed value (a detached clone), or `undefined` when no
 *   row in `commitLog[0..idx]` is on, inside or around the key, or the fold
 *   leaves it absent (its last write was a delete). Caveat: a key that held a
 *   value in the run's INITIAL state folds from absent here — the log alone
 *   cannot see the pre-run base, so merges and nested writes onto a seeded key
 *   give only what they added. Since 9.17.0 the base TRAVELS with the log:
 *   `stateAt(snapshot, idx)` (footprintjs/trace) folds from
 *   `RuntimeSnapshot.initialState`, which this function never receives.
 * @throws {@link UnknownVerbError} when a row under the key's top-level key
 *   carries a verb other than `set | merge | append | delete` — a foreign or
 *   corrupted log is refused, not folded as a `merge`. Engine-written logs
 *   never carry one.
 * @see commitValueAtWithBasis — the same answer, with the codes that say WHY it is
 *   `undefined` or partial (and the `initialState` base this function never receives).
 */
export function commitValueAt(commitLog: CommitBundle[], idx: number, key: string): unknown {
  const end = Math.min(idx, commitLog.length - 1);
  const model = memoisedModel(commitLog);
  if (model !== undefined) return model.valueAt(key, end);
  return valueByScan(commitLog, end, key);
}

// ── The basis twins (F4b, 9.33.0): the same answer, and the codes that say why ──────────────────────

/**
 * Why {@link commitValueAtWithBasis} answered what it did. Each code is registered, with the one
 * sentence that says what it means, in `memory/honesty.ts · HONESTY_CODES` (served on
 * `footprintjs/trace`); the union declares its members through `RegisteredCode`.
 *
 * - `'never-written'`      — no commit in range wrote the key (the writer rule — the answer
 *                            `findLastWriter` and the slice layer give), unless the run removed a value
 *                            the passed `initialState` held (then `'deleted'`), or a redaction at or
 *                            around the key hid the write (then `'redacted'` alone).
 * - `'deleted'`            — the answer is `undefined` and the key WAS written: its last write left it
 *                            absent.
 * - `'nested-rows'`        — the value rests on rows INSIDE the key (a subflow seed, an outputMapper
 *                            merge-back, a fork child's namespace) with no `set`/`delete` of the key or
 *                            of a container around it in range.
 * - `'from-initial-state'` — no `set`/`delete` of the key or around it in range, so the value rests on
 *                            the pre-run base: folded from `options.initialState` when it holds the
 *                            key's top-level key, partial when no `initialState` was passed.
 * - `'redacted'`           — a path at, inside or around the key is in the `redactedPaths` of a commit
 *                            the value rests on (from its last `set`/`delete` on, or the whole range).
 */
export type ValueBasis = RegisteredCode<
  'never-written' | 'deleted' | 'nested-rows' | 'from-initial-state' | 'redacted'
>;

/** What {@link commitValueAtWithBasis} is asked besides the log, the index and the key. */
export interface ValueBasisOptions {
  /**
   * The state before the run — `RuntimeSnapshot.initialState` (or a subflow's
   * `treeContext.initialState`). When given, a key with no `set`/`delete` in range folds from it, as
   * `stateAt` does; when absent, such an answer is the log-only fold and carries `'from-initial-state'`.
   */
  readonly initialState?: Readonly<Record<string, unknown>>;
}

/** A key's value read off the log, and the codes that say what it rests on — absent codes = an exact answer. */
export interface ValueWithBasis {
  readonly value: unknown;
  /** In the order of {@link ValueBasis}'s list; EMPTY when a `set`/`delete` of the key or around it anchors the value and no redaction touched it. */
  readonly basis: ValueBasis[];
}

const VALUE_BASIS_ORDER: readonly ValueBasis[] = [
  'never-written',
  'deleted',
  'nested-rows',
  'from-initial-state',
  'redacted',
];

/**
 * {@link commitValueAt}, with the codes that say what the answer rests on. Without `options.initialState`
 * the value IS `commitValueAt(commitLog, idx, key)` (pinned by a property); with it, a key that has no
 * `set`/`delete` of itself or of a container around it in range folds from that base — the value
 * `stateAt(snapshot, idx)` gives at the key. Refuses an unknown verb exactly as `commitValueAt` does.
 *
 * @example
 * ```typescript
 * const { value, basis } = commitValueAtWithBasis(snap.commitLog, i, 'cfg', { initialState: snap.initialState });
 * for (const code of basis) console.log(code, HONESTY_CODES[code]);
 * ```
 */
export function commitValueAtWithBasis(
  commitLog: CommitBundle[],
  idx: number,
  key: string,
  options: ValueBasisOptions = {},
): ValueWithBasis {
  const end = Math.min(idx, commitLog.length - 1);
  const model = logModel(commitLog);
  const rows = model.rowsUnderRoot(key, end);
  // The last `set`/`delete` ON the key or AROUND it decides the value alone; rows inside after it refine it.
  let anchor = -1;
  let inside = false;
  let lastRelated: Touch | undefined;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].relation;
    if (r === undefined) continue;
    lastRelated = rows[i];
    if (r === 'inside') inside = true;
    else if (isTotal(rows[i].verb)) {
      anchor = i;
      inside = false;
    }
  }
  const root = rootOf(key);
  const base = options.initialState;
  const baseHoldsRoot = base !== undefined && Object.prototype.hasOwnProperty.call(base, root);
  const value =
    anchor === -1 && baseHoldsRoot
      ? foldKey(rows, key.split(DELIM), { anchored: true, start: structuredClone(base[root]) })
      : model.valueAt(key, end);

  const codes = new Set<ValueBasis>();
  // The writer rule decides 'never-written' (as it does for `findLastWriter` and the slice layer), with two
  // corrections only the base and the redaction list can make:
  //   - the run REMOVED a value the passed base held (a `delete` — full mode spells it a `set` — or a `set` of
  //     a container without the key): the log-only verdict sees absent → absent, the truth is 'deleted';
  //   - a redaction at or around the key HID the write (a placeholder string replaced the container): the
  //     log cannot say whether the key was written, so the answer says 'redacted' and nothing else about it.
  const segs = key.split(DELIM);
  const red = redactionsInRange(commitLog, key, anchor === -1 ? 0 : rows[anchor].commitIdx, end);
  const deletedByRow = lastRelated !== undefined && lastRelated.relation !== 'inside' && lastRelated.verb === 'delete';
  const baseHeldKey = base !== undefined && nativeGet(base, segs) !== undefined;
  const removedFromBase = baseHeldKey && value === undefined && !red.any && (anchor !== -1 || deletedByRow);
  const written = (end >= 0 && model.lastWriterBefore(key, end + 1) !== -1) || removedFromBase;
  if (!written) {
    if (!red.hidden) codes.add('never-written');
  } else if (value === undefined && (deletedByRow || removedFromBase || !red.any)) codes.add('deleted');
  if (anchor === -1 && inside) codes.add('nested-rows');
  if (anchor === -1 && (base === undefined || baseHoldsRoot)) codes.add('from-initial-state');
  if (red.any) codes.add('redacted');
  return { value, basis: VALUE_BASIS_ORDER.filter((c) => codes.has(c)) };
}

/**
 * The redacted paths of the commits in `[from, end]` against `key`: `any` — one at, inside or around it;
 * `hidden` — one AT or AROUND it (a placeholder replaced the key or its container, so the write is hidden).
 */
function redactionsInRange(
  commitLog: readonly CommitBundle[],
  key: string,
  from: number,
  end: number,
): { any: boolean; hidden: boolean } {
  let any = false;
  for (let c = from; c <= end; c++) {
    for (const p of commitLog[c].redactedPaths ?? []) {
      const r = relation(p, key);
      if (r === undefined) continue;
      any = true;
      if (r !== 'inside') return { any, hidden: true };
    }
  }
  return { any, hidden: false };
}

/**
 * Why {@link findLastWriterWithBasis} answered what it did — registered in `HONESTY_CODES`:
 * `'never-written'` (no writer before the bound), `'nested-rows'` (the writer reached the key only
 * through rows inside it, so it wrote part of the value).
 */
export type WriterBasis = RegisteredCode<'never-written' | 'nested-rows'>;

/** The last writer of a key, and the codes that say what kind of write it was — absent codes = a write on or around the key. */
export interface WriterWithBasis {
  /** Absent exactly when `basis` holds `'never-written'`. */
  readonly writer?: CommitBundle;
  readonly basis: WriterBasis[];
}

/**
 * {@link findLastWriter}, with the code that says why: `writer` is `findLastWriter(commitLog, key, beforeIdx)`;
 * `basis` is `['never-written']` when there is none and `['nested-rows']` when that commit wrote the key
 * only through rows inside it.
 */
export function findLastWriterWithBasis(commitLog: CommitBundle[], key: string, beforeIdx?: number): WriterWithBasis {
  const writer = findLastWriter(commitLog, key, beforeIdx);
  if (writer === undefined) return { basis: ['never-written'] };
  return { writer, basis: writesOnlyInside(writer, key) ? ['nested-rows'] : [] };
}

/**
 * {@link commitValueAt} on a log that is not frozen: refuse an unknown verb under the top-level key,
 * then scan back from `end` to the last `set` ON the key, keeping the rows on and inside it — enough
 * while nothing AROUND the key was written in between (and, for a nested key, no `delete` on it: a
 * `delete` cannot replace a string container). Otherwise the model folds the top-level key.
 */
function valueByScan(commitLog: CommitBundle[], end: number, key: string): unknown {
  const root = rootOf(key);
  for (let c = 0; c <= end; c++) {
    const trace = commitLog[c].trace;
    queryWork.units += trace.length;
    for (let row = 0; row < trace.length; row++) {
      const { path, verb } = trace[row];
      if ((path === root || relation(path, root) === 'inside') && !isVerb(verb)) {
        throw new UnknownVerbError(verb, { path, row, commit: c });
      }
    }
  }
  const nested = root !== key;
  const rows: Touch[] = [];
  let anchored = false;
  for (let c = end; c >= 0 && !anchored; c--) {
    const trace = commitLog[c].trace;
    for (let row = trace.length - 1; row >= 0; row--) {
      const { path, verb } = trace[row];
      const r = relation(path, key);
      if (r === undefined) continue;
      if (r === 'around' || (nested && r === 'exact' && verb === 'delete')) {
        return logModel(commitLog).valueAt(key, end);
      }
      rows.push({ verb: verb as Touch['verb'], bundle: commitLog[c], commitIdx: c, path, relation: r });
      if (r === 'exact' && (verb === 'set' || verb === 'delete')) {
        anchored = true;
        break;
      }
    }
  }
  if (rows.length === 0) return undefined;
  return foldKey(rows.reverse(), key.split(DELIM));
}

/**
 * Position index over a commit log: `runtimeStageId` → the ARRAY INDEX of the
 * FIRST bundle that stage committed.
 *
 * "First" is the contract, and it is load-bearing. A stage normally commits
 * exactly one bundle, but a subflow MOUNT commits two that share one
 * `runtimeStageId` (the output-mapping commit, then the mount-exit commit).
 * A cursor asks "where does this stage start?", so the first wins — the
 * grouping a reader's axis uses (`commitStops`) anchors at the same place.
 *
 * Build this ONCE when resolving many ids; use {@link commitIndexOf} for a
 * single lookup.
 *
 * @param commitLog Ordered commit bundles — `getSnapshot().commitLog`.
 * @returns A fresh Map, owned by the caller.
 */
export function buildCommitIndex(commitLog: readonly CommitBundle[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < commitLog.length; i++) {
    const id = commitLog[i].runtimeStageId;
    if (!index.has(id)) index.set(id, i);
  }
  return index;
}

/**
 * The ARRAY INDEX of the first commit a given `runtimeStageId` produced, or
 * `-1` when that stage is not in this log (`indexOf` semantics — the name's
 * promise).
 *
 * This is the address translation every reader needs and nobody exported: a
 * `runtimeStageId` is the id an event carries, a commit index is what
 * `commitValueAt` / `stateAt` / `CommitRangeIndex` speak. O(n) — for many
 * lookups build the map once with {@link buildCommitIndex}.
 *
 * A stage that ran inside a SUBFLOW is not in the run-level log (subflows
 * commit to their own isolated log); look it up in that subflow's own
 * `history` instead — see `getSubtreeSnapshot`.
 *
 * @example
 * ```typescript
 * const idx = commitIndexOf(snapshot.commitLog, 'score-risk#7');
 * const before = idx > 0 ? commitValueAt(snapshot.commitLog, idx - 1, 'risk') : undefined;
 * ```
 */
export function commitIndexOf(commitLog: readonly CommitBundle[], runtimeStageId: string): number {
  for (let i = 0; i < commitLog.length; i++) {
    if (commitLog[i].runtimeStageId === runtimeStageId) return i;
  }
  return -1;
}
