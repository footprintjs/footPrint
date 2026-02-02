/**
 * Scope Recorders - Barrel Export
 * ----------------------------------------------------------------------------
 * This module provides a single entry point for all recorder-related exports.
 * Consumers can import everything they need from this location:
 *
 * @example
 * ```typescript
 * import {
 *   Recorder,
 *   MetricRecorder,
 *   DebugRecorder,
 *   ReadEvent,
 *   WriteEvent,
 *   CommitEvent,
 *   ErrorEvent,
 *   StageEvent,
 *   RecorderContext,
 * } from './scope/recorders';
 * ```
 *
 * @module scope/recorders
 *
 * Requirements: 7.1 - Recorder interface is exported for consumer implementation
 */

// ============================================================================
// Recorder Interface and Event Types
// ============================================================================

/**
 * Re-export the Recorder interface for consumer implementation.
 * Consumers can implement this interface to create custom domain-specific
 * recorders (e.g., LLMRecorder, APIRecorder).
 */
export type { Recorder } from '../types';

/**
 * Re-export all event types for consumer use.
 * These types are passed to recorder hooks and provide context about
 * scope operations.
 */
export type {
  RecorderContext,
  ReadEvent,
  WriteEvent,
  CommitEvent,
  ErrorEvent,
  StageEvent,
} from '../types';

// ============================================================================
// Library-Provided Recorders
// ============================================================================

/**
 * MetricRecorder - Production-focused recorder for timing and execution counts.
 * Tracks read/write/commit counts per stage and measures stage execution duration.
 */
export { MetricRecorder } from './MetricRecorder';
export type { StageMetrics, AggregatedMetrics } from './MetricRecorder';

/**
 * DebugRecorder - Development-focused recorder for detailed debugging information.
 * Captures errors, mutations, and verbose logs for troubleshooting.
 */
export { DebugRecorder } from './DebugRecorder';
export type { DebugVerbosity, DebugEntry, DebugRecorderOptions } from './DebugRecorder';
