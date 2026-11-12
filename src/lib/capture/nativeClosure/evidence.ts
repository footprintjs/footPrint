import type { CommitBundle } from 'foottrace';
import { parseAttemptId } from 'foottrace';

import { type NativeCaptureExtent, NATIVE_EXTENT_MAX_INVOCATIONS } from '../nativeExtent/format.js';
import { ownData } from '../noteShape.js';
import { storedTreeStages } from '../storedTreeStages.js';
import type { NativeCaptureClosure } from './format.js';

/**
 * Consistency of already collected, inert, bounded identities—not selection or causal reconstruction.
 * A checksum cannot detect a coherent rewrite, but missing or contradictory retained witnesses must refuse.
 */
export function validateClosureEvidence(
  closure: NativeCaptureClosure,
  extent: NativeCaptureExtent,
  tree: unknown,
  commitLog: readonly CommitBundle[],
): boolean {
  if (closure.commits.from !== 0 || closure.commits.to !== commitLog.length) return false;
  const nodes = new Map<string, number>();
  const stages = storedTreeStages(tree, 100_000);
  if (!stages) return false;
  let entered = 0;
  for (const node of stages) {
    const id = ownData(node, 'runtimeStageId');
    const count = ownData(node, 'nativeInvocations');
    if (
      typeof id !== 'string' ||
      !id ||
      nodes.has(id) ||
      !Number.isSafeInteger(count) ||
      Object.is(count, -0) ||
      (count as number) < 0 ||
      (count as number) > NATIVE_EXTENT_MAX_INVOCATIONS
    )
      return false;
    const sourceCount = ownData(node, 'readSourceInvocations');
    if (Object.hasOwn(node, 'readSourceInvocations') && sourceCount !== count) return false;
    nodes.set(id, count as number);
    entered += count as number;
    if (entered > extent.invocations.started) return false;
  }
  if (entered !== extent.invocations.started) return false;
  const primary = new Set<string>();
  for (const commit of commitLog) {
    if (!nodes.has(commit.runtimeStageId)) return false;
    if (commit.phase === undefined) {
      if (primary.has(commit.runtimeStageId)) return false;
      primary.add(commit.runtimeStageId);
    }
  }
  for (const id of nodes.keys()) if (!primary.has(id)) return false;
  const selected = closure.selectedFailure;
  if (selected) {
    const attempt = parseAttemptId(selected.attemptId);
    if (!attempt || nodes.get(selected.runtimeStageId) !== attempt.attempt || !primary.has(selected.runtimeStageId))
      return false;
  }
  return true;
}
