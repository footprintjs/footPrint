/**
 * recorder/attemptSeries.ts — what a RECORDER keeps of a series: the one evidence predicate, the stop that gave up, and a
 * per-series tally rebuilt from `onAttempt` records (design §5.1, P1c).
 *
 * WHY one module: seven built-in recorders account for attempts, and each must agree on two questions — "is this
 * series worth a row?" and "did it give up?" — or a Topology node and a boundary count would disagree about the
 * same run. Asked here, once.
 *
 * THE predicate (`isRetryEvidence`): a series is evidence when it RETRIED (some attempt was followed by another) or
 * GAVE UP (it stopped `exhausted`, `declined` or `no-time-left`, §3.9). A policy stage that succeeded first time —
 * or that paused or was aborted on its first attempt — is indistinguishable from a stage with no policy in every
 * recorder row, so a chart in which nothing retried keeps those rows byte-identical (law 2).
 *
 * Records arrive in order within a series, so the predicate is decided at the series' FIRST record: attempt 1 is
 * evidence iff it did not end the series quietly, and every later attempt is evidence by being one.
 *
 * L5 (`recorder/**`), beside the stores: it imports the attempt vocabulary's types only (the L0 leaf), so
 * `recorder/` never takes a runtime edge into `attempt/` — whose runner reaches `decide/` and `scope/`, which
 * import `recorder/` (a module cycle).
 */

import { joinPath, subflowSegmentsOf } from 'foottrace';

import type { AttemptOutcome, AttemptReason, AttemptRecord, AttemptSummary } from '../attempt/types.js';

/**
 * One attempt, named — `series` (the stage execution's `runtimeStageId`) plus the 1-based `attempt`. The
 * identity `AttemptRecord` carries until the engine stamps foottrace's attempt id (design §3.4).
 */
export interface AttemptRef {
  readonly series: string;
  readonly attempt: number;
}

/** Attempt counts per outcome — the shape `AttemptSummary` uses, without the series' end. */
export type AttemptOutcomeCounts = Readonly<Record<AttemptOutcome, number>>;

/** The stop reasons that mean "gave up" — apart from `aborted` (the run ended it) and `paused` (§3.9). */
const GAVE_UP: ReadonlySet<AttemptReason> = new Set<AttemptReason>(['exhausted', 'declined', 'no-time-left']);

/** The series stopped on this record because retrying was given up (exhausted, declined or no time left). */
export function gaveUp(record: AttemptRecord): boolean {
  return record.next === 'stop' && GAVE_UP.has(record.reason);
}

/** The record belongs to a series that retried or gave up — the one row predicate every recorder shares. */
export function isRetryEvidence(record: AttemptRecord): boolean {
  return record.attempt > 1 || record.next === 'retry' || gaveUp(record);
}

/** Did the attempt itself fail — a failure, a timeout or the run's abort (not a success, not a pause)? */
export function attemptFailed(record: AttemptRecord): boolean {
  return record.outcome === 'failed' || record.outcome === 'timeout' || record.outcome === 'aborted';
}

/** The record's name. */
export function attemptRef(record: AttemptRecord): AttemptRef {
  return { series: record.series, attempt: record.attempt };
}

/**
 * The path-prefixed id of the subflow an attempt's stage ran in (`'sf-outer/sf-inner'`), or `undefined` at the top
 * level — read off the stage execution's `runtimeStageId` (the event's, else the series'), the one id that always
 * carries it.
 */
export function subflowOfAttempt(event: {
  readonly record: AttemptRecord;
  readonly traversalContext?: { readonly runtimeStageId: string };
}): string | undefined {
  const segments = subflowSegmentsOf(event.traversalContext?.runtimeStageId ?? event.record.series);
  return segments.length > 0 ? joinPath(...segments) : undefined;
}

/** A zeroed per-outcome count. */
export function emptyOutcomeCounts(): Record<AttemptOutcome, number> {
  return { ok: 0, failed: 0, timeout: 0, aborted: 0, paused: 0 };
}

/** What a recorder knows of one series so far. `summary` is present once the series ended. */
export interface AttemptSeriesState {
  readonly series: string;
  /** The series' attempts, in order. */
  readonly attempts: readonly AttemptRef[];
  /**
   * The series at a glance — the same value the runner stamps on `StageSnapshot.attemptSummary`, rebuilt from the
   * records. Absent while the last record says `retry`: the series is in flight, or the run's signal cut its wait
   * (no record follows; only the execution tree knows how it ended).
   */
  readonly summary?: AttemptSummary;
}

/**
 * Per-series tallies, keyed by `series`, for the series that are evidence. `add` returns the series' state after
 * the record, or `undefined` for a record that is not evidence (nothing to keep).
 */
export class AttemptSeriesBook {
  private readonly bySeries = new Map<string, { refs: AttemptRef[]; counts: Record<AttemptOutcome, number> }>();

  add(record: AttemptRecord): AttemptSeriesState | undefined {
    if (!isRetryEvidence(record)) return undefined;
    let entry = this.bySeries.get(record.series);
    if (!entry) {
      entry = { refs: [], counts: emptyOutcomeCounts() };
      this.bySeries.set(record.series, entry);
    }
    entry.refs.push(attemptRef(record));
    entry.counts[record.outcome] += 1;
    const attempts = [...entry.refs];
    if (record.next === 'retry') return { series: record.series, attempts };
    return { series: record.series, attempts, summary: summaryOf(entry.refs.length, entry.counts, record) };
  }

  clear(): void {
    this.bySeries.clear();
  }
}

function summaryOf(count: number, counts: Record<AttemptOutcome, number>, last: AttemptRecord): AttemptSummary {
  return {
    count,
    ...counts,
    last: {
      next: last.next as AttemptSummary['last']['next'],
      reason: last.reason,
      ...(last.category !== undefined && { category: last.category }),
      ...(last.retryOnThrew && { retryOnThrew: true as const }),
    },
  };
}
