/**
 * attempt/runner.ts — `runAttempts`, THE retry loop (design §3.1, law 1: one runner, one record).
 *
 * Runs a function under a policy and records every try: one frozen `AttemptRecord` per attempt, carrying its
 * timing, outcome, failure category and the retry-or-stop decision (`attempt/decision.ts`), and one
 * `AttemptSummary` when the series ends. The engine's stage retry (`FlowchartTraverser · executeStage`) runs on
 * it; later packets run in-stage calls and standalone `attempt()` on it too.
 *
 * The loop, per attempt n — for a failed attempt, the 9.15 loop's order, step for step:
 *
 *   start → run(n) → outcome (ok | failed | aborted [it threw the run's abort reason] | paused [a PauseSignal])
 *         → decide over the inputs, first match wins (`retryRules`) — retryOn is asked here (rule 5)
 *         → the run's signal aborted inside retryOn? decide again: rule 3 stops the series here, before the
 *           discard and before backoffMs, as the 9.15 abort check did
 *         → retry: between(n) — the discard — and THEN backoffMs(n), the wait's length
 *         → the error's served form and category, read after retryOn and backoffMs ran → the record
 *         → onEnd(summary)                                               only when the series ends here
 *         → onAttempt(record, served error)
 *         → done: return the value · stop: rethrow the attempt's OWN error
 *         → retry: onRetry(n, of, delay, served error) → wait (cut short by the signal) → aborted? stop
 *
 * WHAT IT PRESERVES (the 9.15 loop's behaviour, moved here unchanged): the function runs the same number of
 * times; `retryOn` is asked only for a failed, non-final attempt; `backoffMs` only when a retry follows, after
 * the discard; a throwing predicate is "do not retry", a throwing or non-finite backoff is "no wait"; a pause is
 * never retried; the attempt's own error is rethrown, never a wrapper; and a failed attempt's order —
 * `retryOn` → the abort check → the discard (`between`) → `backoffMs` → the served error → the retry event →
 * the wait → the abort check. So an abort inside `retryOn` stops before the discard and never asks `backoffMs`;
 * an abort inside `backoffMs` comes after the discard, still fires the retry event, then ends at the wait; and
 * the served error shows what `retryOn` did to the thrown value. The one difference: when the run's signal has
 * ALREADY aborted as the attempt fails, the series stops without asking `retryOn` (the abort decides first —
 * rule 3 before rule 5).
 *
 * WHAT IT ADDS: the record and the summary. A record is frozen to its leaves and holds only clone-safe data —
 * the error as the run SERVES it (`serve`, the redaction rule's form) without `raw`. The hook gets the served
 * `StructuredErrorInfo` whole, `raw` included, as `onStageRetry` always has. A record never rewrites what the
 * attempt did: an attempt that threw its own error is `failed`, with its category, even when the run aborted
 * around it — the abort is the series' stop reason (`reason: 'aborted'`); a throwing `retryOn` is `declined`
 * with `retryOnThrew: true`, apart from a real `false`.
 *
 * ONE async frame with ONE await per attempt: the engine relies on that to keep a retried stage's microtask
 * shape, so parallel siblings settle in the order they always did.
 */

import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import { isPauseSignal } from '../pause/types.js';
import { errorCategory } from './category.js';
import { decideAttempt, retryRules } from './decision.js';
import { attemptCeiling } from './policy.js';
import type {
  AttemptCategory,
  AttemptError,
  AttemptKind,
  AttemptOutcome,
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
  /**
   * The run's signal. Once it has aborted, rule 3 stops the series (`reason: 'aborted'`); it cuts a wait short.
   * An attempt that threw its reason is recorded `'aborted'`.
   */
  readonly signal?: AbortSignal;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** The served form of a failed attempt's error. Default `extractErrorInfo` (no redaction rule). */
  readonly serve?: (error: unknown) => StructuredErrorInfo;
  /** Between a failed attempt and the next, before `backoffMs`: the engine discards the attempt's staged writes. */
  readonly between?: (attempt: number) => void;
  /** Every attempt, at its end, with its served error (`undefined` for `'ok'` and `'paused'`). */
  readonly onAttempt?: (record: AttemptRecord, structuredError: StructuredErrorInfo | undefined) => void;
  /** A failed attempt that WILL be retried — after `between` and `onAttempt`, before the wait. */
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

/**
 * Run `run` until it succeeds or the policy stops it; resolve with its value or reject with the LAST attempt's
 * own error. `run(n)` is called with the attempt number, 1-based.
 */
export async function runAttempts<T>(
  run: (attempt: number) => Promise<T> | T,
  policy: RetryPolicy,
  options: AttemptRunOptions,
): Promise<T> {
  const of = attemptCeiling(policy.attempts);
  const rules = retryRules({ attempts: of });
  const now = options.now ?? Date.now;
  const tally = new SeriesTally();

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
    const inputs = new AttemptInputReader(policy, options, attempt, of, outcomeOf(failure, options.signal), failure);

    let decision = decideAttempt(rules, inputs.read);
    // 9.15 asked retryOn, THEN checked the signal. Deciding again reads the signal afresh: rule 3 now matches,
    // ahead of every user function, so none is asked twice — and nothing is discarded, nothing waited for.
    if (decision.next === 'retry' && options.signal?.aborted) decision = decideAttempt(rules, inputs.read);

    // The discard comes BEFORE the wait's length is asked for, as it did in 9.15.
    if (decision.next === 'retry') options.between?.(attempt);
    const delayMs = decision.next === 'retry' ? inputs.delayMs() : undefined;

    const category = inputs.category();
    const served = inputs.failed ? (options.serve ?? extractErrorInfo)(inputs.failed.error) : undefined;
    const record = freezeDeep<AttemptRecord>({
      series: options.series,
      kind: options.kind ?? 'stage',
      attempt,
      of,
      startedAt,
      durationMs,
      outcome: inputs.outcome,
      ...(category !== undefined && { category }),
      decision: decision.evidence,
      next: decision.next,
      reason: decision.reason,
      ...(inputs.retryOnThrew && { retryOnThrew: true as const }),
      ...(delayMs !== undefined && { delayMs }),
      ...(served !== undefined && { error: recordedError(served) }),
    });
    tally.add(record);
    if (record.next !== 'retry') options.onEnd?.(tally.summary(lastOf(record)));
    options.onAttempt?.(record, served);

    if (record.next === 'done') return value as T;
    if (record.next === 'stop') throw failure?.error;

    options.onRetry?.(attempt, of, delayMs ?? 0, served as StructuredErrorInfo);
    if (delayMs !== undefined && delayMs > 0) await sleep(delayMs, options.signal);
    if (options.signal?.aborted) {
      // No attempt follows, so none is recorded: the summary says how the series ended.
      options.onEnd?.(tally.summary({ ...lastOf(record), next: 'stop', reason: 'aborted' }));
      throw failure?.error;
    }
  }
}

/**
 * How the attempt itself ended. A thrown value is the attempt's own failure unless it IS the run's abort reason
 * (StageRunner's race rejects with it; a stage may rethrow it) — only then did the run's signal end it.
 */
function outcomeOf(failure: Failure | undefined, signal: AbortSignal | undefined): AttemptOutcome {
  if (!failure) return 'ok';
  if (isPauseSignal(failure.error)) return 'paused';
  return signal?.aborted === true && failure.error === signal.reason ? 'aborted' : 'failed';
}

/**
 * One attempt's decision inputs, each read only when a rule reaches it (`decideAttempt`'s reader): the user's
 * `retryOn` and `backoffMs` run at most once each, and only when the 9.15 loop would have run them.
 */
class AttemptInputReader {
  /** The failure a category and a served error are read from — none for `'ok'` and `'paused'`. */
  readonly failed: Failure | undefined;
  /** `true` once `retryOn` threw (its verdict is then `false`). */
  retryOnThrew = false;
  private retryOnVerdict: boolean | undefined;
  private wait: number | undefined;
  private failureCategory: AttemptCategory | undefined;
  private categoryRead = false;

  constructor(
    private readonly policy: RetryPolicy,
    private readonly options: AttemptRunOptions,
    private readonly attempt: number,
    private readonly of: number,
    readonly outcome: AttemptOutcome,
    failure: Failure | undefined,
  ) {
    this.failed = failure && outcome !== 'paused' ? failure : undefined;
  }

  /** One input by its `AttemptInputs` key. */
  readonly read = (key: string): unknown => {
    switch (key) {
      case 'outcome':
        return this.outcome;
      case 'category':
        return this.category();
      case 'aborted':
        // Live: a decision taken again after `retryOn` sees an abort raised inside it.
        return this.options.signal?.aborted === true;
      case 'attempt':
        return this.attempt;
      case 'of':
        return this.of;
      case 'timeLeftMs':
      case 'timeLeftAfterWaitMs':
        // No deadline yet (the deadline packet brings one): the time left is unbounded, before any wait and
        // after it — so deciding needs no wait, and `backoffMs` is asked after the discard, as in 9.15.
        return Infinity;
      case 'delayMs':
        return this.delayMs();
      case 'retryOn':
        return this.retryOn();
      case 'keyPresent':
        return false;
      default:
        return undefined;
    }
  };

  /** The failure's category, read once — at the first rule that asks, or after the decision. */
  category(): AttemptCategory | undefined {
    if (!this.categoryRead) {
      this.categoryRead = true;
      this.failureCategory = this.failed ? errorCategory(this.failed.error, this.outcome) : undefined;
    }
    return this.failureCategory;
  }

  /** The policy's wait after this attempt (`resolveBackoffMs`), asked once. */
  delayMs(): number {
    return (this.wait ??= resolveBackoffMs(this.policy.backoffMs, this.attempt));
  }

  /** The `retryOn` gate, asked once. A throwing predicate is "do not retry" — a broken one never loops. */
  private retryOn(): boolean {
    if (this.retryOnVerdict === undefined) this.retryOnVerdict = this.askRetryOn();
    return this.retryOnVerdict;
  }

  private askRetryOn(): boolean {
    if (!this.policy.retryOn) return true;
    try {
      return this.policy.retryOn(this.failed?.error) === true;
    } catch (thrown) {
      this.retryOnThrew = true;
      this.options.onRetryOnThrew?.(thrown);
      return false;
    }
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

/** How a record ended its series, as the summary's `last` says it. */
function lastOf(record: AttemptRecord): AttemptSummary['last'] {
  return {
    next: record.next as AttemptSummary['last']['next'],
    reason: record.reason,
    ...(record.category !== undefined && { category: record.category }),
    ...(record.retryOnThrew && { retryOnThrew: true as const }),
  };
}

/** Per-outcome counts of a series, for its summary. */
class SeriesTally {
  private readonly counts = { count: 0, ok: 0, failed: 0, timeout: 0, aborted: 0, paused: 0 };

  add(record: AttemptRecord): void {
    this.counts.count += 1;
    this.counts[record.outcome] += 1;
  }

  summary(last: AttemptSummary['last']): AttemptSummary {
    return freezeDeep<AttemptSummary>({ ...this.counts, last });
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
