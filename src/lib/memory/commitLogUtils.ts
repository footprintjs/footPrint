/**
 * Typed utilities for querying the commit log.
 *
 * The commitLog is an ordered array of CommitBundle — one per stage commit.
 * These helpers provide type-safe queries without (b: any) casts.
 */

import { DELIM } from './paths.js';
import type { CommitBundle } from './types.js';
import { type Touch, foldKey, isVerb, UnknownVerbError } from './verbs.js';

/** Find the first commit by stageId, optionally filtering by a written key. */
export function findCommit(commitLog: CommitBundle[], stageId: string, key?: string): CommitBundle | undefined {
  return commitLog.find((b) => b.stageId === stageId && (!key || b.trace.some((t) => t.path === key)));
}

/** Find all commits by stageId. */
export function findCommits(commitLog: CommitBundle[], stageId: string): CommitBundle[] {
  return commitLog.filter((b) => b.stageId === stageId);
}

/** Find the last commit that wrote a specific key (for backtracking). */
export function findLastWriter(commitLog: CommitBundle[], key: string, beforeIdx?: number): CommitBundle | undefined {
  const end = beforeIdx ?? commitLog.length;
  for (let i = end - 1; i >= 0; i--) {
    if (commitLog[i].trace.some((t) => t.path === key)) {
      return commitLog[i];
    }
  }
  return undefined;
}

/**
 * Every row on `key` in `commitLog[0..end]`, in commit order — the touches a
 * per-path fold ({@link foldKey}) runs over. `key` is matched against
 * `TraceEntry.path` exactly (DELIM-joined for nested paths). A row whose verb
 * is not one of the four is refused with {@link UnknownVerbError} naming the
 * row — whether or not the fold would have reached it: the answer must not
 * depend on where an optimisation starts.
 *
 * Internal: `commitValueAt` and `arrayProvenance` are its two readers.
 */
export function keyTouches(commitLog: readonly CommitBundle[], key: string, end: number): Touch[] {
  const touches: Touch[] = [];
  for (let i = 0; i <= end; i++) {
    const trace = commitLog[i].trace;
    for (let row = 0; row < trace.length; row++) {
      if (trace[row].path !== key) continue;
      const verb = trace[row].verb;
      if (!isVerb(verb)) throw new UnknownVerbError(verb, { path: key, row, commit: i });
      touches.push({ verb, bundle: commitLog[i], commitIdx: i });
    }
  }
  return touches;
}

/**
 * Reconstruct the FULL value of `key` as of commit array index `idx`
 * (inclusive) — the migration helper for the "read `bundle.overwrite[key]`
 * as the full value written" pattern (#13c-B).
 *
 * Under `commitValues: 'delta'`, an `append` bundle's `overwrite[key]` holds
 * only the TAIL of the array; this helper folds the verbs back together:
 * it scans `commitLog[0..idx]` for trace entries on `key`, anchors at the
 * latest full-value write (`set` — or `delete`, which resets to absent), and
 * folds forward with the SAME step and clone discipline the replay uses
 * (`verbs.ts` · `foldKey`) — the per-key slice of `applySmartMerge`'s replay,
 * O(key's commit span) instead of a full `materialise()`. Two `merge` rows of
 * one bundle see one copy of the bundle's delta, as the replay's do (a clone per
 * row, as this helper once took, made an array union — which deduplicates by
 * reference — duplicate the elements the first row had placed).
 *
 * Works on full-mode logs too (every `set` is its own anchor — equivalent to
 * `findLastWriter(...).overwrite[key]`).
 *
 * @param key  Matched against `TraceEntry.path` exactly (same contract as
 *   `findLastWriter`) — DELIM-joined for nested paths.
 * @param idx  CommitBundle ARRAY index (the `bundle.idx` position),
 *   inclusive. NOT the executionIndex from a runtimeStageId.
 * @returns The reconstructed value (a detached clone), or `undefined` when
 *   the key was never written in `commitLog[0..idx]` or its last write was a
 *   delete. Caveat: values derived purely from the run's INITIAL state (no
 *   `set` anchor in the log — e.g. merges onto a seeded key) fold from
 *   absent; the commit log alone cannot see the pre-run base (the same blind
 *   spot `findLastWriter` has). Since 9.17.0 the base TRAVELS with the log, so
 *   `stateAt(snapshot, idx).state[key]` (footprintjs/trace) answers this case
 *   correctly — it folds from `RuntimeSnapshot.initialState`, which this
 *   function never receives.
 * @throws {@link UnknownVerbError} when a row on `key` carries a verb other
 *   than `set | merge | append | delete` — a foreign or corrupted log is
 *   refused, not folded as a `merge`. Engine-written logs never carry one.
 */
export function commitValueAt(commitLog: CommitBundle[], idx: number, key: string): unknown {
  const touches = keyTouches(commitLog, key, Math.min(idx, commitLog.length - 1));
  if (touches.length === 0) return undefined;
  return foldKey(touches, key.split(DELIM), { anchored: true });
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
