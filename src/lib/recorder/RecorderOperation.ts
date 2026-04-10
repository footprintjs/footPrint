/**
 * RecorderOperation — the three standard operations on auto-collected traversal data.
 *
 * Data is collected during the single DFS traversal. The consumer chooses the
 * operation at READ time:
 *
 * | Operation   | KeyedRecorder method     | SequenceRecorder method        | Use case                    |
 * |-------------|--------------------------|--------------------------------|-----------------------------|
 * | Translate   | `getByKey(id)`           | `getEntriesForStep(id)`        | Per-step detail             |
 * | Accumulate  | `accumulate(fn, init, k)` | `accumulate(fn, init, k)`     | Running total up to slider  |
 * | Aggregate   | `aggregate(fn, init)`    | `aggregate(fn, init)`          | Grand total for dashboards  |
 *
 * Recorders declare a `preferredOperation` to hint the UI about which operation
 * to show prominently. The consumer can override via constructor options.
 *
 * @example
 * ```typescript
 * import { MetricRecorder, RecorderOperation } from 'footprintjs';
 *
 * // Use named constant (autocomplete)
 * new MetricRecorder({ preferredOperation: RecorderOperation.Aggregate });
 *
 * // Or inline string (same type)
 * new MetricRecorder({ preferredOperation: 'accumulate' });
 * ```
 */
export const RecorderOperation = {
  /** Per-step detail — what happened at this execution step? */
  Translate: 'translate',
  /** Progressive running total — value grows as the slider scrubs forward. */
  Accumulate: 'accumulate',
  /** Grand total across all steps — dashboard / export summary. */
  Aggregate: 'aggregate',
} as const;

export type RecorderOperation = (typeof RecorderOperation)[keyof typeof RecorderOperation];
