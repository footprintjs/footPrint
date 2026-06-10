/**
 * Typed utilities for querying the commit log.
 *
 * The commitLog is an ordered array of CommitBundle — one per stage commit.
 * These helpers provide type-safe queries without (b: any) casts.
 */

import { nativeGet } from './pathOps.js';
import type { CommitBundle } from './types.js';
import { deepSmartMerge, DELIM } from './utils.js';

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
 * Reconstruct the FULL value of `key` as of commit array index `idx`
 * (inclusive) — the migration helper for the "read `bundle.overwrite[key]`
 * as the full value written" pattern (#13c-B).
 *
 * Under `commitValues: 'delta'`, an `append` bundle's `overwrite[key]` holds
 * only the TAIL of the array; this helper folds the verbs back together:
 * it scans `commitLog[0..idx]` for trace entries on `key`, anchors at the
 * latest full-value write (`set` — or `delete`, which resets to absent), and
 * replays forward (`append` → concat, `merge` → `deepSmartMerge`) — exactly
 * the per-key slice of `applySmartMerge`'s replay, O(key's commit span)
 * instead of a full `materialise()`.
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
 *   spot `findLastWriter` has).
 */
export function commitValueAt(commitLog: CommitBundle[], idx: number, key: string): unknown {
  const end = Math.min(idx, commitLog.length - 1);
  const segs = key.split(DELIM);

  // Collect every trace entry touching the key (in order) up to `end`.
  const touches: { verb: string; bundle: CommitBundle }[] = [];
  for (let i = 0; i <= end; i++) {
    for (const t of commitLog[i].trace) {
      if (t.path === key) touches.push({ verb: t.verb, bundle: commitLog[i] });
    }
  }
  if (touches.length === 0) return undefined;

  // Anchor at the latest entry that fully determines the value on its own.
  let start = 0;
  for (let i = touches.length - 1; i >= 0; i--) {
    if (touches[i].verb === 'set' || touches[i].verb === 'delete') {
      start = i;
      break;
    }
  }

  // Fold forward from the anchor — the per-key slice of applySmartMerge.
  let value: unknown;
  for (let i = start; i < touches.length; i++) {
    const { verb, bundle } = touches[i];
    if (verb === 'set') {
      value = structuredClone(nativeGet(bundle.overwrite, segs));
    } else if (verb === 'delete') {
      value = undefined;
    } else if (verb === 'append') {
      const tail = structuredClone(nativeGet(bundle.overwrite, segs));
      value = Array.isArray(value) && Array.isArray(tail) ? [...value, ...tail] : tail;
    } else {
      value = deepSmartMerge(value, structuredClone(nativeGet(bundle.updates, segs)));
    }
  }
  return value;
}
