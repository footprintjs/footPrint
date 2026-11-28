import { CHECKPOINT_VERSION, decodeCheckpoint } from '../pause/record.js';
import type { FlowchartCheckpoint } from '../pause/types.js';

export interface ChildContinuationBinding {
  /** Exact host-owned occurrence, independent of a provider's reusable call ID. */
  readonly occurrence: string;
  /** Immutable admitted registration and policy identity. */
  readonly implementation: string;
}

export interface ChildGate {
  readonly id: string;
  readonly revision: number;
}

export type SavedWaitRefusal = 'invalid-continuation' | 'ambiguous-gate';

export interface SavedWait {
  readonly checkpoint: FlowchartCheckpoint;
  readonly gate: ChildGate;
  readonly saved: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function gateOf(
  binding: ChildContinuationBinding,
  checkpoint: FlowchartCheckpoint,
  revision: number,
): ChildGate | SavedWaitRefusal {
  const source = checkpoint.pausedExecution;
  if (!source) return 'invalid-continuation';
  if (checkpoint.pendingPauses?.length) return 'ambiguous-gate';
  return {
    id: JSON.stringify([
      binding.occurrence,
      source.runId,
      source.runtimeStageId,
      checkpoint.pausedStageId,
      checkpoint.subflowPath,
      checkpoint.pausedBy ?? null,
      checkpoint.invokerStageId ?? null,
    ]),
    revision,
  };
}

export function readSavedWait(binding: ChildContinuationBinding, saved: string): SavedWait | SavedWaitRefusal {
  if (typeof saved !== 'string') return 'invalid-continuation';
  try {
    const record: unknown = JSON.parse(saved);
    if (
      !isRecord(record) ||
      record.version !== 1 ||
      record.occurrence !== binding.occurrence ||
      record.implementation !== binding.implementation ||
      !isRecord(record.gate) ||
      typeof record.gate.revision !== 'number' ||
      !Number.isSafeInteger(record.gate.revision) ||
      record.gate.revision < 1 ||
      !isRecord(record.checkpoint) ||
      !Object.hasOwn(record.checkpoint, 'checkpointVersion') ||
      record.checkpoint.checkpointVersion !== CHECKPOINT_VERSION
    ) {
      return 'invalid-continuation';
    }
    // Native resume upcasts legacy versions. This separate admission needs the actual wire version above
    // and the decoded locator here, since native resume can discard an invalid correlation and still run.
    const checkpoint = decodeCheckpoint(record.checkpoint);
    const gate = gateOf(binding, checkpoint, record.gate.revision);
    if (typeof gate === 'string') return gate;
    return record.gate.id === gate.id ? { checkpoint, gate, saved } : 'invalid-continuation';
  } catch {
    return 'invalid-continuation';
  }
}

export function saveWait(
  binding: ChildContinuationBinding,
  checkpoint: FlowchartCheckpoint,
  revision: number,
): SavedWait | SavedWaitRefusal {
  const gate = gateOf(binding, checkpoint, revision);
  if (typeof gate === 'string') return gate;
  try {
    const saved = JSON.stringify({ version: 1, ...binding, gate, checkpoint });
    // Admit the actual JSON that a cold process would receive, including its native checkpoint and gate.
    return readSavedWait(binding, saved);
  } catch {
    return 'invalid-continuation';
  }
}
