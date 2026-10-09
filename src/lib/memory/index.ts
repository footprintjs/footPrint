/** Engine frame, diagnostics, run policy and redaction. Record primitives belong to foottrace. */

export type { RetentionPolicy } from '../capture/policies.js';
export type { ReadSummaryMarker, WriteSummaryMarker } from '../capture/summarize.js';
export { DiagnosticCollector } from './DiagnosticCollector.js';
export type { FlowControlType, FlowMessage, ReadTrackingMode, StageSnapshot, WriteTrackingMode } from './frameTypes.js';
export type { RedactionVerdict } from './redaction.js';
export { RedactionRule } from './redaction.js';
export { SCOPE_PLACEHOLDER } from './redaction.js';
export type { RunDials, RunPolicy } from './runPolicy.js';
export { DEFAULT_RUN_POLICY, runPolicy } from './runPolicy.js';
export { StageContext } from './StageContext.js';
