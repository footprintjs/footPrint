/**
 * attempt/types.ts — the attempt vocabulary: ONE record shape for every try the library runs.
 *
 * A retry is a loop, and every pass of it is an `AttemptRecord`: when it started, how long it took, how it
 * ended, its failure category, and the retry-or-stop decision that followed it — a `DecisionEvidence`, the
 * shape `decide()` produces, so a reader walks a retry exactly as it walks a decider (design
 * docs/design/2026-10-time-and-failure-evidence.md, §3.1, §3.8, §4).
 *
 * WHERE it lives: on the execution tree (`StageSnapshot.attempts` / `attemptSummary`), on the `onAttempt`
 * hook, and in recorders' stores — never on the commit bundle, so every log stays byte-identical (Q1).
 *
 * A LEAF (L0, scripts/layering.config.cjs): the frame's snapshot type (`memory/frameTypes.ts`, L4) names
 * `AttemptRecord`, so this file imports only other leaves' types.
 */

import type { DecisionEvidence } from '../decide/types.js';
import type { StructuredErrorInfo } from '../errors/errorInfo.js';

/**
 * Declarative per-stage retry policy — the policy the attempt runner runs (`AttemptPolicy` in the design is
 * this one type, under this one name).
 *
 * WHY this exists: a retry hand-rolled inside a stage function is invisible to
 * the trace. The stage shows one execution, the commit log shows one bundle,
 * and the two failed calls that preceded the successful one left no mark
 * anywhere — an unexplained behaviour in a library whose whole thesis is that
 * nothing invisible happens. Declared here instead, every attempt is part of
 * the record: each attempt fires `FlowRecorder.onAttempt` with its
 * {@link AttemptRecord}, each failed attempt that is retried also fires
 * `FlowRecorder.onStageRetry`, and the stage's execution-tree node carries
 * `attempts` and `attemptSummary`.
 *
 * A POLICY, not a stage kind — `retry` sits on a normal stage the way
 * `isPausable` / `isStreaming` do. The serialized node `type` is unchanged and
 * every existing consumer keeps rendering the stage exactly as before.
 *
 * @example
 * ```ts
 * flowChart<State>('Fetch user', fetchFn, 'fetch-user')
 *   .retry({ attempts: 3, backoffMs: (n) => 100 * 2 ** (n - 1) })
 * ```
 */
export interface RetryPolicy {
  /**
   * How many times the stage function may run in total, INCLUDING the first
   * run. Must be an integer >= 1; `1` means "no retry" (a declared no-op,
   * accepted so a policy can be switched off without deleting it — such a
   * stage runs once and records no attempts).
   */
  attempts: number;
  /**
   * How long to wait before the NEXT attempt. Either a fixed number of
   * milliseconds, or a function of the attempt that just FAILED (1-based)
   * returning milliseconds — `(n) => 100 * 2 ** (n - 1)` is exponential
   * backoff. Omitted (or a non-finite / negative result) means no wait.
   *
   * The wait is a plain awaited timer that is CANCELLED by the run's
   * `AbortSignal`. It is not a pause: a chart cannot be checkpointed in the
   * middle of a backoff.
   */
  backoffMs?: number | ((attempt: number) => number);
  /**
   * Is THIS error worth another attempt? Defaults to retrying every error.
   * Returning `false` ends the stage immediately on the normal error path, with
   * no retry event; the attempt's record says why it stopped (`reason:
   * 'declined'`).
   *
   * A throw from this predicate is treated as `false` — a broken predicate
   * must not turn a failing stage into an infinite retry loop.
   */
  retryOn?: (error: unknown) => boolean;
}

/** Who ran the attempt: the engine for a stage's policy; a `$call` or an SDK reported as observed (later packets). */
export type AttemptKind = 'stage' | 'call' | 'observed';

/**
 * How one attempt ended. `'timeout'` is the attempt's OWN timer (never the outside system failing — law 4);
 * `'aborted'` is the run's signal; `'paused'` is a pause (control flow, never retried).
 */
export type AttemptOutcome = 'ok' | 'failed' | 'timeout' | 'aborted' | 'paused';

/**
 * The failure category of an attempt that did not succeed — ONE fixed set of seven, classified by
 * `errorCategory` (`attempt/category.ts`), so every recorder breaks failures down the same way (§3.9).
 * Evidence, never policy: the default `retryOn` retries every category.
 */
export type AttemptCategory = 'timeout' | 'rate-limited' | 'server' | 'network' | 'auth' | 'permanent' | 'unknown';

/** What follows an attempt: another one, the value (`'done'`), or the attempt's own error (`'stop'`). */
export type AttemptNext = 'retry' | 'done' | 'stop';

/**
 * Why the series went on or ended — the matched rule's label in `retryRules` (`attempt/decision.ts`), or the
 * default's (`'retryable'`).
 */
export type AttemptReason =
  | 'succeeded'
  | 'paused'
  | 'aborted'
  | 'exhausted'
  | 'declined'
  | 'no-time-left'
  | 'retryable';

/**
 * An attempt's error as the run SERVES it — `StructuredErrorInfo` under the run's redaction rule
 * (`RedactionRule.retainStageError`), without `raw`: a record must survive `structuredClone` and must never
 * hand out the thrown value itself.
 */
export type AttemptError = Omit<StructuredErrorInfo, 'raw'>;

/**
 * What a retry-or-stop decision reads — the inputs `retryRules` evaluates, first match wins (§3.1). The runner
 * computes each one only when a rule reaches it, so `retryOn` and `backoffMs` run exactly when a retry needs
 * them.
 *
 * `category` and `keyPresent` are inputs no default rule reads; a chart's own rules over the same inputs may.
 * `timeLeftMs` is `Infinity` without a deadline, and so is `timeLeftAfterWaitMs` (= `timeLeftMs − delayMs`):
 * the no-time-left rule compares one input with a constant, as every `decide()` filter does.
 */
export interface AttemptInputs {
  readonly outcome: AttemptOutcome;
  readonly category?: AttemptCategory;
  /** This attempt, 1-based. */
  readonly attempt: number;
  /** The attempts the policy allows in total. */
  readonly of: number;
  readonly timeLeftMs: number;
  /** The wait before the next attempt, from `backoffMs` (`0` when it is absent, invalid or throws). */
  readonly delayMs: number;
  readonly timeLeftAfterWaitMs: number;
  /** The policy's `retryOn` verdict on this attempt's error (`true` when absent; a throw is `false`). */
  readonly retryOn: boolean;
  /** Whether the target declared an idempotency key — never its value. */
  readonly keyPresent: boolean;
}

/**
 * One attempt — the unit of time and failure evidence. Frozen; survives `structuredClone`.
 *
 * Identity: `series` (the stage execution's `runtimeStageId` for a stage attempt) plus `attempt`.
 */
export interface AttemptRecord {
  /** The series the attempt belongs to — for a stage attempt, its execution's `runtimeStageId`. */
  readonly series: string;
  readonly kind: AttemptKind;
  /** 1-based within the series. */
  readonly attempt: number;
  /** The attempts the policy allows in total. */
  readonly of?: number;
  /** Epoch milliseconds when the attempt started. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: AttemptOutcome;
  /** Present when the attempt failed, timed out or was aborted; absent for `'ok'` and `'paused'`. */
  readonly category?: AttemptCategory;
  /** The retry-or-stop decision — the evidence `decide()` would record for `retryRules(policy)`. */
  readonly decision: DecisionEvidence;
  /** `decision.chosen` — the compact projection a badge reads. */
  readonly next: AttemptNext;
  readonly reason: AttemptReason;
  /** The wait before the next attempt — present when the decision computed it (a retry). */
  readonly delayMs?: number;
  /** The served error of an attempt that failed, timed out or was aborted. */
  readonly error?: AttemptError;
}

/**
 * A series at a glance — stamped once, when the series ends (the Lens badge, §3.10). `last` is how it ended:
 * the last record's `next` / `reason`, or `stop` / `aborted` when the run's signal cut a wait (no attempt
 * followed, so none is recorded).
 */
export interface AttemptSummary {
  readonly count: number;
  readonly ok: number;
  readonly failed: number;
  readonly timeout: number;
  readonly aborted: number;
  readonly paused: number;
  readonly last: {
    readonly next: Exclude<AttemptNext, 'retry'>;
    readonly reason: AttemptReason;
    readonly category?: AttemptCategory;
  };
}
