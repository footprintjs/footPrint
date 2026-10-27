import { parseAttemptId } from 'foottrace';
import type { ReadSourceSnapshot } from 'foottrace/write';

import { captureIdentifier, ownData } from './noteShape.js';
import type { SourceExecutionOwnership, SourceOwnershipWitness } from './sourceOwnershipFormat.js';
import { isNativeSourceExecution, SOURCE_OWNERSHIP_GAPS, SOURCE_OWNERSHIP_V1_LIMITS } from './sourceOwnershipFormat.js';
import type { StoredSourceCounts } from './storedReadSourceCounts.js';

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function samePath(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((part, index) => part === expected[index])
  );
}

function execution(value: unknown, firstCommits: ReadonlyMap<string, number>): SourceExecutionOwnership | undefined {
  const id = ownData(value, 'runtimeStageId');
  const address = ownData(value, 'stateAddress');
  const attempts = ownData(value, 'attemptIds');
  const firstCommit = ownData(value, 'firstCommit');
  if (
    !fields(value, [
      'runtimeStageId',
      'stateAddress',
      'attemptIds',
      ...(firstCommit !== undefined ? ['firstCommit'] : []),
    ]) ||
    !captureIdentifier(id) ||
    !isNativeSourceExecution(id) ||
    !Array.isArray(address) ||
    address.length > SOURCE_OWNERSHIP_V1_LIMITS.depth ||
    address.some((part) => typeof part !== 'string' || part.length > SOURCE_OWNERSHIP_V1_LIMITS.name) ||
    !Array.isArray(attempts) ||
    attempts.length > SOURCE_OWNERSHIP_V1_LIMITS.attempts ||
    firstCommit !== firstCommits.get(id)
  )
    return undefined;
  if (
    !attempts.every((attempt, index) => {
      if (!captureIdentifier(attempt)) return false;
      const parsed = parseAttemptId(attempt);
      return parsed?.runtimeStageId === id && parsed.attempt === index + 1 && parsed.call === undefined;
    })
  )
    return undefined;
  return value as unknown as SourceExecutionOwnership;
}

/** Inert byte-bounded producer metadata only; this validates consistency, not authenticity. */
export function storedSourceOwnership(
  value: unknown,
  record: ReadSourceSnapshot,
  runId: string,
  commits: { readonly from: number; readonly to: number },
  firstCommits: ReadonlyMap<string, number>,
  counts: ReadonlyMap<string, StoredSourceCounts>,
): SourceOwnershipWitness | undefined {
  if (!fields(value, ['version', 'runId', 'logAddress', 'segment', 'commits', 'status', 'limitations', 'executions']))
    return undefined;
  const witness = value as unknown as SourceOwnershipWitness;
  if (
    witness.version !== 1 ||
    witness.runId !== runId ||
    witness.segment !== record.segment ||
    !fields(witness.logAddress, ['logRunId', 'drillPath']) ||
    witness.logAddress.logRunId !== record.address.logRunId ||
    !samePath(witness.logAddress.drillPath, record.address.drillPath) ||
    !fields(witness.commits, ['from', 'to']) ||
    witness.commits.from !== commits.from ||
    witness.commits.to !== commits.to ||
    !Array.isArray(witness.limitations) ||
    witness.limitations.length > SOURCE_OWNERSHIP_GAPS.length ||
    new Set(witness.limitations).size !== witness.limitations.length ||
    witness.limitations.some((gap) => !SOURCE_OWNERSHIP_GAPS.includes(gap)) ||
    witness.status !== (witness.limitations.length ? 'unknown' : 'captured') ||
    !Array.isArray(witness.executions) ||
    witness.executions.length > SOURCE_OWNERSHIP_V1_LIMITS.executions ||
    new TextEncoder().encode(JSON.stringify(witness)).length > SOURCE_OWNERSHIP_V1_LIMITS.bytes
  )
    return undefined;
  const owners = new Map<string, SourceExecutionOwnership>();
  const attemptIds = new Map<string, ReadonlySet<string>>();
  let attempts = 0;
  for (const row of witness.executions) {
    const owner = execution(row, firstCommits);
    if (!owner || !counts.has(owner.runtimeStageId) || owners.has(owner.runtimeStageId)) return undefined;
    const nativeInvocations = counts.get(owner.runtimeStageId)!.invocations;
    if (
      nativeInvocations === undefined ||
      owner.attemptIds.length > nativeInvocations ||
      (witness.status === 'captured' && owner.attemptIds.length !== nativeInvocations)
    )
      return undefined;
    attempts += owner.attemptIds.length;
    if (attempts > SOURCE_OWNERSHIP_V1_LIMITS.attempts) return undefined;
    owners.set(owner.runtimeStageId, owner);
    attemptIds.set(owner.runtimeStageId, new Set(owner.attemptIds));
  }
  if (witness.status === 'captured') {
    // Explicit zero-read native executions are required too; absence cannot impersonate captured-empty.
    if (owners.size !== counts.size || [...counts.keys()].some((id) => !owners.has(id))) return undefined;
    for (const row of record.occurrences) {
      const owner = owners.get(row.runtimeStageId);
      if (
        !owner ||
        !samePath(row.stateAddress, owner.stateAddress) ||
        row.attemptId === undefined ||
        !attemptIds.get(row.runtimeStageId)!.has(row.attemptId)
      )
        return undefined;
    }
  }
  return witness;
}
