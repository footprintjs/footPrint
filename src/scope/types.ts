/**
 * Scope Recorder Pattern - Type Definitions
 * ----------------------------------------------------------------------------
 * This module defines the core types for the composable Scope system with
 * pluggable Recorders. The architecture follows a composition-over-inheritance
 * pattern where Recorders are attached to Scope instances to observe operations.
 *
 * Key concepts:
 *   - Recorder: A pluggable observer that receives notifications about scope operations
 *   - Events: Typed payloads passed to recorder hooks with operation context
 *   - Scope: The runtime memory container that stages read from and write to
 *
 * @module scope/types
 */

import type { GlobalStore } from '../core/memory/GlobalStore';
import type { ExecutionHistory } from '../internal/history/ExecutionHistory';

// ============================================================================
// Event Types
// ============================================================================

/**
 * Base context passed to all recorder hooks with information about the operation.
 *
 * Every event includes this context to identify when and where the operation occurred.
 *
 * @property stageName - The name of the stage performing the operation
 * @property pipelineId - The unique identifier of the pipeline namespace
 * @property timestamp - Unix timestamp (ms) when the operation occurred
 */
export interface RecorderContext {
  /** The name of the stage performing the operation */
  stageName: string;
  /** The unique identifier of the pipeline namespace */
  pipelineId: string;
  /** Unix timestamp (ms) when the operation occurred */
  timestamp: number;
}

/**
 * Event emitted when a value is read from scope.
 *
 * Extends RecorderContext with details about the read operation.
 *
 * @property key - The key being read (optional for key-only reads)
 * @property value - The value that was read (may be undefined if not found)
 */
export interface ReadEvent extends RecorderContext {
  /** The key being read (optional for key-only reads) */
  key?: string;
  /** The value that was read (may be undefined if not found) */
  value: unknown;
}

/**
 * Event emitted when a value is written to scope (before commit).
 *
 * Extends RecorderContext with details about the write operation.
 *
 * @property key - The key being written to
 * @property value - The value being written
 * @property operation - The type of write: 'set' (overwrite) or 'update' (merge)
 */
export interface WriteEvent extends RecorderContext {
  /** The key being written to */
  key: string;
  /** The value being written */
  value: unknown;
  /** The type of write: 'set' (overwrite) or 'update' (merge) */
  operation: 'set' | 'update';
}

/**
 * Event emitted when staged writes are committed to GlobalStore.
 *
 * Contains all mutations that were applied in a single commit operation.
 *
 * @property mutations - Array of all mutations applied in this commit
 */
export interface CommitEvent extends RecorderContext {
  /** Array of all mutations applied in this commit */
  mutations: Array<{
    /** The key that was mutated */
    key: string;
    /** The value that was written */
    value: unknown;
    /** The type of mutation: 'set' (overwrite) or 'update' (merge) */
    operation: 'set' | 'update';
  }>;
}

/**
 * Event emitted when an error occurs during scope operations.
 *
 * Provides context about what operation failed and where.
 *
 * @property error - The error that occurred
 * @property operation - The type of operation that failed
 * @property key - The key involved in the failed operation (if applicable)
 */
export interface ErrorEvent extends RecorderContext {
  /** The error that occurred */
  error: Error;
  /** The type of operation that failed */
  operation: 'read' | 'write' | 'commit';
  /** The key involved in the failed operation (if applicable) */
  key?: string;
}

/**
 * Event emitted at stage lifecycle boundaries (start/end).
 *
 * Used to track stage execution timing and boundaries.
 *
 * @property duration - Elapsed time in ms (only present in onStageEnd)
 */
export interface StageEvent extends RecorderContext {
  /** Elapsed time in ms (only present in onStageEnd) */
  duration?: number;
}

// ============================================================================
// Recorder Interface
// ============================================================================

/**
 * Recorder interface - the contract for pluggable scope observers.
 *
 * All methods are optional to allow partial implementations. A recorder
 * can implement only the hooks it cares about (e.g., only onError for
 * error tracking, or only onStageStart/onStageEnd for timing).
 *
 * Recorders are invoked synchronously in attachment order. If a recorder
 * throws an error, it is caught and passed to onError hooks of other
 * recorders, but the scope operation continues normally.
 *
 * @example
 * ```typescript
 * // Minimal recorder that only tracks errors
 * const errorTracker: Recorder = {
 *   id: 'error-tracker',
 *   onError(event) {
 *     console.error(`Error in ${event.stageName}:`, event.error);
 *   }
 * };
 *
 * // Full recorder with all hooks
 * const fullRecorder: Recorder = {
 *   id: 'full-recorder',
 *   onRead(event) { ... },
 *   onWrite(event) { ... },
 *   onCommit(event) { ... },
 *   onError(event) { ... },
 *   onStageStart(event) { ... },
 *   onStageEnd(event) { ... },
 * };
 * ```
 */
export interface Recorder {
  /**
   * Unique identifier for this recorder instance.
   *
   * Used for detachment and debugging. Should be unique within a Scope.
   */
  readonly id: string;

  /**
   * Called when a value is read from scope.
   *
   * Invoked after the read operation completes, with the value that was read.
   *
   * @param event - Details about the read operation
   */
  onRead?(event: ReadEvent): void;

  /**
   * Called when a value is written to scope (before commit).
   *
   * Invoked for both setValue (operation: 'set') and updateValue (operation: 'update').
   * The write is staged in the WriteBuffer and not yet committed to GlobalStore.
   *
   * @param event - Details about the write operation
   */
  onWrite?(event: WriteEvent): void;

  /**
   * Called when staged writes are committed to GlobalStore.
   *
   * Invoked after the commit completes successfully. Contains all mutations
   * that were applied in this commit.
   *
   * @param event - Details about the commit operation
   */
  onCommit?(event: CommitEvent): void;

  /**
   * Called when an error occurs during scope operations.
   *
   * Also called when another recorder throws an error in its hook.
   *
   * @param event - Details about the error
   */
  onError?(event: ErrorEvent): void;

  /**
   * Called when a stage begins execution.
   *
   * Invoked at the start of stage processing, before any reads or writes.
   *
   * @param event - Stage context (duration not present at start)
   */
  onStageStart?(event: StageEvent): void;

  /**
   * Called when a stage completes execution.
   *
   * Invoked after all stage operations complete, including commit.
   * The duration field contains the elapsed time since onStageStart.
   *
   * @param event - Stage context with duration
   */
  onStageEnd?(event: StageEvent): void;
}

// ============================================================================
// Scope Types
// ============================================================================

/**
 * Snapshot of scope state at a point in time.
 *
 * Used for time-travel debugging to capture and restore state.
 *
 * @property index - The sequential index of this snapshot (0-based)
 * @property stageName - The stage that created this snapshot
 * @property pipelineId - The pipeline namespace
 * @property timestamp - Unix timestamp (ms) when the snapshot was created
 * @property state - The complete state at this point in time
 */
export interface ScopeSnapshot {
  /** The sequential index of this snapshot (0-based) */
  index: number;
  /** The stage that created this snapshot */
  stageName: string;
  /** The pipeline namespace */
  pipelineId: string;
  /** Unix timestamp (ms) when the snapshot was created */
  timestamp: number;
  /** The complete state at this point in time */
  state: Record<string, unknown>;
}

/**
 * Options for creating a Scope instance.
 *
 * @property pipelineId - The unique identifier for the pipeline namespace
 * @property stageName - The initial stage name
 * @property globalStore - The shared state container for persistence
 * @property executionHistory - Optional history tracker for time-travel support
 * @property recorders - Optional initial recorders to attach
 */
export interface ScopeOptions {
  /** The unique identifier for the pipeline namespace */
  pipelineId: string;
  /** The initial stage name */
  stageName: string;
  /** The shared state container for persistence */
  globalStore: GlobalStore;
  /** Optional history tracker for time-travel support */
  executionHistory?: ExecutionHistory;
  /** Optional initial recorders to attach */
  recorders?: Recorder[];
}
