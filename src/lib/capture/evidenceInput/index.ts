import { copyHistoryData } from '../historyData.js';

/** Fixed default admission budget for the raw projection before privacy can reduce it. */
export const MAX_CAPTURE_INPUT_BYTES = 1024 * 1024;

/** @internal Freeze one bounded detached data projection before any privacy operation reads it. */
export function copyEvidenceInput(value: unknown, maxBytes = MAX_CAPTURE_INPUT_BYTES): unknown {
  return copyHistoryData(value, maxBytes, { preserveObjectUndefined: true });
}
