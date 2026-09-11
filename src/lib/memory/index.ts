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
export { REDACTED, RedactionRule } from './redaction.js';

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

// Utilities
export {
  applySmartMerge,
  deepSmartMerge,
  DELIM,
  getNestedValue,
  getRunAndGlobalPaths,
  normalisePath,
  pathSegments,
  redactPatch,
  setNestedValue,
  updateNestedValue,
  updateValue,
} from './utils.js';
