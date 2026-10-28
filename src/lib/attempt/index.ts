/**
 * attempt/ — one runner, one record: every attempt the library runs is an `AttemptRecord` with the
 * retry-or-stop decision that followed it (design docs/design/2026-10-time-and-failure-evidence.md).
 *
 * Public: the record's vocabulary, the one failure classifier, the one rule table, the two errors, `attempt()`
 * — the runner for code that is not a stage (P2) — and the backoff builders a `RetryPolicy.backoffMs` takes. The loop
 * itself (`runAttempts`), `runCall`, the evidence builder, `anySignal` and the long-timer law are the engine's.
 * `RetryPolicy` is declared in `./types.ts` and published through the builder's barrel, where it always was.
 */

export type { BackoffFunction, BackoffJitter, BackoffSpec, StatedWaitReader } from './backoff.js';
export { exponentialBackoff, statedWaitFirst } from './backoff.js';
export { errorCategory } from './category.js';
export type { ParsedTraceparent, TraceparentFields, TraceparentRefusal } from './correlation.js';
export { formatTraceparent, parseTraceparent, TraceparentError } from './correlation.js';
export { retryRules } from './decision.js';
export type { UnknownEffectInit } from './errors.js';
export { AttemptTimeoutError, UnknownEffectError } from './errors.js';
export type { AttemptOptions } from './standalone.js';
export { attempt } from './standalone.js';
export type {
  AttemptCategory,
  AttemptContext,
  AttemptEffect,
  AttemptError,
  AttemptInputs,
  AttemptKind,
  AttemptNext,
  AttemptOutcome,
  AttemptReason,
  AttemptRecord,
  AttemptSummary,
  CallOptions,
  IdempotencyKeyContext,
  LateWrite,
  ObservedAttempt,
  RunCorrelation,
  StageTouches,
} from './types.js';
