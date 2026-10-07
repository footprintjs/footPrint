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
 * `checkpointVersion: 2`. Every older one is read by the ONE upcaster,
 * {@link upcastCheckpoint}, and every step so far only DROPS fields — what a
 * later format added is optional and read as absent:
 *
 *   - version 0 (no `checkpointVersion`, before 9.39.0) → 1: drop
 *     `continuationStageId`, a record no resume has read since 9.28.0 (what
 *     runs after a resume comes from the chart);
 *   - version 1 (9.39.0–9.43.x) → 2 (the LEAN checkpoint): drop
 *     `executionTree` and `subflowResults` — the run's served record (the
 *     whole execution tree, the finished subflows' results), which no resume
 *     ever read and which grew with every finished iteration
 *     (`runner/checkpoint.ts`).
 *
 * A dropped field never survives, whatever version claims to carry it. A
 * version this release does not know is refused, never guessed at.
 *
 * Borrowed: LangGraph's checkpoint `v` field; io-ts's decode-at-the-boundary
 * (one decoder turns `unknown` into the type, or refuses with a path).
 */

import type { FlowchartCheckpoint, PendingPause } from './types.js';
import { isPausedExecution } from './types.js';

/** The checkpoint format this release writes (`FlowchartCheckpoint.checkpointVersion`). */
export const CHECKPOINT_VERSION = 2 as const;

/** The formats this release reads: the current one and every one it upcasts (absent = version 0). */
const READABLE_VERSIONS: readonly unknown[] = [1, CHECKPOINT_VERSION];

/**
 * Fields only an OLDER checkpoint can carry, each dropped by the format named
 * beside it. The upcaster removes them and the current shape never has them.
 */
export interface LegacyCheckpointFields {
  /** Version 0 only: the invoker's `.next` id — a record since 9.28.0, never read. Dropped by version 1. */
  readonly continuationStageId?: string;
  /** Versions 0–1: the run's execution tree at the pause — never read by a resume. Dropped by version 2. */
  readonly executionTree?: unknown;
  /** Versions 0–1: the subflows finished before the pause — never read by a resume. Dropped by version 2. */
  readonly subflowResults?: Record<string, unknown>;
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
 * upcaster. Versions 0 (no `checkpointVersion`) and 1: drop the fields their
 * successors dropped ({@link LegacyCheckpointFields}), stamp the current
 * version as the first key. The current version: as is, minus any dropped
 * field it claims to carry. Anything else: refused. Returns a new object; the
 * caller's is never edited.
 */
export function upcastCheckpoint(stored: Record<string, unknown>): Record<string, unknown> {
  const version = stored.checkpointVersion;
  if (version !== undefined && !READABLE_VERSIONS.includes(version)) {
    refuse(
      `checkpointVersion ${JSON.stringify(version) ?? String(version)} is not one this release reads ` +
        `(${READABLE_VERSIONS.join(' or ')}, or none for a checkpoint written before 9.39.0)`,
    );
  }
  // A dropped field never survives, whatever version claims to carry it.
  const {
    checkpointVersion: _version,
    continuationStageId: _invokerNext,
    executionTree: _tree,
    subflowResults: _finishedSubflows,
    ...current
  } = stored as Record<string, unknown> & LegacyCheckpointFields;
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
  // Each capture seeds a subflow's runtime — a plain object, like `sharedState`.
  for (const [subflowId, capture] of Object.entries(states ?? {})) {
    if (!isPlainRecord(capture)) refuse(`${field('subflowStates')}[${JSON.stringify(subflowId)}] must be an object`);
  }
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
  // A record, never a plan input — the SAME rule as a sibling's: a malformed
  // link is dropped (the resume runs without it), never trusted.
  if (checkpoint.pausedExecution !== undefined && !isPausedExecution(checkpoint.pausedExecution)) {
    delete checkpoint.pausedExecution;
  }
  // The counters seed the resumed run's ids and loop budget: absent is an old
  // checkpoint (the counter restarts), present must be well-formed.
  if (checkpoint.executionCount !== undefined && !isCount(checkpoint.executionCount)) {
    refuse('executionCount must be a non-negative integer');
  }
  const visits = checkpoint.visitCounts;
  if (visits !== undefined && (!isPlainRecord(visits) || !Object.values(visits).every(isCount))) {
    refuse('visitCounts must map stage ids to non-negative integers');
  }
  if (checkpoint.pendingPauses !== undefined) checkpoint.pendingPauses = decodePendingPauses(checkpoint.pendingPauses);
  // The redaction a pause carries (names only) seeds the resumed run's rule — a malformed one
  // is refused, never dropped: dropping it would serve in plain what the run had masked.
  if (checkpoint.redactionMarks !== undefined) decodeRedactionMarks(checkpoint.redactionMarks);
  return checkpoint as unknown as FlowchartCheckpoint;
}

/** `redactionMarks`: `keys` an array of strings; `fields`, when present, keys → arrays of strings. */
function decodeRedactionMarks(marks: unknown): void {
  if (!isPlainRecord(marks)) refuse('redactionMarks must be an object');
  if (!isStrings(marks.keys)) refuse('redactionMarks.keys must be an array of strings');
  const fields = marks.fields;
  if (fields !== undefined && (!isPlainRecord(fields) || !Object.values(fields).every(isStrings))) {
    refuse('redactionMarks.fields must map keys to arrays of strings');
  }
}

function isStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * `pendingPauses` (stored, untrusted) as decoded records — the one check
 * `decodeCheckpoint` runs, and the one `ResumeEntry.plan` runs on what it is
 * handed directly, so neither door takes an unchecked sibling.
 */
export function decodePendingPauses(pending: unknown): PendingPause[] {
  if (!Array.isArray(pending)) refuse('pendingPauses must be an array');
  return pending.map((raw: unknown, n) => decodePauseRecord(raw, `pendingPauses[${n}]`));
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
