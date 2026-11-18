import type { LogAddress } from 'foottrace';
import { LOG_PLACEHOLDER } from 'foottrace/write';

import type { ExplainCaptureNote } from './explainCoverage.js';

interface IdentityRedaction {
  isInert(): boolean;
  retainBoundary<T>(record: T, placeholder?: string): T;
}

/** A served v3 note is only useful while its entire bound identity is visible. */
export function hidesExplainIdentity(
  rule: IdentityRedaction | undefined,
  runId: string,
  logAddress: LogAddress,
): boolean {
  if (!rule || rule.isInert()) return false;
  const identity = { capture: { runId, logAddress } };
  return rule.retainBoundary(identity, LOG_PLACEHOLDER) !== identity;
}

export function hidesExplainFailureStage(
  rule: IdentityRedaction | undefined,
  stage: Readonly<{ runId: string; runtimeStageId: string }> | undefined,
): boolean {
  if (!stage || !rule || rule.isInert()) return false;
  const identity = { capture: { boundary: { failure: { stage } } } };
  return rule.retainBoundary(identity, LOG_PLACEHOLDER) !== identity;
}

/** A parent can acquire another privacy mark after a child finished. Keep its category but not the stage. */
export function redactLateExplainFailureStage(
  note: ExplainCaptureNote,
  rule: IdentityRedaction | undefined,
): ExplainCaptureNote {
  const { status, failure } = note.boundary;
  if (!failure || !hidesExplainFailureStage(rule, failure.stage)) return note;
  const attention = note.channels.attention;
  return Object.freeze({
    ...note,
    boundary: Object.freeze({ status, failure: Object.freeze({ category: failure.category }) }),
    channels: Object.freeze({
      ...note.channels,
      attention: Object.freeze({
        ...attention,
        status: attention.status === 'collected' ? 'partial' : attention.status,
        reasons: Object.freeze([...new Set([...attention.reasons, 'missing-evidence' as const])]),
      }),
    }),
  });
}
