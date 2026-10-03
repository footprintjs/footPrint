/**
 * pause/record.ts — the checkpoint CODEC (F8, 9.39.0): one version, one
 * upcaster, one validator, one message set.
 *
 * A checkpoint is stored data — Redis, Postgres, a file — and comes back to
 * `resume()` from whichever release wrote it. Until 9.38.0 it was checked in
 * TWO places with two message sets: `FlowChartExecutor · resume` checked the
 * paused record's fields, `ResumeEntry` checked each waiting sibling's
 * (`pendingPauses[n]`) — the SAME record shape, checked twice, differently
 * (the top-level `pausedBy` and `subflowStates` were never checked at all).
 * Both now call {@link decodeCheckpoint}; every record is checked by
 * {@link decodePauseRecord}.
 *
 * VERSIONING. A checkpoint written by this release carries
 * `checkpointVersion: 1`. One written before carries none and is read as
 * version 0 by the ONE upcaster, {@link upcastCheckpoint}: every field
 * 9.14–9.37 added is optional and read as absent, so the only step is
 * dropping `continuationStageId` — a record no resume has read since 9.28.0
 * (what runs after a resume comes from the chart), no longer written, and
 * legacy-only from here on. A version this release does not know is refused,
 * never guessed at.
 *
 * Borrowed: LangGraph's checkpoint `v` field; io-ts's decode-at-the-boundary
 * (one decoder turns `unknown` into the type, or refuses with a path).
 */

import type { FlowchartCheckpoint, PendingPause } from './types.js';
import { isPausedExecution } from './types.js';

/** The checkpoint format this release writes (`FlowchartCheckpoint.checkpointVersion`). */
export const CHECKPOINT_VERSION = 1 as const;

/**
 * Fields only a checkpoint written BEFORE 9.39.0 can carry. The upcaster
 * reads them and the current shape never has them.
 */
export interface LegacyCheckpointFields {
  /** The invoker's `.next` id — a record since 9.28.0, never read; dropped by the upcaster. */
  readonly continuationStageId?: string;
}

/** The one message shape: `Invalid checkpoint: <where> <what>.` */
function refuse(what: string): never {
  throw new Error(`Invalid checkpoint: ${what}.`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bring a stored checkpoint of ANY release to the current shape — the one
 * upcaster. Version 0 (no `checkpointVersion`): drop the legacy
 * `continuationStageId`, stamp the version. Version 1: as is. Anything else:
 * refused. Returns a new object; the caller's is never edited.
 */
export function upcastCheckpoint(stored: Record<string, unknown>): Record<string, unknown> {
  const version = stored.checkpointVersion;
  if (version === CHECKPOINT_VERSION) return { ...stored };
  if (version !== undefined) {
    refuse(
      `checkpointVersion ${JSON.stringify(version) ?? String(version)} is not one this release reads ` +
        `(${CHECKPOINT_VERSION}, or none for a checkpoint written before 9.39.0)`,
    );
  }
  const { continuationStageId: _legacy, ...current } = stored as Record<string, unknown> & LegacyCheckpointFields;
  return { checkpointVersion: CHECKPOINT_VERSION, ...current };
}

/**
 * Check ONE pause record — the paused stage's own fields on the checkpoint,
 * or a waiting sibling's `pendingPauses[n]` — and return it as a
 * {@link PendingPause}. `at` names where the record sits (`''` for the
 * checkpoint itself, `'pendingPauses[0]'` for a sibling), so both sites speak
 * the same sentences.
 */
export function decodePauseRecord(raw: unknown, at = ''): PendingPause {
  const field = (name: string) => (at ? `${at}.${name}` : name);
  if (!isPlainRecord(raw)) refuse(`${at || 'the checkpoint'} must be an object`);
  if (typeof raw.pausedStageId !== 'string' || raw.pausedStageId === '') {
    refuse(`${field('pausedStageId')} must be a non-empty string`);
  }
  const subflowPath = raw.subflowPath;
  if (!Array.isArray(subflowPath) || !subflowPath.every((s) => typeof s === 'string')) {
    refuse(`${field('subflowPath')} must be an array of strings`);
  }
  const states = raw.subflowStates;
  if (states !== undefined && !isPlainRecord(states)) refuse(`${field('subflowStates')} must be an object`);
  if (raw.pausedBy !== undefined && raw.pausedBy !== 'interrupt') {
    refuse(`${field('pausedBy')} must be 'interrupt' when present`);
  }
  return {
    pausedStageId: raw.pausedStageId as string,
    subflowPath: subflowPath as string[],
    subflowStates: (states as Record<string, Record<string, unknown>> | undefined) ?? {},
    ...(raw.pauseData !== undefined && { pauseData: raw.pauseData }),
    ...(raw.pausedBy === 'interrupt' && { pausedBy: 'interrupt' as const }),
    // A record, never a plan input: kept only when well-formed (an older or
    // hand-edited entry simply resumes without a link).
    ...(isPausedExecution(raw.pausedExecution) && {
      pausedExecution: { runId: raw.pausedExecution.runId, runtimeStageId: raw.pausedExecution.runtimeStageId },
    }),
  };
}

/**
 * THE checkpoint decoder: upcast, then check — the checkpoint is an object,
 * its `sharedState` a plain object, its own pause record well-formed, and
 * every `pendingPauses` entry well-formed (each returned decoded). Throws
 * `Invalid checkpoint: …` naming the first field that is not; never edits
 * the caller's object.
 */
export function decodeCheckpoint(stored: unknown): FlowchartCheckpoint {
  if (!isPlainRecord(stored)) refuse('the checkpoint must be an object');
  const checkpoint = upcastCheckpoint(stored);
  if (!isPlainRecord(checkpoint.sharedState)) refuse('sharedState must be a plain object');
  decodePauseRecord(checkpoint);
  const pending = checkpoint.pendingPauses;
  if (pending !== undefined) {
    if (!Array.isArray(pending)) refuse('pendingPauses must be an array');
    checkpoint.pendingPauses = pending.map((raw: unknown, n) => decodePauseRecord(raw, `pendingPauses[${n}]`));
  }
  return checkpoint as unknown as FlowchartCheckpoint;
}
