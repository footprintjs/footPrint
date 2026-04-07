/**
 * memory/ — Foundation library (zero external deps)
 *
 * Transactional state management with namespace isolation,
 * atomic commits, and event-sourced time-travel.
 */
export { DiagnosticCollector } from './DiagnosticCollector.js';
export { EventLog } from './EventLog.js';
export { SharedMemory } from './SharedMemory.js';
export { StageContext } from './StageContext.js';
export { TransactionBuffer } from './TransactionBuffer.js';
export type { CommitBundle, FlowControlType, FlowMessage, MemoryPatch, ScopeFactory, StageSnapshot, TraceEntry, } from './types.js';
export { applySmartMerge, deepSmartMerge, DELIM, getNestedValue, getRunAndGlobalPaths, normalisePath, redactPatch, setNestedValue, updateNestedValue, updateValue, } from './utils.js';
