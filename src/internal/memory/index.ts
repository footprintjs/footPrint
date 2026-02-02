/**
 * Internal Memory Module
 * 
 * WHY: This module contains internal implementation details for the memory
 * system. These are NOT part of the public API and may change without notice.
 * 
 * EXPORTS:
 * - WriteBuffer: Transactional write buffer for stage mutations
 * - Memory utilities: Helper functions for nested object manipulation
 * 
 * CONSUMERS:
 * - StageContext uses WriteBuffer for stage-scoped mutations
 * - GlobalStore uses utilities for state access
 * 
 * WARNING: Do not import from this module directly in consumer code.
 * Use the public API from 'core/memory/' instead.
 */

// WriteBuffer - Transactional write buffer
export {
  WriteBuffer,
  PatchedMemoryContext, // Legacy alias
  applySmartMerge,
  DELIM,
  type MemoryPatch,
} from './WriteBuffer';

// Memory utilities
export {
  setNestedValue,
  updateNestedValue,
  updateValue,
  getNestedValue,
  getPipelineAndGlobalPaths,
  redactPatch,
} from './utils';
