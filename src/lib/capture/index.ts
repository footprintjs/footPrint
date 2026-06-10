/* istanbul ignore file */
/**
 * capture/ — Shared value-capture / retention primitives (zero deps, leaf
 * module — `memory/` imports it, never the reverse).
 *
 * One home for "what do we keep about a tracked operation's value?":
 *   - `RetentionPolicy` — the `'full' | 'summary' | 'off'` family behind the
 *     #14 `readTracking` and #13c-A `writeTracking` dials.
 *   - `summarizeReadValue` / `summarizeWriteValue` — the parameterized
 *     summary-marker builders sharing one classification path.
 *
 * RFC-001 (deferred observer delivery) builds its capture tier on this
 * module — see the mapping notes in `policies.ts`.
 */

export type { RetentionPolicy } from './policies.js';
export type { ReadSummaryMarker, SummaryValueType, WriteSummaryMarker } from './summarize.js';
export { READ_PREVIEW_LENGTH, summarizeReadValue, summarizeWriteValue, SUMMARY_PREVIEW_LENGTH } from './summarize.js';
