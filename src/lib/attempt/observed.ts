/**
 * attempt/observed.ts — an attempt the library did NOT run: an outside system's own retry (an SDK's), reported by an
 * adapter through `AttemptContext.observed` (design §3.6, packet P2). Same record shape, kind `'observed'`.
 *
 * WHY: the incident behind this design was four 40 s attempts inside an SDK that the record called "one stage, one
 * error". The best fix is one loop — the SDK's retries off, the call under `scope.$call`. Where an SDK must keep its
 * retries, its adapter reports each one here, so the record says what happened rather than nothing.
 *
 * THREE LAWS.
 *   - A report is read, never trusted. Only the named fields are read, each ONCE (a getter cannot answer twice);
 *     a name is held to the one name rule (`name.ts`); numbers must be what they say. Anything else on the
 *     object — a request body, headers — is never read, so it can never reach a record ({@link readObservedReport}).
 *   - The error is served under the run's redaction rule (the owner's `serve`), like every attempt's error; the
 *     record keeps its named fields, and no hook is handed the adapter's error object (`raw` is dropped: the
 *     library never threw it, and an SDK error can carry its request).
 *   - An observed attempt never changes control flow. Its `decision` is the ONE rule table read over what the
 *     report states, under the default policy (every error retryable, no deadline) — the library's reading of the
 *     SDK's attempt, never the SDK's own decision, which the record cannot know. A report without `of` stands for
 *     the SDK's whole call: it is its last attempt, so a failure reads `exhausted`.
 *
 * SERIES. Reports are grouped by {@link ObservedSeriesBook}, owned by whoever owns the attempt they were reported
 * on: a growing attempt number continues its target's series; a number that does not grow opens a new one (the
 * SDK started another call).
 */

import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { errorCategory } from './category.js';
import { decideAttempt, retryRules } from './decision.js';
import { admitAttemptName } from './name.js';
import { freezeDeep, recordedError } from './record.js';
import type { AttemptCategory, AttemptOutcome, AttemptRecord } from './types.js';

/** The outcomes a report may state — an SDK cannot pause a flowchart. */
const OUTCOMES: ReadonlySet<string> = new Set<AttemptOutcome>(['ok', 'failed', 'timeout', 'aborted']);

const WHERE = 'observed()';

/** A report as read: every field once, validated, defaults applied. */
export interface ObservedReport {
  readonly target: string;
  readonly source: string;
  readonly attempt: number;
  readonly of?: number;
  readonly outcome: Exclude<AttemptOutcome, 'paused'>;
  readonly durationMs: number;
  readonly startedAt?: number;
  readonly error?: unknown;
}

/**
 * Read an adapter's report: the named fields only, each once. A malformed report is refused with a `TypeError`
 * naming the field (never its value).
 */
export function readObservedReport(report: unknown): ObservedReport {
  if (report === null || typeof report !== 'object') throw new TypeError(`${WHERE}: the report must be an object`);
  const field = (name: string): unknown => {
    try {
      return (report as Record<string, unknown>)[name];
    } catch (cause) {
      throw new TypeError(`${WHERE}: the report's ${name} could not be read`, { cause });
    }
  };
  const target = admitAttemptName(WHERE, 'target', field('target'));
  const rawSource = field('source');
  const source = rawSource === undefined ? 'sdk' : admitAttemptName(WHERE, 'source', rawSource);
  const rawAttempt = field('attempt');
  const attempt = rawAttempt === undefined ? 1 : count('attempt', rawAttempt);
  const rawOf = field('of');
  const of = rawOf === undefined ? undefined : count('of', rawOf);
  if (of !== undefined && of < attempt) throw new TypeError(`${WHERE}: of must be at least attempt`);
  const outcome = field('outcome');
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    throw new TypeError(`${WHERE}: outcome must be one of 'ok', 'failed', 'timeout', 'aborted'`);
  }
  const durationMs = field('durationMs');
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new TypeError(`${WHERE}: durationMs must be a finite number >= 0`);
  }
  const startedAt = field('startedAt');
  if (startedAt !== undefined && (typeof startedAt !== 'number' || !Number.isFinite(startedAt))) {
    throw new TypeError(`${WHERE}: startedAt must be a finite number (epoch ms)`);
  }
  const error = field('error');
  return {
    target,
    source,
    attempt,
    ...(of !== undefined && { of }),
    outcome: outcome as ObservedReport['outcome'],
    durationMs,
    ...(startedAt !== undefined && { startedAt: startedAt as number }),
    ...(error !== undefined && { error }),
  };
}

function count(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${WHERE}: ${name} must be a whole number >= 1`);
  }
  return value;
}

/** What turns a report into a record — the owner's series, clock and served-error rule. */
export interface ObservedRecordInit {
  readonly series: string;
  readonly now: () => number;
  readonly serve: (error: unknown) => StructuredErrorInfo;
}

/** The frozen record of a report, and the served error (with `raw`) the `onAttempt` hook carries. */
export function observedRecord(
  report: ObservedReport,
  init: ObservedRecordInit,
): { record: AttemptRecord; structuredError?: StructuredErrorInfo } {
  const failed = report.outcome !== 'ok';
  const category: AttemptCategory | undefined = failed ? errorCategory(report.error, report.outcome) : undefined;
  const served = failed && report.error !== undefined ? withoutRaw(init.serve(report.error)) : undefined;
  const decision = decideAttempt(retryRules({ attempts: report.of ?? report.attempt }), (key) =>
    readInput(report, category, key),
  );
  const record = freezeDeep<AttemptRecord>({
    series: init.series,
    kind: 'observed',
    target: report.target,
    source: report.source,
    attempt: report.attempt,
    ...(report.of !== undefined && { of: report.of }),
    startedAt: report.startedAt ?? init.now() - report.durationMs,
    durationMs: report.durationMs,
    outcome: report.outcome,
    ...(category !== undefined && { category }),
    decision: decision.evidence,
    next: decision.next,
    reason: decision.reason,
    ...(served !== undefined && { error: recordedError(served) }),
  });
  return { record, ...(served !== undefined && { structuredError: served }) };
}

/**
 * The served error without `raw`: the library never threw an adapter's error, and an SDK error can carry its
 * request (headers, body) — so no hook is handed the value itself, only its served, named fields.
 */
function withoutRaw(served: StructuredErrorInfo): StructuredErrorInfo {
  return { ...served, raw: undefined };
}

/** The rule table's inputs as the report states them, under the default policy (no deadline, every error retryable). */
function readInput(report: ObservedReport, category: AttemptCategory | undefined, key: string): unknown {
  switch (key) {
    case 'outcome':
      return report.outcome;
    case 'category':
      return category;
    case 'aborted':
      return report.outcome === 'aborted';
    case 'attempt':
      return report.attempt;
    case 'of':
      return report.of ?? report.attempt;
    case 'timeLeftMs':
    case 'timeLeftAfterWaitMs':
      return Infinity;
    case 'delayMs':
      return 0;
    case 'retryOn':
      return true;
    case 'keyPresent':
      return false;
    default:
      return undefined;
  }
}

/** How many distinct target/source pairs one attempt's book remembers — past it, each report opens its own series. */
export const MAX_OPEN_OBSERVED_SERIES = 256;

/**
 * Groups one attempt's observed reports into series. A report continues the open series of its target and source
 * while its attempt number grows; otherwise it opens a new one through `open` (the owner's next call-level series).
 * Bounded: it remembers at most {@link MAX_OPEN_OBSERVED_SERIES} names.
 */
export class ObservedSeriesBook {
  private readonly open = new Map<string, { series: string; last: number }>();

  constructor(private readonly openSeries: () => string) {}

  seriesFor(report: Pick<ObservedReport, 'target' | 'source' | 'attempt'>): string {
    // Names hold no control character, so NUL cannot occur in either: the key is unambiguous.
    const key = `${report.source}\u0000${report.target}`;
    const current = this.open.get(key);
    if (current !== undefined && report.attempt > current.last) {
      current.last = report.attempt;
      return current.series;
    }
    const series = this.openSeries();
    if (current !== undefined || this.open.size < MAX_OPEN_OBSERVED_SERIES) {
      this.open.set(key, { series, last: report.attempt });
    }
    return series;
  }
}
