/**
 * attempt/runner.ts — `runAttempts`, THE retry loop (design §3.1, law 1: one runner, one record).
 *
 * Runs a function under a policy and records every try: one frozen `AttemptRecord` per attempt, carrying its
 * timing, outcome, failure category and the retry-or-stop decision (`attempt/decision.ts`), and one
 * `AttemptSummary` when the series ends. The engine's stage retry (`FlowchartTraverser · executeStage`) runs on
 * it; later packets run in-stage calls and standalone `attempt()` on it too.
 *
 * The loop, per attempt n:
 *
 *   start → run(n) → outcome (ok | failed | aborted [the run's signal] | paused [a PauseSignal])
 *         → decide over the inputs, first match wins (`retryRules`)          → the record
 *         → onEnd(summary)                                                     only when the series ends here
 *         → onAttempt(record, served error)
 *         → done: return the value · stop: rethrow the attempt's OWN error
 *         → retry: between(n) → onRetry(n, of, delay, served error) → wait (cut short by the signal)
 *
 * WHAT IT PRESERVES (the 9.15 loop's behaviour, moved here unchanged): the function runs the same number of
 * times; `retryOn` is asked only for a failed, non-final attempt; `backoffMs` only when a retry follows; a
 * throwing predicate is "do not retry", a throwing or non-finite backoff is "no wait"; a pause is never retried;
 * the attempt's own error is rethrown, never a wrapper; the discard (`between`) precedes the retry event, which
 * precedes the wait. The one difference: when the run's signal has already aborted, the series stops without
 * asking `retryOn` (the abort decides first — rule 3 before rule 5).
 *
 * WHAT IT ADDS: the record and the summary. A record is frozen to its leaves and holds only clone-safe data —
 * the error as the run SERVES it (`serve`, the redaction rule's form) without `raw`. The hook gets the served
 * `StructuredErrorInfo` whole, `raw` included, as `onStageRetry` always has.
 *
 * ONE async frame with ONE await per attempt: the engine relies on that to keep a retried stage's microtask
 * shape, so parallel siblings settle in the order they always did.
 */

import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import { isPauseSignal } from '../pause/types.js';
import { errorCategory } from './category.js';
import type { AttemptDecision } from './decision.js';
import { decideAttempt, retryRules } from './decision.js';
import type {
  AttemptCategory,
  AttemptError,
  AttemptKind,
  AttemptNext,
  AttemptOutcome,
  AttemptReason,
  AttemptRecord,
  AttemptSummary,
  RetryPolicy,
} from './types.js';

/** What a series reports, and the engine's between-attempt step. Every member is optional. */
export interface AttemptRunOptions {
  /** The series every record names — for a stage attempt, its execution's `runtimeStageId`. */
  readonly series: string;
  /** Default `'stage'`. */
  readonly kind?: AttemptKind;
  /** The run's signal: an attempt that fails after it aborted is `'aborted'`; it cuts a wait short. */
  readonly signal?: AbortSignal;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** The served form of a failed attempt's error. Default `extractErrorInfo` (no redaction rule). */
  readonly serve?: (error: unknown) => StructuredErrorInfo;
  /** Between a failed attempt and the next: the engine discards the attempt's staged writes here. */
  readonly between?: (attempt: number) => void;
  /** Every attempt, at its end, with its served error (`undefined` for `'ok'` and `'paused'`). */
  readonly onAttempt?: (record: AttemptRecord, structuredError: StructuredErrorInfo | undefined) => void;
  /** A failed attempt that WILL be retried — after `between`, before the wait. */
  readonly onRetry?: (attempt: number, of: number, delayMs: number, structuredError: StructuredErrorInfo) => void;
  /** The series ended: called once, before the last `onAttempt` (or after a wait the run's signal cut). */
  readonly onEnd?: (summary: AttemptSummary) => void;
  /** `retryOn` threw — the attempt is treated as declined; the engine logs the throw here. */
  readonly onRetryOnThrew?: (thrown: unknown) => void;
}

/** A failed attempt's thrown value, boxed: `undefined` is a value a stage may throw. */
interface Failure {
  readonly error: unknown;
}

/** One decision step: the outcome it decided on, the category, the evidence, and the wait it computed. */
interface Step {
  readonly outcome: AttemptOutcome;
  readonly category: AttemptCategory | undefined;
  readonly decision: AttemptDecision;
  readonly delayMs: number | undefined;
}

/**
 * Run `run` until it succeeds or the policy stops it; resolve with its value or reject with the LAST attempt's
 * own error. `run(n)` is called with the attempt number, 1-based.
 */
export async function runAttempts<T>(
  run: (attempt: number) => Promise<T> | T,
  policy: RetryPolicy,
  options: AttemptRunOptions,
): Promise<T> {
  const of = ceilingOf(policy.attempts);
  const rules = retryRules({ attempts: of });
  const now = options.now ?? Date.now;
  const tally = new SeriesTally();

  /** One decision over an attempt's inputs, each read only when a rule reaches it. */
  const decide = (attempt: number, failure: Failure | undefined, ended: AttemptOutcome): Step => {
    const category: AttemptCategory | undefined =
      failure && ended !== 'paused' ? errorCategory(failure.error, ended) : undefined;
    let retryOn: boolean | undefined;
    let delayMs: number | undefined;
    const delay = () => (delayMs ??= resolveBackoffMs(policy.backoffMs, attempt));
    const decision = decideAttempt(rules, (key) => {
      switch (key) {
        case 'outcome':
          return ended;
        case 'category':
          return category;
        case 'attempt':
          return attempt;
        case 'of':
          return of;
        case 'timeLeftMs':
          return Infinity;
        case 'delayMs':
          return delay();
        case 'timeLeftAfterWaitMs':
          return Infinity - delay();
        case 'retryOn':
          return (retryOn ??= askRetryOn(policy, failure?.error, options.onRetryOnThrew));
        case 'keyPresent':
          return false;
        default:
          return undefined;
      }
    });
    return { outcome: ended, category, decision, delayMs };
  };

  for (let attempt = 1; ; attempt++) {
    const startedAt = now();
    let value: T | undefined;
    let failure: Failure | undefined;
    try {
      value = await run(attempt);
    } catch (error: unknown) {
      failure = { error };
    }
    const durationMs = Math.max(0, now() - startedAt);
    const outcome = outcomeOf(failure, options.signal);
    const served = failure && outcome !== 'paused' ? (options.serve ?? extractErrorInfo)(failure.error) : undefined;

    let step = decide(attempt, failure, outcome);
    // The run's signal can abort WHILE deciding (inside retryOn or backoffMs). The 9.15 loop checked it after
    // the predicate and stopped before the discard; re-deciding as aborted keeps that, and keeps the record
    // true: rule 3 matches before any user function is asked again.
    if (step.decision.next === 'retry' && options.signal?.aborted) step = decide(attempt, failure, 'aborted');

    const record = freezeDeep<AttemptRecord>({
      series: options.series,
      kind: options.kind ?? 'stage',
      attempt,
      of,
      startedAt,
      durationMs,
      outcome: step.outcome,
      ...(step.category !== undefined && { category: step.category }),
      decision: step.decision.evidence,
      next: step.decision.next,
      reason: step.decision.reason,
      ...(step.delayMs !== undefined && { delayMs: step.delayMs }),
      ...(served !== undefined && { error: recordedError(served) }),
    });
    tally.add(record);
    if (record.next !== 'retry') options.onEnd?.(tally.summary(record.next, record.reason, record.category));
    options.onAttempt?.(record, served);

    if (record.next === 'done') return value as T;
    if (record.next === 'stop') throw failure?.error;

    options.between?.(attempt);
    const delayMs = record.delayMs ?? 0;
    options.onRetry?.(attempt, of, delayMs, served as StructuredErrorInfo);
    if (delayMs > 0) await sleep(delayMs, options.signal);
    if (options.signal?.aborted) {
      // No attempt follows, so none is recorded: the summary says how the series ended.
      options.onEnd?.(tally.summary('stop', 'aborted', record.category));
      throw failure?.error;
    }
  }
}

/** The attempts a policy allows: its whole number, and never fewer than one — a broken ceiling never loops. */
function ceilingOf(attempts: number): number {
  const whole = Math.floor(attempts);
  return Number.isFinite(whole) && whole >= 1 ? whole : 1;
}

function outcomeOf(failure: Failure | undefined, signal: AbortSignal | undefined): AttemptOutcome {
  if (!failure) return 'ok';
  if (isPauseSignal(failure.error)) return 'paused';
  return signal?.aborted ? 'aborted' : 'failed';
}

/** `retryOn` gate. A throwing predicate counts as "do not retry" — a broken predicate must never loop forever. */
function askRetryOn(policy: RetryPolicy, error: unknown, onThrew: ((thrown: unknown) => void) | undefined): boolean {
  if (!policy.retryOn) return true;
  try {
    return policy.retryOn(error) === true;
  } catch (thrown) {
    onThrew?.(thrown);
    return false;
  }
}

/**
 * Resolve a policy's `backoffMs` for the attempt that just failed (1-based). Anything that is not a finite,
 * positive number — a missing dial, a negative value, a `NaN` from a consumer's arithmetic, or a throwing
 * function — becomes `0`, i.e. retry immediately. A backoff dial must never be able to crash a run or park it
 * forever.
 */
export function resolveBackoffMs(backoffMs: RetryPolicy['backoffMs'], attempt: number): number {
  if (backoffMs === undefined) return 0;
  let value: unknown;
  if (typeof backoffMs === 'function') {
    try {
      value = backoffMs(attempt);
    } catch {
      return 0;
    }
  } else {
    value = backoffMs;
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Await `ms`, cut short by an abort. Resolves either way — the caller re-checks `signal.aborted` and rethrows
 * the attempt's own error, so a cancelled run never sits out a long backoff and never loses the failure that
 * caused it. The timer and the listener are always cleaned up.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The record's copy of a served error: its named fields only — never `raw`, never an extra own key. */
function recordedError(served: StructuredErrorInfo): AttemptError {
  return {
    message: served.message,
    ...(served.name !== undefined && { name: served.name }),
    ...(served.code !== undefined && { code: served.code }),
    ...(served.issues !== undefined && { issues: served.issues.map((issue) => ({ ...issue, path: [...issue.path] })) }),
  };
}

/** Per-outcome counts of a series, for its summary. */
class SeriesTally {
  private readonly counts = { count: 0, ok: 0, failed: 0, timeout: 0, aborted: 0, paused: 0 };

  add(record: AttemptRecord): void {
    this.counts.count += 1;
    this.counts[record.outcome] += 1;
  }

  summary(next: AttemptNext, reason: AttemptReason, category: AttemptCategory | undefined): AttemptSummary {
    return freezeDeep<AttemptSummary>({
      ...this.counts,
      last: { next: next as Exclude<AttemptNext, 'retry'>, reason, ...(category !== undefined && { category }) },
    });
  }
}

/** Freeze a record built of plain objects and arrays, to its leaves. */
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}
