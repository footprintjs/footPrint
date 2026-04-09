/**
 * Typed utilities for querying the commit log.
 *
 * The commitLog is an ordered array of CommitBundle — one per stage commit.
 * These helpers provide type-safe queries without (b: any) casts.
 */

import type { CommitBundle } from './types.js';

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
