/**
 * Typed utilities for querying the commit log.
 *
 * The commitLog is an ordered array of CommitBundle — one per stage commit.
 * These helpers provide type-safe queries without (b: any) casts.
 */

import { deepEqual } from './equality.js';
import { type WriterIndex, ascendingUnion, buildWriterIndex, relation, rootOf, writerCandidates } from './keyPaths.js';
import { DELIM } from './paths.js';
import type { CommitBundle } from './types.js';
import { type Touch, foldKey, isVerb, UnknownVerbError } from './verbs.js';

// Every key query here follows the writer rule and the value rule of `keyPaths.ts` (F3, 9.33.0):
// a key is written by a row ON it, INSIDE it, or AROUND it when that changed it — never by an
// exact path match alone, which called every subflow seed and merge-back "never written".

/**
 * Find the first commit by `stageId`, optionally the first one that WROTE `key` — under the writer
 * rule: a row on the key, inside it, or around it that changed it (see {@link writersOf}).
 */
export function findCommit(commitLog: CommitBundle[], stageId: string, key?: string): CommitBundle | undefined {
  if (!key) return commitLog.find((b) => b.stageId === stageId);
  const writers = new Set(writersOf(commitLog, key));
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
  const end = beforeIdx ?? commitLog.length;
  if (rootOf(key) === key) {
    // A top-level key has no row AROUND it: the writer rule is the path relation alone, and the
    // backward scan stops at the first writer it meets.
    for (let i = end - 1; i >= 0; i--) {
      if (commitLog[i].trace.some((t) => relation(t.path, key) !== undefined)) return commitLog[i];
    }
    return undefined;
  }
  const writers = writersOf(commitLog, key, { end: end - 1 });
  return writers.length > 0 ? commitLog[writers[writers.length - 1]] : undefined;
}

/** What {@link writersOf} is asked. */
export interface WritersOptions {
  /** The last commit ARRAY index considered, inclusive. Default: the whole log. */
  readonly end?: number;
  /** An index of THIS log ({@link buildWriterIndex}) — build it once when asking about many keys. */
  readonly index?: WriterIndex;
}

/**
 * The ARRAY positions (ascending) of every commit in `commitLog[0..end]` that WROTE `key` — the
 * writer rule of `keyPaths.ts`, the one definition every key query shares.
 *
 * A commit with a row on or inside the key is a writer by its path. A commit whose only rows near
 * the key are AROUND it is a writer when the value at the key differs across the whole commit —
 * decided by one fold of the rows under the key's top-level key ({@link foldKey}), and only when
 * such a commit exists, which needs a nested key: a top-level key has nothing around it.
 */
export function writersOf(commitLog: readonly CommitBundle[], key: string, options: WritersOptions = {}): number[] {
  const end = Math.min(options.end ?? commitLog.length - 1, commitLog.length - 1);
  const { atOrInside, aroundOnly } = writerCandidates(options.index ?? buildWriterIndex(commitLog), key);
  const written = atOrInside.filter((i) => i <= end);
  const around = aroundOnly.filter((i) => i <= end);
  if (around.length === 0) return written;
  return ascendingUnion([written, aroundWritersOf(commitLog, key, around)]);
}

/**
 * The commits in `candidates` (ascending; every row near the key is AROUND it) across which the
 * value at `key` changes. The verdict is taken at each of the commit's rows, while the values are
 * current: a later commit may edit the fold's own copy in place.
 */
function aroundWritersOf(commitLog: readonly CommitBundle[], key: string, candidates: readonly number[]): number[] {
  const wanted = new Set(candidates);
  const verdict = new Map<number, boolean>();
  let commit = -1;
  let start: unknown;
  foldKey(rowsUnderRoot(commitLog, key, candidates[candidates.length - 1]), key.split(DELIM), {
    observe: (touch, before, after) => {
      if (!wanted.has(touch.commitIdx)) return;
      if (touch.commitIdx !== commit) {
        commit = touch.commitIdx;
        start = before;
      }
      verdict.set(commit, !deepEqual(start, after));
    },
  });
  return candidates.filter((i) => verdict.get(i) === true);
}

/**
 * Every row under `key`'s TOP-LEVEL key in `commitLog[0..end]`, in commit order — the rows the value
 * rule folds ({@link foldKey}), each with its {@link Touch.relation} to `key` (absent for a sibling
 * under the same top-level key: applied, not observed). A row whose verb is not one of the four is
 * refused with {@link UnknownVerbError} naming the row — whether or not the fold would have reached
 * it: the answer must not depend on where an optimisation starts.
 *
 * Internal: `commitValueAt`, `arrayProvenance` and the writer rule are its readers.
 */
export function rowsUnderRoot(commitLog: readonly CommitBundle[], key: string, end: number): Touch[] {
  const root = rootOf(key);
  const rows: Touch[] = [];
  for (let i = 0; i <= end; i++) {
    const trace = commitLog[i].trace;
    for (let row = 0; row < trace.length; row++) {
      const path = trace[row].path;
      if (path !== root && relation(path, root) !== 'inside') continue;
      const verb = trace[row].verb;
      if (!isVerb(verb)) throw new UnknownVerbError(verb, { path, row, commit: i });
      const r = relation(path, key);
      rows.push(
        r === undefined
          ? { verb, bundle: commitLog[i], commitIdx: i, path }
          : { verb, bundle: commitLog[i], commitIdx: i, path, relation: r },
      );
    }
  }
  return rows;
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
 */
export function commitValueAt(commitLog: CommitBundle[], idx: number, key: string): unknown {
  const rows = rowsUnderRoot(commitLog, key, Math.min(idx, commitLog.length - 1));
  if (!rows.some((row) => row.relation !== undefined)) return undefined;
  return foldKey(rows, key.split(DELIM), { anchored: true });
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
