import type { LogAddress } from 'foottrace';
import { LOG_PLACEHOLDER } from 'foottrace/write';

import type { ExplainCaptureNote } from './explainCoverage.js';

interface IdentityRedaction {
  isInert(): boolean;
  retainBoundary<T>(record: T, placeholder?: string): T;
}

/** A live policy limits every enabled channel, even for a log that has already ended. */
export function applyExplainPrivacy(note: ExplainCaptureNote): ExplainCaptureNote {
  type Channel = keyof ExplainCaptureNote['channels'];
  let channels: Record<Channel, ExplainCaptureNote['channels'][Channel]> | undefined;
  for (const key of Object.keys(note.channels) as Channel[]) {
    const channel = note.channels[key];
    if (channel.status === 'disabled' || channel.reasons.includes('redacted')) continue;
    channels ??= { ...note.channels };
    channels[key] = Object.freeze({
      mode: channel.mode,
      status: channel.status === 'failed' ? 'failed' : 'unknown',
      reasons: Object.freeze([...channel.reasons, 'redacted' as const]),
    });
  }
  return channels ? Object.freeze({ ...note, channels: Object.freeze(channels) }) : note;
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
