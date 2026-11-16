/**
 * stageError — the ONE place a failed stage's error is recorded and served.
 *
 * Writes `errors.stageExecutionError` through the diagnostic collector (which
 * applies the run's diagnostic policy) and hands back the form `onError` is
 * served: the same retained text, decided once, so the narrative, flow events
 * and recorder rows never see what the policy masked. The linear, decider and
 * selector error paths all call it; retries, throttle events and the logger
 * ask `servedStageError` / `loggableStageError` for the same decision.
 */

import { terminalCategory } from '../../attempt/category.js';
import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import { extractErrorInfo, thrownText } from '../../errors/errorInfo.js';
import {
  failureReceipt,
  invalidateFailureReceipt,
  isCommitFailure,
  publishFailureReceipt,
  rememberErrorEnvelope,
} from '../../errors/failureRetention/index.js';
import type { StageContext } from '../../memory/StageContext.js';
import {
  escapingError,
  ownedErrorSources,
  projectionKind,
  readErrorSources,
} from '../../memory/stageErrorRetention/index.js';
import {
  errorRuleIdentity,
  retainOwnedError,
  retainWrapperError,
  serveOwnedError,
} from '../../memory/stageErrorRetention/owned.js';

export function recordStageError(
  context: StageContext,
  error: unknown,
): { message: string; structuredError: StructuredErrorInfo } {
  captureStageFailure(context, error);
  const text = thrownText(error);
  const rule = context.getRedactionRule();
  const commitUnknown = isCommitFailure(context.failureState, error);
  if (!rule || rule.isDiagnosticInert()) {
    const kept = context.addDiagnostic('errors', 'stageExecutionError', text);
    context.markStageFailure();
    const served = rule
      ? rule.retainStageError(error, text, kept)
      : { message: text, structuredError: extractErrorInfo(error) };
    publishFailureReceipt(
      context.failureState,
      error,
      context.failureIdentity,
      served,
      commitUnknown || readErrorSources(context) === undefined ? 'unknown' : 'clear',
    );
    return served;
  }
  const served = rule
    ? retainOwnedError(
        rule,
        error,
        text,
        text,
        ownedErrorSources(context, commitUnknown ? () => undefined : undefined),
        ['errors', 'stageExecutionError'],
      )
    : { message: text, structuredError: extractErrorInfo(error) };
  context.addDiagnostic('errors', 'stageExecutionError', served.message);
  context.markStageFailure();
  publishFailureReceipt(
    context.failureState,
    error,
    context.failureIdentity,
    served,
    commitUnknown ? 'unknown' : projectionKind(served),
  );
  return served;
}

/** Capture before commit observers or diagnostic serving can change the raw value. */
export function captureStageFailure(context: StageContext, error: unknown, commit = false): void {
  // The native runner may already own the exact final category; never recover
  // it from a served error or an unrelated call/observed/recovered attempt.
  const identity = context.failureIdentity;
  if (identity && !context.failureState.owns(error)) {
    context.failureState.capture(error, terminalCategory(error), identity);
  }
  if (commit) invalidateFailureReceipt(context.failureState);
  if (identity && commit && context.captureClosureTracking) context.failureState.selectCommit(error, identity);
}

/** The served form of a thrown value at any other report of a stage failure (retry, throttle). */
export function servedStageError(context: StageContext, error: unknown, escaping = false): StructuredErrorInfo {
  const receipt = failureReceipt(context.failureState, error);
  if (receipt?.projection) return { ...receipt.projection.structuredError };
  const rule = context.getRedactionRule();
  if (escaping && rule) return escapingError(rule, error, context.failureState);
  return rule
    ? serveOwnedError(rule, error, ownedErrorSources(context, receipt || escaping ? () => undefined : undefined))
    : extractErrorInfo(error);
}

/** What the logger is handed: the thrown value, or its masked form when the policy masked its text. */
export function loggableStageError(context: StageContext, error: unknown): unknown {
  const rule = context.getRedactionRule();
  if (!rule || rule.isDiagnosticInert()) return error;
  const served = servedStageError(context, error);
  return served.raw === error ? error : served;
}

/** Preserve the actual contained child's decision before native completion releases its token. */
export function retainChildResult<T extends { readonly result: unknown; readonly isError: boolean }>(
  context: StageContext,
  envelope: T,
): T {
  const rule = context.getRedactionRule();
  if (envelope.isError && rule && !rule.isDiagnosticInert())
    rememberErrorEnvelope(
      errorRuleIdentity(rule),
      envelope,
      envelope.result,
      servedStageError(context, envelope.result, true),
      failureReceipt(context.failureState, envelope.result)?.kind ?? 'unknown',
    );
  return envelope;
}

/** Retain at the three existing mount reporting sites; a mapper has no child receipt. */
export function recordBoundaryError(
  context: StageContext,
  error: unknown,
  key: 'inputMapperError' | 'subflowError' | 'outputMapperError',
  child?: { readonly rootStageContext: StageContext },
): unknown {
  const rule = context.getRedactionRule();
  if (!rule || rule.isDiagnosticInert()) {
    context.addError(key, thrownText(error));
    return error;
  }
  const projection =
    (child && failureReceipt(child.rootStageContext.failureState, error)?.projection) ??
    (() => {
      const text = thrownText(error);
      return retainOwnedError(
        rule,
        error,
        text,
        text,
        ownedErrorSources(context, () => undefined),
        ['errors', key],
      );
    })();
  const served = retainWrapperError(rule, projection, ['errors', key]);
  context.addError(key, served.message);
  return served.structuredError.raw === error ? error : served.structuredError;
}

/**
 * A touching stage's idempotency key as records carry it (P3, design §6) — `RedactionRule · retainIdempotencyKey`:
 * selected by its name, and served whole when the input its rule was handed holds a selected key or the rule read
 * a selected state value. The stage itself
 * keeps the real key.
 */
export function servedIdempotencyKey(context: StageContext, key: string, input: unknown, readSelected = false): string {
  const rule = context.getRedactionRule();
  return rule ? rule.retainIdempotencyKey(key, { input, selectedReads: readSelected ? 1 : 0 }) : key;
}
