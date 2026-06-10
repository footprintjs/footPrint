/**
 * summarize.ts — Cheap value summarization for `'summary'` retention.
 *
 * Extracted from `StageContext` (#14's `summarizeReadValue`) into a shared,
 * brand-parameterized helper so both snapshot-tracking dials (#14
 * `readTracking`, #13c-A `writeTracking`) — and later RFC-001's deferred
 * observer capture tier — produce identical summaries from ONE code path.
 *
 * Deliberately avoids every O(value) operation: no clone, no serialization.
 * See {@link ReadSummaryMarker} for the honest-cost contract.
 */

/** Max characters captured in a summary marker's `preview`. */
export const SUMMARY_PREVIEW_LENGTH = 80;

/**
 * Compat alias for {@link SUMMARY_PREVIEW_LENGTH} — the name shipped with
 * #14, kept so existing import paths (`memory/types`, the memory barrel)
 * stay valid. Same constant; reads and writes share one preview cap.
 */
export const READ_PREVIEW_LENGTH = SUMMARY_PREVIEW_LENGTH;

/** `typeof` result, refined to 'array' / 'null' for objects. */
export type SummaryValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'symbol'
  | 'function'
  | 'object'
  | 'array'
  | 'null';

/** Brand-free summary fields shared by both marker shapes. */
interface ValueSummary {
  /** `typeof` result, refined to 'array' / 'null' for objects. */
  type: SummaryValueType;
  /** Size proxy: string length, array length, or object key count. */
  size?: number;
  /** First {@link SUMMARY_PREVIEW_LENGTH} chars — primitives and strings only. */
  preview?: string;
}

/**
 * Marker recorded in `StageSnapshot.stageReads` under `readTracking: 'summary'`.
 *
 * Honest cost note: `size` is a cheap proxy (string length / array length /
 * object key count), NOT a serialized byte count — computing real byte size
 * would require an O(value) serialization, which is exactly the cost the
 * summary mode removes. `preview` is only produced for primitives and strings
 * (first {@link SUMMARY_PREVIEW_LENGTH} characters); objects and arrays carry
 * no preview for the same reason.
 */
export interface ReadSummaryMarker extends ValueSummary {
  /** Discriminant — lets snapshot consumers detect marker entries. */
  __readSummary: true;
}

/**
 * Marker recorded in `StageSnapshot.stageWrites` (and the commit observer's
 * mutations payload) under `writeTracking: 'summary'` (#13c-A). Same fields
 * and cost contract as {@link ReadSummaryMarker}; distinct brand so consumers
 * can tell which dial produced an entry.
 */
export interface WriteSummaryMarker extends ValueSummary {
  /** Discriminant — lets snapshot consumers detect marker entries. */
  __writeSummary: true;
}

/**
 * The one classification path both brands share — every per-type rule
 * (including the Map/Set real-entry-count handling) lives here exactly once.
 */
function classifyValue(value: unknown): ValueSummary {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') {
    return { type: 'string', size: value.length, preview: value.slice(0, SUMMARY_PREVIEW_LENGTH) };
  }
  if (Array.isArray(value)) return { type: 'array', size: value.length };
  if (value instanceof Map || value instanceof Set) {
    // Object.keys() on a Map/Set is always [] — report the real entry count.
    return { type: 'object', size: value.size };
  }
  if (typeof value === 'object') {
    return { type: 'object', size: Object.keys(value as Record<string, unknown>).length };
  }
  if (typeof value === 'function') return { type: 'function' };
  // number | boolean | bigint | symbol — String() is O(rendered length)
  return { type: typeof value as SummaryValueType, preview: String(value).slice(0, SUMMARY_PREVIEW_LENGTH) };
}

/**
 * Summarize a tracked READ for `readTracking: 'summary'` (#14). Byte-identical
 * output to the pre-extraction `StageContext`-local implementation.
 */
export function summarizeReadValue(value: unknown): ReadSummaryMarker {
  return { __readSummary: true, ...classifyValue(value) };
}

/**
 * Summarize a tracked WRITE for `writeTracking: 'summary'` (#13c-A). Sibling
 * of {@link summarizeReadValue} — same classification, distinct brand.
 */
export function summarizeWriteValue(value: unknown): WriteSummaryMarker {
  return { __writeSummary: true, ...classifyValue(value) };
}
