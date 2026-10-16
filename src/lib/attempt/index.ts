/**
 * attempt/ — one runner, one record: every attempt the library runs is an `AttemptRecord` with the
 * retry-or-stop decision that followed it (design docs/design/2026-10-time-and-failure-evidence.md).
 *
 * Public: the record's vocabulary, the one failure classifier, the one rule table, the two errors. The runner
 * itself (`runAttempts`), the evidence builder and `anySignal` are the engine's. `RetryPolicy` is declared in
 * `./types.ts` and published through the builder's barrel, where it always was.
 */

export { errorCategory } from './category.js';
export type { ParsedTraceparent, TraceparentFields, TraceparentRefusal } from './correlation.js';
export { formatTraceparent, parseTraceparent, TraceparentError } from './correlation.js';
export { retryRules } from './decision.js';
export type { UnknownEffectInit } from './errors.js';
export { AttemptTimeoutError, UnknownEffectError } from './errors.js';
export type {
  AttemptCategory,
  AttemptError,
  AttemptInputs,
  AttemptKind,
  AttemptNext,
  AttemptOutcome,
  AttemptReason,
  AttemptRecord,
  AttemptSummary,
  RunCorrelation,
} from './types.js';
