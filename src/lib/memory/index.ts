/* istanbul ignore file */
/**
 * memory/ — Foundation library (zero external deps)
 *
 * Transactional state management with namespace isolation,
 * atomic commits, and event-sourced time-travel.
 */

// Classes
export { DiagnosticCollector } from './DiagnosticCollector.js';
export { EventLog } from './EventLog.js';
export { SharedMemory } from './SharedMemory.js';
export { StageContext } from './StageContext.js';
export { TransactionBuffer } from './TransactionBuffer.js';

// Redaction — the ONE owner of the verdict (9.19.0)
export type { RedactionVerdict } from './redaction.js';
export { RedactionRule, redactPatch } from './redaction.js';

// The run's policy — the four dials, the rule, the mirror flag as ONE object (F5)
export type { RunDials, RunPolicy } from './runPolicy.js';
export { DEFAULT_RUN_POLICY, runPolicy } from './runPolicy.js';

// Honesty — the ONE vocabulary for what a reader cannot see (F4a): code → the one sentence
export type { HonestyCode } from './honesty.js';
export { HONESTY_CODES } from './honesty.js';

// The two strings a redaction leaves where a value was (F4a; `REDACTED` is now `SCOPE_PLACEHOLDER`)
export { LOG_PLACEHOLDER, SCOPE_PLACEHOLDER } from './placeholders.js';

// Types
export type {
  CommitBundle,
  CommitValuesMode,
  FlowControlType,
  FlowMessage,
  MemoryPatch,
  ReadSummaryMarker,
  ReadTrackingMode,
  RetentionPolicy,
  ScopeFactory,
  StageSnapshot,
  TraceEntry,
  UntrackedSource,
  WriteSummaryMarker,
  WriteTrackingMode,
} from './types.js';
export { READ_PREVIEW_LENGTH, SUMMARY_PREVIEW_LENGTH } from './types.js';

// The verb law's refusal: a commit row whose verb is not set | merge | append | delete
export { UnknownVerbError } from './verbs.js';

// Utilities
export {
  applySmartMerge,
  deepSmartMerge,
  DELIM,
  getNestedValue,
  getRunAndGlobalPaths,
  normalisePath,
  pathSegments,
  setNestedValue,
  updateNestedValue,
  updateValue,
} from './utils.js';
