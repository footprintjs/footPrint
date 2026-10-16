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
   * milliseconds, or a function of the attempt that just FAILED (1-based) and
   * its error, returning milliseconds — `(n) => 100 * 2 ** (n - 1)` is
   * exponential backoff; `(n, error) => statedWaitMs(error) ?? 100 * n` honours
   * a wait the outside system stated (a `Retry-After`) without the engine
   * parsing anything. A one-argument function is unchanged. Omitted (or a
   * non-finite / negative result, or a throw) means no wait.
   *
   * The wait is a plain awaited timer that is CANCELLED by the run's
   * `AbortSignal`. It is not a pause: a chart cannot be checkpointed in the
   * middle of a backoff. Under a run deadline, a wait that would outlast it is
   * never started: the series stops `no-time-left`.
   */
  backoffMs?: number | ((attempt: number, error: unknown) => number);
  /**
   * The most one wait may last, in milliseconds — a finite number >= 0. The
   * runner ENFORCES it: every wait is `min(backoffMs's answer, maxBackoffMs)`,
   * whatever the error stated, so the declaration cannot lie.
   *
   * It is what makes a FUNCTION backoff countable before the run. A function
   * may read the error (a stated `Retry-After`), and no error exists at build,
   * so the static budget check never asks it: with `maxBackoffMs` it counts
   * each wait at the ceiling; without, the stage is unbounded (`'backoff'`).
   *
   * @example
   * ```ts
   * .retry({ attempts: 4, timeoutMs: 10_000, backoffMs: (n, error) => statedWaitMs(error) ?? 500 * n, maxBackoffMs: 5_000 })
   * ```
   */
  maxBackoffMs?: number;
  /**
   * The cap on ONE attempt, in milliseconds — a finite number > 0. The attempt
   * runs under `min(timeoutMs, time left before the run's deadline)`; when the
   * cap runs out, the attempt's signal (`scope.$attempt().signal`) aborts with
   * an `AttemptTimeoutError`, the engine stops waiting for it, and the attempt
   * is recorded `timeout` (then retried like any failure, if the policy allows).
   *
   * What the engine stops is the WAITING. The function's own work stops only if
   * it passes the signal on (`fetch(url, { signal: scope.$attempt().signal })`);
   * whatever it writes after its attempt ended is dropped and recorded on the
   * stage (`StageSnapshot.lateWrites`).
   *
   * Declared with `attempts: 1`, it is a timeout with no retry — the stage
   * still records its one attempt.
   */
  timeoutMs?: number;
  /**
   * Is THIS error worth another attempt? Defaults to retrying every error.
   * Returning `false` ends the stage immediately on the normal error path, with
   * no retry event; the attempt's record says why it stopped (`reason:
   * 'declined'`).
   *
   * A throw from this predicate is treated as `false` — a broken predicate
   * must not turn a failing stage into an infinite retry loop. The record
   * tells the two apart: a throw stops the series `declined` with
   * `retryOnThrew: true`.
   */
  retryOn?: (error: unknown) => boolean;
}

/**
 * Who ran the attempt: the engine, for a stage's own policy (`'stage'`); the attempt runner, for a call a stage made
 * through `scope.$call` or for the standalone `attempt()` (`'call'`); an outside system on its own — an SDK's
 * internal retry — reported through `AttemptContext.observed` (`'observed'`, P2).
 */
export type AttemptKind = 'stage' | 'call' | 'observed';

/**
 * How one attempt ended. `'timeout'` is the attempt's OWN timer (never the outside system failing — law 4);
 * `'paused'` is a pause (control flow, never retried). `'aborted'` is the run's signal ending the attempt: the
 * attempt threw the abort's own reason. An attempt that threw its own error is `'failed'`, with its category,
 * even when the run aborted around it — the abort is then the series' stop reason (`reason: 'aborted'`), never a
 * rewrite of what the attempt did.
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
  /**
   * The run's signal has aborted — read when rule 3 is reached, so an abort raised inside `retryOn` is seen by
   * the decision taken again after it. Always `true` for an `'aborted'` outcome.
   */
  readonly aborted: boolean;
  /** This attempt, 1-based. */
  readonly attempt: number;
  /** The attempts the policy allows in total. */
  readonly of: number;
  readonly timeLeftMs: number;
  /** The wait before the next attempt, from `backoffMs` (`0` when it is absent, invalid or throws). */
  readonly delayMs: number;
  readonly timeLeftAfterWaitMs: number;
  /**
   * The policy's `retryOn` verdict on this attempt's error (`true` when absent; a throw is `false`, and the
   * record says it threw: `AttemptRecord.retryOnThrew`).
   */
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
  /**
   * The series the attempt belongs to. A stage attempt: its execution's `runtimeStageId`. A call — `$call`, or an
   * observed SDK call — made during stage attempt `n`: `<runtimeStageId>@<n>.<k>`, the `k`-th call of that attempt,
   * so `<series>@<attempt>` is the attempt id of foottrace's grammar (design §3.4). A standalone `attempt()`: the
   * caller's name for the operation.
   */
  readonly series: string;
  readonly kind: AttemptKind;
  /**
   * The outside target of a `'call'` or `'observed'` attempt — a NAME from code (`'stripe.quotes.create'`), never
   * a value. Absent on a stage attempt: its stage names it.
   */
  readonly target?: string;
  /** Who ran an `'observed'` attempt — the report's `source` (`'sdk'` unless it said otherwise). Absent otherwise. */
  readonly source?: string;
  /** 1-based within the series. */
  readonly attempt: number;
  /** The attempts the policy allows in total. */
  readonly of?: number;
  /** Epoch milliseconds when the attempt started. */
  readonly startedAt: number;
  readonly durationMs: number;
  /** How the attempt itself ended — never rewritten by what the series did next (see {@link AttemptOutcome}). */
  readonly outcome: AttemptOutcome;
  /**
   * Present when the attempt failed, timed out or was aborted; absent for `'ok'` and `'paused'`. Read off the
   * error as it stood when the decision was made (after `retryOn` ran), like `error`.
   */
  readonly category?: AttemptCategory;
  /** The retry-or-stop decision — the evidence `decide()` would record for `retryRules(policy)`. */
  readonly decision: DecisionEvidence;
  /** `decision.chosen` — the compact projection a badge reads. */
  readonly next: AttemptNext;
  readonly reason: AttemptReason;
  /**
   * `true` when the policy's `retryOn` THREW on this attempt's error (absent otherwise). A throw is "do not
   * retry", so the reason is `'declined'`; this flag keeps a broken predicate apart from a real `false`.
   */
  readonly retryOnThrew?: true;
  /**
   * The wait before the next attempt — present when the decision computed it: a retry, or (under a deadline) a
   * `no-time-left` stop, whose wait would have outlasted the time left.
   */
  readonly delayMs?: number;
  /**
   * The cap this attempt ran under, in milliseconds — `min(RetryPolicy.timeoutMs, time left before the deadline)`
   * at its start. Absent when neither was set (the attempt ran uncapped).
   */
  readonly timeoutMs?: number;
  /** The time left before the run's deadline when the decision was made (negative once past). Absent without one. */
  readonly timeLeftMs?: number;
  /** The served error of an attempt that failed, timed out or was aborted. */
  readonly error?: AttemptError;
}

/**
 * The attempt a function is running in — a stage's (`scope.$attempt()`, design §3.1), or a call's (the argument
 * `scope.$call` and `attempt()` hand their function, P2). Never serialised: it holds a live signal.
 *
 * A stage with no retry policy and no deadline is attempt 1 of 1, with the run's signal (or one that never
 * aborts) and `Infinity` left.
 */
export interface AttemptContext {
  /** The series its record names (see {@link AttemptRecord.series}). */
  readonly series: string;
  /** This attempt, 1-based. */
  readonly attempt: number;
  /** The attempts the policy allows in total. */
  readonly of: number;
  /**
   * Aborts when this attempt must stop: at its cap (`AttemptTimeoutError`), at the run's deadline, or when the run
   * is cancelled. Pass it to `fetch` and SDK calls — the engine stops waiting at the cap either way, but only the
   * function can stop its own work.
   */
  readonly signal: AbortSignal;
  /** The run's deadline, epoch milliseconds — absent without one. */
  readonly deadline?: number;
  /** The cap this attempt runs under (see {@link AttemptRecord.timeoutMs}) — absent when uncapped. */
  readonly timeoutMs?: number;
  /**
   * Milliseconds before the run's deadline — `Infinity` without one. Read through the scope, it marks the stage's
   * commit `untrackedSources: ['env']` when a deadline exists: time is an input the record cannot replay.
   */
  timeLeftMs(): number;
  /**
   * Report an attempt an outside system ran ON ITS OWN — an SDK's internal retry (design §3.6, P2). It becomes an
   * `AttemptRecord` of kind `'observed'` beside this attempt's evidence, and fires `onAttempt`; it never changes
   * control flow — in either direction: a report that comes after this attempt ended (an SDK's callback firing
   * late) is dropped and recorded by name (`lateWrites`), never thrown. Only the report's named fields are read; its
   * error is served under the run's redaction rule, and no hook is handed the error object itself. A malformed
   * report is the adapter's bug: a `TypeError` naming the field. Prefer one loop: turn the SDK's own retries off and
   * run the call under `scope.$call`.
   */
  observed(report: ObservedAttempt): void;
}

/**
 * An attempt an outside system ran on its own, as an adapter reports it (`AttemptContext.observed`). Only these
 * fields are read — each once; anything else on the object is dropped.
 *
 * A report with `of` stands for one attempt of the SDK's series; a report without one stands for the SDK's WHOLE
 * call, its count unknown — "the SDK ran this" rather than a pretended count.
 */
export interface ObservedAttempt {
  /** The outside target — a name from code: 1–128 characters, no control, format or line-separator character. */
  readonly target: string;
  /** Which attempt of the SDK's own series, 1-based. Default `1`. */
  readonly attempt?: number;
  /** The attempts the SDK allows in total, when it says (≥ `attempt`). */
  readonly of?: number;
  /** How the SDK's attempt ended. An SDK cannot pause a flowchart, so `'paused'` is refused. */
  readonly outcome: Exclude<AttemptOutcome, 'paused'>;
  /** How long it took, milliseconds — finite and ≥ 0. */
  readonly durationMs: number;
  /** When it started, epoch milliseconds. Default: the report's arrival minus `durationMs`. */
  readonly startedAt?: number;
  /** Who ran it — a name like `target`. Default `'sdk'`. */
  readonly source?: string;
  /** The error of an attempt that did not succeed — served under the run's redaction rule, never kept as thrown. */
  readonly error?: unknown;
}

/**
 * A write, emit, diagnostic, detach or call an attempt tried AFTER it had ended — timed out, aborted or failed —
 * dropped at the scope and recorded on its stage (`StageSnapshot.lateWrites`, the first 100 —
 * `StageContext · MAX_LATE_WRITES`). A name, never the value.
 */
export interface LateWrite {
  /** The attempt that wrote late, 1-based. */
  readonly attempt: number;
  /**
   * The state key (a dotted path for a nested write), the emitted event's name (a diagnostic's emit name —
   * `log.debug.<key>`, `metric.<name>` — for `$debug` / `$metric` / …), `detach:<child root id>`, or — on the
   * `'attempt'` channel (P2) — `call:<target>` (a `$call` started, or a call's record arriving, after its attempt
   * ended) or `observed:<target>` (an observed report after it).
   */
  readonly key: string;
  readonly channel: 'state' | 'emit' | 'detach' | 'attempt';
}

/**
 * A series at a glance — stamped once, when the series ends (the Lens badge, §3.10). `last` is how it ended:
 * the last record's `next` / `reason` (and `category`, `retryOnThrew`), or `stop` / `aborted` when the run's
 * signal cut a wait (no attempt followed, so none is recorded).
 *
 * The SERIES' outcome, not the STAGE's. `last.next: 'done'` says the stage function returned; the stage can
 * still fail after that — its commit can fail (a value nothing can clone), and a StageNode it returned can be
 * refused at the run-time door (R5) — and then its `onError` fires with this summary unchanged. Whether the
 * stage failed is the execution's own fact (its error), never read off this summary.
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
    readonly retryOnThrew?: true;
  };
}

/**
 * The run's correlation — which outside trace and unit of work this run belongs to (design §3.4). Resolved ONCE
 * per leg (`run()`, and each `resume()`) from the env by `attempt/correlation.ts · resolveCorrelation`, frozen, and
 * handed by reference to `RuntimeSnapshot.correlation`, every flow event's `TraversalContext.correlation`, and
 * every scope and emit event's `correlation`. Absent — no key anywhere — when the env gives none.
 *
 * Correlation only: a NAME the record carries so a run can be found from a trace. Never identity, never
 * authorisation — a `traceparent` comes from whoever sent the request.
 */
export interface RunCorrelation {
  /** `env.traceId`, else the trace id of `env.traceparent` (32 lowercase hex). */
  readonly traceId: string;
  /** `env.operationId`, else the header's parent-id (only while the trace is the header's): the caller's unit of work. */
  readonly operationId?: string;
  /** The header's sampled flag (bit 0 of trace-flags) — present only while the trace is the header's. A hint. */
  readonly sampled?: boolean;
  /**
   * The canonical header of the EFFECTIVE ids (`formatTraceparent`) — for propagating the trace onward. Present
   * only while the trace is the header's and the operation is a W3C parent-id; never the received bytes.
   */
  readonly traceparent?: string;
}
