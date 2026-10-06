/**
 * stageError — the ONE place a failed stage's error is recorded and served.
 *
 * Writes `errors.stageExecutionError` through the diagnostic collector (which
 * applies the run's diagnostic policy) and hands back the form `onError` is
 * served: the same retained text, decided once, so the narrative, flow events
 * and recorder rows never see what the policy masked. The linear, decider and
 * selector error paths all call it.
 */

import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import { extractErrorInfo, thrownText } from '../../errors/errorInfo.js';
import type { StageContext } from '../../memory/StageContext.js';

export function recordStageError(
  context: StageContext,
  error: unknown,
): { message: string; structuredError: StructuredErrorInfo } {
  const text = thrownText(error);
  const kept = context.addDiagnostic('errors', 'stageExecutionError', text);
  const rule = context.getRedactionRule();
  return rule ? rule.retainStageError(error, text, kept) : { message: text, structuredError: extractErrorInfo(error) };
}
