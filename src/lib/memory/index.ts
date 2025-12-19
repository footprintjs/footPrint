/* istanbul ignore file */
/**
 * memory/ — Foundation library (zero external deps beyond lodash)
 *
 * Transactional state management with namespace isolation,
 * atomic commits, and event-sourced time-travel.
 */

// Classes
export { SharedMemory } from './SharedMemory';
export { TransactionBuffer } from './TransactionBuffer';
export { EventLog } from './EventLog';
export { StageContext } from './StageContext';
export { DiagnosticCollector } from './DiagnosticCollector';

// Types
export type {
  MemoryPatch,
  TraceEntry,
  CommitBundle,
  FlowControlType,
  FlowMessage,
  StageSnapshot,
  ScopeFactory,
} from './types';

// Utilities
export {
  DELIM,
  deepSmartMerge,
  applySmartMerge,
  normalisePath,
  redactPatch,
  getNestedValue,
  setNestedValue,
  updateNestedValue,
  updateValue,
  getRunAndGlobalPaths,
} from './utils';
