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
import type { StageContext } from '../../memory/StageContext.js';
import type { TraversalContext } from '../narrative/types.js';

export function recordStageError(
  context: StageContext,
  error: unknown,
  traversalContext?: TraversalContext,
): { message: string; structuredError: StructuredErrorInfo } {
  captureStageFailure(context, error, traversalContext);
  const text = thrownText(error);
  const kept = context.addDiagnostic('errors', 'stageExecutionError', text);
  context.markStageFailure();
  const rule = context.getRedactionRule();
  return rule ? rule.retainStageError(error, text, kept) : { message: text, structuredError: extractErrorInfo(error) };
}

/** Capture before commit observers or diagnostic serving can change the raw value. */
export function captureStageFailure(context: StageContext, error: unknown, traversalContext?: TraversalContext): void {
  // The native runner may already own the exact final category; never recover
  // it from a served error or an unrelated call/observed/recovered attempt.
  if (traversalContext && !context.failureState.owns(error)) {
    context.failureState.capture(error, terminalCategory(error), traversalContext);
  }
}

/** The served form of a thrown value at any other report of a stage failure (retry, throttle). */
export function servedStageError(context: StageContext, error: unknown): StructuredErrorInfo {
  const rule = context.getRedactionRule();
  return rule ? rule.servedError(error) : extractErrorInfo(error);
}

/** What the logger is handed: the thrown value, or its masked form when the policy masked its text. */
export function loggableStageError(context: StageContext, error: unknown): unknown {
  const rule = context.getRedactionRule();
  return rule ? rule.loggableError(error) : error;
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
