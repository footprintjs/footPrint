/* istanbul ignore file */
/**
 * memory/ — Foundation library (zero external deps beyond lodash)
 *
 * Transactional state management with namespace isolation,
 * atomic commits, and event-sourced time-travel.
 */

// Classes
export { DiagnosticCollector } from './DiagnosticCollector';
export { EventLog } from './EventLog';
export { SharedMemory } from './SharedMemory';
export { StageContext } from './StageContext';
export { TransactionBuffer } from './TransactionBuffer';

// Types
export type {
  CommitBundle,
  FlowControlType,
  FlowMessage,
  MemoryPatch,
  ScopeFactory,
  StageSnapshot,
  TraceEntry,
} from './types';

// Utilities
export {
  applySmartMerge,
  deepSmartMerge,
  DELIM,
  getNestedValue,
  getRunAndGlobalPaths,
  normalisePath,
  redactPatch,
  setNestedValue,
  updateNestedValue,
  updateValue,
} from './utils';
