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
 * TIME (P1b). Each attempt runs under `min(policy.timeoutMs, time left before options.deadline)` and gets an
 * `AttemptContext` — its signal, composed from the run's and its own cap's timer (`LiveAttempt`). The cap's timer
 * aborts with an `AttemptTimeoutError`; the run's deadline aborts the run's signal with a branded reason
 * (`attempt/deadline.ts`). Either way the attempt is `'timeout'`, never `'aborted'`: the deadline is not a
 * cancellation, so rule 3 does not match and rule 6 (`timeLeftAfterWaitMs ≤ 0`) stops a series whose next wait
 * would outlast it. Under a deadline rule 6 needs the wait's length, so `backoffMs(n, error)` is asked DURING the
 * decision — before the discard; without one the 9.15 order above holds unchanged. No attempt starts at or past
 * the deadline: a wait the deadline cut ends the series `no-time-left`, recording no further attempt.
 *
 * THE FENCE. The moment an attempt ends without an answer — its signal aborts (synchronously, before any listener
 * the function added) or it throws — `onAbandon(n)` fires once, and the engine closes that attempt's scope: the
 * function may still be running, and nothing it does afterwards may land beside a later attempt.
 *
 * ONE async frame with ONE await per attempt: the engine relies on that to keep a retried stage's microtask
 * shape, so parallel siblings settle in the order they always did. The engine races the attempt's signal itself,
 * at the stage boundary (`raced: true`); any other caller gets the race here, so the series never waits on an
 * attempt past its cap.
 *
 * CALLS (P2). The same loop runs a call a stage makes (`attempt/call.ts · runCall`, kind `'call'`, its `target` on
 * every record) and the standalone `attempt()`. An attempt's cap is the DEADLINE of every call made inside it, so
 * the cap's reason is branded a time limit (`attempt/deadline.ts · markTimeLimit`): a call cut by its stage
 * attempt's cap timed out, it was not cancelled. `attemptEndsAt` says when an attempt must end; an `interrupt()`
 * thrown inside a call is a pause, like a `PauseSignal` — never retried.
 */

import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import { isInterruptSignal } from '../pause/interrupt.js';
import { isPauseSignal } from '../pause/types.js';
import { anySignal } from './anySignal.js';
import { errorCategory } from './category.js';
import { isCancelled, isDeadlineReason, markTimeLimit, readDeadline, setLongTimeout } from './deadline.js';
import { decideAttempt, retryRules } from './decision.js';
import type { EffectTarget } from './effect.js';
import { effectOf, recordedKeyOf, refuseKeylessRetry, unknownEffectError } from './effect.js';
import { AttemptTimeoutError } from './errors.js';
import { attemptCeiling, attemptTimeoutMs, cappedWaitMs } from './policy.js';
import { freezeDeep, recordedError } from './record.js';
import type {
  AttemptCategory,
  AttemptContext,
  AttemptKind,
  AttemptOutcome,
  AttemptRecord,
  AttemptSummary,
  ObservedAttempt,
  RetryPolicy,
} from './types.js';

/** What a series reports, and the engine's between-attempt step. Every member is optional. */
export interface AttemptRunOptions {
  /** The series every record names — for a stage attempt, its execution's `runtimeStageId`. */
  readonly series: string;
  /** Default `'stage'`. */
  readonly kind?: AttemptKind;
  /** The outside target every record names — a call's (`$call`, `attempt()`); absent for a stage attempt. */
  readonly target?: string;
  /**
   * The run's signal. Once it has aborted (other than at the deadline), rule 3 stops the series
   * (`reason: 'aborted'`); it cuts a wait short. An attempt that threw its reason is recorded `'aborted'` — or
   * `'timeout'` when the reason is the deadline's (`attempt/deadline.ts`).
   */
  readonly signal?: AbortSignal;
  /**
   * The run's deadline, epoch milliseconds. Every attempt is capped by the time left; rule 6 stops a series whose
   * next wait would outlast it (`no-time-left`). Absent (or not finite) = no deadline: the time left is `Infinity`.
   */
  readonly deadline?: number;
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
  /** @internal Native owner only: the exact escaping value and category, before its stage serves the error. */
  readonly onFailure?: (error: unknown, category: AttemptCategory) => void;
  /** `retryOn` threw — the attempt is treated as declined; the engine logs the throw here. */
  readonly onRetryOnThrew?: (thrown: unknown) => void;
  /**
   * The attempt ended without an answer — called SYNCHRONOUSLY the moment its signal aborts (its cap, the deadline,
   * a cancellation), else as soon as it failed. Whatever the abandoned function does afterwards is not this
   * series': the engine fences its scope here. Once per attempt; never for `'ok'` or `'paused'` — except an attempt
   * that STARTED under an already-aborted signal, fenced once its synchronous part has run (nobody waits for it).
   */
  readonly onAbandon?: (attempt: number) => void;
  /**
   * The caller races `run`'s promise against the attempt's signal itself — the engine does, at the stage boundary
   * (`StageRunner`), so a stage keeps its one await per attempt. Otherwise the runner races it: the series never
   * waits on an attempt past its cap.
   */
  readonly raced?: boolean;
  /**
   * What an attempt's `observed(report)` does (P2) — the owner of the attempt records the report: `runCall` hands
   * a call's reports to the scope, `attempt()` keeps its own. `ended` says the attempt had already ended when the
   * report came (the owner drops it). Absent — a stage attempt's context, whose `observed` the scope's
   * `$attempt()` replaces — `observed` is refused with a `TypeError`.
   */
  readonly observe?: (report: ObservedAttempt, at: { readonly attempt: number; readonly ended: boolean }) => void;
  /**
   * The outside system the target touches (P3, design §3.3). Every record then says what its attempt did to it
   * (`effect`) and names the system and the RECORDED key; every attempt's context carries the REAL key. A series
   * that ends without an answer after any attempt of unknown effect fails with `UnknownEffectError` (its `cause` the attempt's own error) —
   * except a pause, which stays a pause. A touching series that may retry without a key is refused before anything
   * runs: the law's last door.
   */
  readonly effect?: EffectTarget;
}

/** When each live attempt must end, epoch ms — `startedAt + cap`, for an attempt that has a cap (`attemptEndsAt`). */
const ATTEMPT_ENDS = new WeakMap<AttemptContext, number>();

/**
 * When the attempt behind `context` must end, epoch milliseconds — its start plus its cap (`min(timeoutMs, time
 * left)`, so never past the run's deadline) — or `undefined` for an uncapped attempt. A call made inside the
 * attempt runs under it as its deadline (`attempt/call.ts`). Only the runner's own contexts are known.
 */
export function attemptEndsAt(context: AttemptContext | undefined): number | undefined {
  return context === undefined ? undefined : ATTEMPT_ENDS.get(context);
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
  run: (attempt: number, context: AttemptContext) => Promise<T> | T,
  policy: RetryPolicy,
  options: AttemptRunOptions,
): Promise<T> {
  const of = attemptCeiling(policy.attempts);
  const rules = retryRules({ attempts: of });
  const now = options.now ?? Date.now;
  const deadline = readDeadline(options.deadline);
  const ownCap = attemptTimeoutMs(policy.timeoutMs);
  const tally = new SeriesTally();
  if (options.effect) refuseKeylessRetry(options.effect, of);
  /** An earlier attempt of this touching series left the effect unknown — a later answer of `none` cannot clear it. */
  let unknownSoFar = false;

  for (let attempt = 1; ; attempt++) {
    const startedAt = now();
    const live = new LiveAttempt(options, attempt, of, startedAt, deadline, ownCap, now);
    let value: T | undefined;
    let failure: Failure | undefined;
    try {
      const pending = run(attempt, live.context);
      // Started under a signal that had ALREADY aborted (a decider entered after a cancel): its synchronous part
      // ran as it always did; from here on nobody waits for it, so nothing it does after its first await lands.
      if (live.context.signal.aborted) live.abandonStarted();
      value = await (options.raced ? pending : live.race(pending));
    } catch (error: unknown) {
      failure = { error };
    }
    const durationMs = Math.max(0, now() - startedAt);
    const outcome = outcomeOf(failure, options.signal, live.timeoutReason);
    live.end(outcome);
    const inputs = new AttemptInputReader(policy, options, attempt, of, outcome, failure, deadline, now);

    let decision = decideAttempt(rules, inputs.read);
    // 9.15 asked retryOn, THEN checked the signal. Deciding again reads the signal afresh: rule 3 now matches,
    // ahead of every user function, so none is asked twice — and nothing is discarded, nothing waited for.
    if (decision.next === 'retry' && isCancelled(options.signal)) decision = decideAttempt(rules, inputs.read);

    // The discard comes BEFORE the wait's length is asked for, as it did in 9.15 — without a deadline. Under one,
    // rule 6 needs the wait's length to decide, so `backoffMs` was asked during the decision, before the discard.
    if (decision.next === 'retry') options.between?.(attempt);
    const delayMs = decision.next === 'retry' ? inputs.delayMs() : inputs.delayIfAsked();
    const timeLeftMs = deadline === undefined ? undefined : inputs.timeLeft();

    const category = inputs.category();
    const served = inputs.failed ? (options.serve ?? extractErrorInfo)(inputs.failed.error) : undefined;
    const effect = options.effect ? effectOf(inputs.outcome, failure?.error) : undefined;
    const recordedKey = options.effect ? recordedKeyOf(options.effect) : undefined;
    const record = freezeDeep<AttemptRecord>({
      series: options.series,
      kind: options.kind ?? 'stage',
      ...(options.target !== undefined && { target: options.target }),
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
      ...(live.capMs !== undefined && { timeoutMs: live.capMs }),
      ...(timeLeftMs !== undefined && { timeLeftMs }),
      ...(served !== undefined && { error: recordedError(served) }),
      ...(options.effect !== undefined && { system: options.effect.system }),
      ...(recordedKey !== undefined && { idempotencyKey: recordedKey }),
      ...(effect !== undefined && { effect }),
    });
    tally.add(record);
    if (record.effect === 'unknown') unknownSoFar = true;
    if (record.next !== 'retry') options.onEnd?.(tally.summary(lastOf(record, unknownSoFar)));
    options.onAttempt?.(record, served);

    if (record.next === 'done') return value as T;
    if (record.next === 'stop') throw stoppedFailure(options, record, failure, unknownSoFar);

    options.onRetry?.(attempt, of, delayMs ?? 0, served as StructuredErrorInfo);
    if (delayMs !== undefined && delayMs > 0) {
      try {
        await sleep(delayMs, options.signal);
      } catch (error: unknown) {
        options.onFailure?.(error, 'unknown');
        throw error;
      }
    }
    // No attempt follows a cut wait, so none is recorded: the summary says how the series ended. No attempt
    // STARTS at or past the deadline either — rule 6 decided with the clock, and the clock may have moved on.
    const cut = isCancelled(options.signal)
      ? 'aborted'
      : options.signal?.aborted || (deadline !== undefined && now() >= deadline)
      ? 'no-time-left'
      : undefined;
    if (cut !== undefined) {
      options.onEnd?.(tally.summary({ ...lastOf(record, unknownSoFar), next: 'stop', reason: cut }));
      throw stoppedFailure(options, record, failure, unknownSoFar);
    }
  }
}

/** The final physical attempt owns its category; a wrapper or cut wait has no such category. */
function stoppedFailure(
  options: AttemptRunOptions,
  record: AttemptRecord,
  failure: Failure | undefined,
  unknownSoFar: boolean,
): unknown {
  const error = stopError(options.effect, record, failure, unknownSoFar);
  if (record.outcome !== 'paused') {
    const category =
      record.next === 'stop' && Object.is(error, failure?.error) ? record.category ?? 'unknown' : 'unknown';
    options.onFailure?.(error, category);
  }
  return error;
}

/**
 * What a stopped series throws: the last attempt's own error — or, on a touching target where ANY attempt left the
 * effect unknown, `UnknownEffectError` with the last attempt's error as its cause. An earlier timeout may have
 * applied the effect; a later attempt that says "nothing was sent" speaks for itself only, so it cannot turn the
 * series into a plain failure. A pause is never converted: it is control flow.
 */
function stopError(
  effect: EffectTarget | undefined,
  record: AttemptRecord,
  failure: Failure | undefined,
  unknownSoFar: boolean,
): unknown {
  if (effect === undefined || !unknownSoFar || record.outcome === 'paused') return failure?.error;
  return unknownEffectError(effect, record, failure?.error);
}

/**
 * One attempt in flight: its cap, its signal (the run's, composed with its own timer), and the fence. Its own
 * timer is armed when the policy's cap is SHORTER than the time left; at the deadline the run's own signal aborts,
 * with the deadline's reason (so a run rejects with the reason it always did). Everything it arms is released
 * when the attempt ends.
 */
class LiveAttempt {
  readonly context: AttemptContext;
  /** The cap this attempt runs under — `min(timeoutMs, time left)`, never negative; absent when uncapped. */
  readonly capMs: number | undefined;
  /** The reason the attempt's OWN timer aborted with — set only if it fired. */
  timeoutReason: AttemptTimeoutError | undefined;
  private readonly cancelTimer: (() => void) | undefined;
  private readonly composed: { readonly signal: AbortSignal; dispose(): void };
  private abandoned = false;
  /** The attempt is over, however it ended — an `observed` report after this is the owner's to refuse. */
  private ended = false;
  private readonly onAbort = () => this.abandon();

  constructor(
    private readonly options: AttemptRunOptions,
    private readonly attempt: number,
    of: number,
    startedAt: number,
    deadline: number | undefined,
    ownCap: number | undefined,
    now: () => number,
  ) {
    const left = deadline === undefined ? Infinity : Math.max(0, deadline - startedAt);
    const cap = Math.min(ownCap ?? Infinity, left);
    this.capMs = Number.isFinite(cap) ? cap : undefined;
    // Its own timer when its own cap is the shorter, or when no run signal will abort at the deadline (a caller
    // with a deadline and no signal). Otherwise the run's signal ends it at the deadline, with the deadline's reason.
    const ownTimer = this.capMs !== undefined && ((ownCap !== undefined && ownCap < left) || !options.signal);
    const own = ownTimer ? new AbortController() : undefined;
    if (own) {
      const capMs = this.capMs as number;
      this.cancelTimer = setLongTimeout(() => {
        // A time limit, branded like the run's deadline: a call made inside this attempt that it cuts timed out.
        this.timeoutReason = markTimeLimit(new AttemptTimeoutError(attempt, capMs));
        own.abort(this.timeoutReason);
      }, capMs);
    }
    this.composed = anySignal([options.signal, own?.signal]);
    // Registered BEFORE the function runs, so the fence closes before any listener the function adds. A signal
    // ALREADY aborted (a decider entered after a cancel — no abort check precedes it) does not fence the attempt
    // before it runs: it runs as it did before the fence existed, and is fenced when it ends without an answer.
    this.composed.signal.addEventListener('abort', this.onAbort, { once: true });
    const signal = this.composed.signal;
    const capMs = this.capMs;
    this.context = Object.freeze({
      series: options.series,
      attempt,
      of,
      signal,
      ...(deadline !== undefined && { deadline }),
      ...(capMs !== undefined && { timeoutMs: capMs }),
      ...(options.effect !== undefined && { system: options.effect.system }),
      ...(options.effect?.idempotencyKey !== undefined && { idempotencyKey: options.effect.idempotencyKey }),
      timeLeftMs: () => (deadline === undefined ? Infinity : deadline - now()),
      observed: (report: ObservedAttempt) => {
        if (!options.observe) {
          throw new TypeError('observed(): report an outside attempt through `scope.$attempt().observed(...)`');
        }
        options.observe(report, { attempt, ended: this.ended });
      },
    });
    if (capMs !== undefined) ATTEMPT_ENDS.set(this.context, startedAt + capMs);
  }

  /** `value`, or the attempt signal's reason the moment it aborts first — the engine stops waiting at the cap. */
  race<T>(value: Promise<T> | T): Promise<T> | T {
    if (!(value instanceof Promise)) return value;
    const signal = this.composed.signal;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      value.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
      // Already aborted (the function aborted it as it ran): a value that already settled still wins — its
      // reaction was queued above, first — and a pending one is cut on the next microtask.
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The attempt is over: release the timer and the listeners; fence it if it ended without an answer. */
  end(outcome: AttemptOutcome): void {
    this.ended = true;
    this.cancelTimer?.();
    this.composed.signal.removeEventListener('abort', this.onAbort);
    this.composed.dispose();
    if (outcome !== 'ok' && outcome !== 'paused') this.abandon();
  }

  /** Fence an attempt that started under an already-aborted signal, once its synchronous part has run. */
  abandonStarted(): void {
    this.abandon();
  }

  private abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.options.onAbandon?.(this.attempt);
  }
}

/** The signal aborted at a time limit — the run's deadline, or a call's attempt cap — not by a cancellation. */
function timedOut(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && isDeadlineReason(signal.reason);
}

/**
 * How the attempt itself ended. A thrown value is the attempt's own failure unless it IS what a signal aborted
 * with (StageRunner's race rejects with it; a stage may rethrow it): its own cap's `AttemptTimeoutError` or the
 * run's deadline → `'timeout'`; the run's cancellation → `'aborted'`.
 */
function outcomeOf(
  failure: Failure | undefined,
  signal: AbortSignal | undefined,
  timeoutReason: AttemptTimeoutError | undefined,
): AttemptOutcome {
  if (!failure) return 'ok';
  // An `interrupt()` thrown inside a call is converted to a pause at the stage boundary, past this runner.
  if (isPauseSignal(failure.error) || isInterruptSignal(failure.error)) return 'paused';
  // Its own cap ran out — the attempt's timer is the one that fired, and the attempt threw what it aborted with.
  if (timeoutReason !== undefined && failure.error === timeoutReason) return 'timeout';
  if (signal?.aborted !== true || failure.error !== signal.reason) return 'failed';
  // The run's signal ended it: at the deadline the attempt ran out of time (law 4); otherwise it was cancelled.
  return isDeadlineReason(signal.reason) ? 'timeout' : 'aborted';
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

  private left: number | undefined;

  constructor(
    private readonly policy: RetryPolicy,
    private readonly options: AttemptRunOptions,
    private readonly attempt: number,
    private readonly of: number,
    readonly outcome: AttemptOutcome,
    failure: Failure | undefined,
    private readonly deadline: number | undefined,
    private readonly now: () => number,
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
        // Live: a decision taken again after `retryOn` sees an abort raised inside it. The deadline is not a
        // cancellation — rule 6 owns it.
        return isCancelled(this.options.signal);
      case 'attempt':
        return this.attempt;
      case 'of':
        return this.of;
      case 'timeLeftMs':
        return this.timeLeft();
      case 'timeLeftAfterWaitMs':
        // Without a deadline the time left is unbounded, before any wait and after it — so deciding needs no
        // wait, and `backoffMs` is asked after the discard, as in 9.15. Under one, the wait's length decides.
        return this.unbounded() ? Infinity : this.timeLeft() - this.delayMs();
      case 'delayMs':
        return this.delayMs();
      case 'retryOn':
        return this.retryOn();
      case 'keyPresent':
        return this.options.effect?.idempotencyKey !== undefined;
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

  /** The policy's wait after this attempt (`resolveBackoffMs`), asked once — capped at its `maxBackoffMs`. */
  delayMs(): number {
    return (this.wait ??= cappedWaitMs(
      resolveBackoffMs(this.policy.backoffMs, this.attempt, this.failed?.error),
      this.policy.maxBackoffMs,
    ));
  }

  /** The wait, if the decision already asked for it (rule 6 under a deadline); never asks `backoffMs` itself. */
  delayIfAsked(): number | undefined {
    return this.wait;
  }

  /** Milliseconds before the deadline at the decision, read once (`Infinity` without one). */
  timeLeft(): number {
    if (this.unbounded()) return Infinity;
    if (this.left === undefined) {
      const clock = this.deadline === undefined ? Infinity : this.deadline - this.now();
      // A time limit already reached — the signal aborted at the deadline (or, for a call, at its attempt's cap) —
      // leaves no time, whatever the clock says: a host timer may fire a millisecond before the clock gets there.
      this.left = timedOut(this.options.signal) ? Math.min(clock, 0) : clock;
    }
    return this.left;
  }

  /** No deadline and no time limit reached: the time left is `Infinity`, and no wait need be asked for. */
  private unbounded(): boolean {
    return this.deadline === undefined && !timedOut(this.options.signal);
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
 * Resolve a policy's `backoffMs` for the attempt that just failed (1-based) and its error. Anything that is not a finite,
 * positive number — a missing dial, a negative value, a `NaN` from a consumer's arithmetic, or a throwing
 * function — becomes `0`, i.e. retry immediately. A backoff dial must never be able to crash a run or park it
 * forever.
 */
export function resolveBackoffMs(backoffMs: RetryPolicy['backoffMs'], attempt: number, error?: unknown): number {
  if (backoffMs === undefined) return 0;
  let value: unknown;
  if (typeof backoffMs === 'function') {
    try {
      value = backoffMs(attempt, error);
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
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      cancel();
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const cancel = setLongTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * How a record ended its series, as the summary's `last` says it. On a touching target the effect is the SERIES'
 * (`unknownSoFar`): unknown once any attempt left it unknown, unless the series ended with an answer.
 */
function lastOf(record: AttemptRecord, unknownSoFar = false): AttemptSummary['last'] {
  const effect = record.effect !== undefined && unknownSoFar && record.outcome !== 'ok' ? 'unknown' : record.effect;
  return {
    next: record.next as AttemptSummary['last']['next'],
    reason: record.reason,
    ...(record.category !== undefined && { category: record.category }),
    ...(record.retryOnThrew && { retryOnThrew: true as const }),
    ...(effect !== undefined && { effect }),
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
