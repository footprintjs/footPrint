/**
 * Internal History Module
 * 
 * WHY: This module contains internal implementation details for execution
 * history tracking. These are NOT part of the public API and may change.
 * 
 * EXPORTS:
 * - ExecutionHistory: Time-travel snapshot storage for pipeline execution
 * 
 * CONSUMERS:
 * - GlobalStore uses ExecutionHistory for time-travel debugging
 * - Debug UI uses commit bundles for visualization
 * 
 * WARNING: Do not import from this module directly in consumer code.
 * Use the public API from 'core/memory/' instead.
 */

export {
  ExecutionHistory,
  type TraceItem,
  type CommitBundle,
} from './ExecutionHistory';
