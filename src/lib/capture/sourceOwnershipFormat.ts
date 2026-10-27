import type { LogAddress } from 'foottrace';
import { buildRuntimeStageId, isExecutionKey, parseRuntimeStageId } from 'foottrace';

/** Immutable format-v1 ceilings, not writer tuning. Changing these requires another wire version. */
export const SOURCE_OWNERSHIP_V1_LIMITS = Object.freeze({
  executions: 4096,
  attempts: 16384,
  bytes: 524288,
  depth: 64,
  name: 2048,
});
export const SOURCE_OWNERSHIP_GAPS = Object.freeze([
  'identity-unavailable',
  'namespace-changed',
  'execution-limit',
  'attempt-limit',
  'bytes-limit',
  'attempt-unavailable',
  'commit-unavailable',
  'source-address-unproven',
  'redacted-export',
] as const);
export type SourceOwnershipGap = (typeof SOURCE_OWNERSHIP_GAPS)[number];

/** Native execution identity and actual stage-function invocations. No values, timings or outcomes. */
export interface SourceExecutionOwnership {
  readonly runtimeStageId: string;
  readonly stateAddress: readonly string[];
  /** First real commit of this execution; absent while it has not committed. */
  readonly firstCommit?: number;
  readonly attemptIds: readonly string[];
}

/** One native source-book segment. A storage receipt does not authenticate this observation. */
export interface SourceOwnershipWitness {
  readonly version: 1;
  readonly runId: string;
  readonly logAddress: LogAddress;
  readonly segment: number;
  readonly commits: { readonly from: number; readonly to: number };
  readonly status: 'captured' | 'unknown';
  readonly limitations: readonly SourceOwnershipGap[];
  readonly executions: readonly SourceExecutionOwnership[];
}

/** Compose the public codec; its permissive legacy parse alone does not prove a native execution. */
export function isNativeSourceExecution(id: string): boolean {
  if (!isExecutionKey(id)) return false;
  const parsed = parseRuntimeStageId(id);
  return (
    !!parsed.stageId &&
    Number.isSafeInteger(parsed.executionIndex) &&
    parsed.executionIndex >= 0 &&
    buildRuntimeStageId(parsed.stageId, parsed.executionIndex, parsed.subflowPath) === id
  );
}
