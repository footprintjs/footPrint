/**
 * DebugRecorder - Development-focused recorder for detailed debugging information
 * ----------------------------------------------------------------------------
 * The DebugRecorder captures detailed debug information during execution for
 * troubleshooting issues during development and operational excellence (OE).
 *
 * Key features:
 *   - Track all errors that occur during scope operations
 *   - Track all mutations (writes and updates) with their values
 *   - Track reads in verbose mode
 *   - Configurable verbosity levels (minimal, verbose)
 *   - Filter entries by stage name
 *   - Clear recorded entries
 *
 * @module scope/recorders/DebugRecorder
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import type { ErrorEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Verbosity levels for DebugRecorder.
 *
 * - 'minimal': Only errors are recorded
 * - 'verbose': Errors, mutations, and reads are recorded
 *
 * Note: The design mentions 'normal' but the requirements (6.4, 6.7) specify
 * minimal and verbose. We implement minimal (errors only) and verbose (all).
 * In verbose mode, mutations are always recorded.
 */
export type DebugVerbosity = 'minimal' | 'verbose';

/**
 * Debug entry for a single operation.
 *
 * @property type - The type of operation recorded
 * @property stageName - The stage where the operation occurred
 * @property timestamp - Unix timestamp (ms) when the operation occurred
 * @property data - The event data associated with this entry
 */
export interface DebugEntry {
  /** The type of operation recorded */
  type: 'read' | 'write' | 'error' | 'stageStart' | 'stageEnd';
  /** The stage where the operation occurred */
  stageName: string;
  /** Unix timestamp (ms) when the operation occurred */
  timestamp: number;
  /** The event data associated with this entry */
  data: unknown;
}

/**
 * Options for creating a DebugRecorder instance.
 *
 * @property id - Optional unique identifier
 * @property verbosity - Initial verbosity level (defaults to 'verbose')
 */
export interface DebugRecorderOptions {
  /** Optional unique identifier */
  id?: string;
  /** Initial verbosity level (defaults to 'verbose') */
  verbosity?: DebugVerbosity;
}

// ============================================================================
// DebugRecorder Implementation
// ============================================================================

/**
 * DebugRecorder - captures detailed debug information for development and OE.
 *
 * This recorder implements the Recorder interface to observe scope operations
 * and collect debug information. It tracks:
 *   - All errors that occur during scope operations (always)
 *   - All mutations (writes and updates) with their values (in verbose mode)
 *   - All read operations (only in verbose mode)
 *   - Stage lifecycle events (stageStart/stageEnd)
 *
 * @example
 * ```typescript
 * const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
 * scope.attachRecorder(debugRecorder);
 *
 * // ... execute pipeline stages ...
 *
 * // Get all recorded entries
 * const entries = debugRecorder.getEntries();
 * console.log(`Total entries: ${entries.length}`);
 *
 * // Get only errors
 * const errors = debugRecorder.getErrors();
 * if (errors.length > 0) {
 *   console.error('Errors occurred:', errors);
 * }
 *
 * // Get entries for a specific stage
 * const stageEntries = debugRecorder.getEntriesForStage('processData');
 * console.log(`Stage entries: ${stageEntries.length}`);
 *
 * // Change verbosity
 * debugRecorder.setVerbosity('minimal');
 *
 * // Clear all entries
 * debugRecorder.clear();
 * ```
 */
export class DebugRecorder implements Recorder {
  /**
   * Unique identifier for this recorder instance.
   */
  readonly id: string;

  /**
   * All recorded debug entries.
   */
  private entries: DebugEntry[] = [];

  /**
   * Current verbosity level.
   */
  private verbosity: DebugVerbosity;

  /**
   * Creates a new DebugRecorder instance.
   *
   * @param options - Optional configuration options
   */
  constructor(options?: DebugRecorderOptions) {
    this.id = options?.id ?? `debug-recorder-${Date.now()}`;
    this.verbosity = options?.verbosity ?? 'verbose';
  }

  // ==========================================================================
  // Recorder Hooks
  // ==========================================================================

  /**
   * Called when a value is read from scope.
   *
   * Only records in verbose mode.
   *
   * @param event - Details about the read operation
   *
   * Requirements: 6.7
   */
  onRead(event: ReadEvent): void {
    // Only record reads in verbose mode
    if (this.verbosity !== 'verbose') {
      return;
    }

    this.entries.push({
      type: 'read',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: {
        key: event.key,
        value: event.value,
        pipelineId: event.pipelineId,
      },
    });
  }

  /**
   * Called when a value is written to scope.
   *
   * Records in verbose mode (mutations are tracked).
   *
   * @param event - Details about the write operation
   *
   * Requirements: 6.2, 6.3
   */
  onWrite(event: WriteEvent): void {
    // Only record writes in verbose mode
    if (this.verbosity !== 'verbose') {
      return;
    }

    this.entries.push({
      type: 'write',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: {
        key: event.key,
        value: event.value,
        operation: event.operation,
        pipelineId: event.pipelineId,
      },
    });
  }

  /**
   * Called when an error occurs during scope operations.
   *
   * Always records errors regardless of verbosity level.
   *
   * @param event - Details about the error
   *
   * Requirements: 6.1
   */
  onError(event: ErrorEvent): void {
    // Always record errors regardless of verbosity
    this.entries.push({
      type: 'error',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: {
        error: event.error,
        operation: event.operation,
        key: event.key,
        pipelineId: event.pipelineId,
      },
    });
  }

  /**
   * Called when a stage begins execution.
   *
   * Records stage start events in verbose mode.
   *
   * @param event - Stage context
   */
  onStageStart(event: StageEvent): void {
    // Only record stage events in verbose mode
    if (this.verbosity !== 'verbose') {
      return;
    }

    this.entries.push({
      type: 'stageStart',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: {
        pipelineId: event.pipelineId,
      },
    });
  }

  /**
   * Called when a stage completes execution.
   *
   * Records stage end events in verbose mode.
   *
   * @param event - Stage context with optional duration
   */
  onStageEnd(event: StageEvent): void {
    // Only record stage events in verbose mode
    if (this.verbosity !== 'verbose') {
      return;
    }

    this.entries.push({
      type: 'stageEnd',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: {
        pipelineId: event.pipelineId,
        duration: event.duration,
      },
    });
  }

  // ==========================================================================
  // Debug Access Methods
  // ==========================================================================

  /**
   * Returns all recorded debug entries.
   *
   * @returns Array of all debug entries in chronological order
   *
   * Requirements: 6.5
   *
   * @example
   * ```typescript
   * const entries = debugRecorder.getEntries();
   * for (const entry of entries) {
   *   console.log(`[${entry.type}] ${entry.stageName}: ${JSON.stringify(entry.data)}`);
   * }
   * ```
   */
  getEntries(): DebugEntry[] {
    // Return a copy to prevent external modification
    return [...this.entries];
  }

  /**
   * Returns all recorded error entries.
   *
   * @returns Array of error entries only
   *
   * Requirements: 6.1, 6.5
   *
   * @example
   * ```typescript
   * const errors = debugRecorder.getErrors();
   * if (errors.length > 0) {
   *   console.error(`${errors.length} errors occurred during execution`);
   *   for (const error of errors) {
   *     console.error(`  - ${error.stageName}: ${(error.data as any).error.message}`);
   *   }
   * }
   * ```
   */
  getErrors(): DebugEntry[] {
    return this.entries.filter((entry) => entry.type === 'error');
  }

  /**
   * Returns all entries for a specific stage.
   *
   * @param stageName - The name of the stage to filter by
   * @returns Array of entries for the specified stage
   *
   * Requirements: 6.6
   *
   * @example
   * ```typescript
   * const stageEntries = debugRecorder.getEntriesForStage('processData');
   * console.log(`Stage 'processData' had ${stageEntries.length} recorded operations`);
   *
   * // Count operations by type
   * const reads = stageEntries.filter(e => e.type === 'read').length;
   * const writes = stageEntries.filter(e => e.type === 'write').length;
   * console.log(`  Reads: ${reads}, Writes: ${writes}`);
   * ```
   */
  getEntriesForStage(stageName: string): DebugEntry[] {
    return this.entries.filter((entry) => entry.stageName === stageName);
  }

  /**
   * Sets the verbosity level for recording.
   *
   * - 'minimal': Only errors are recorded
   * - 'verbose': Errors, mutations, and reads are recorded
   *
   * Note: Changing verbosity only affects future recordings.
   * Existing entries are not modified.
   *
   * @param level - The new verbosity level
   *
   * Requirements: 6.4
   *
   * @example
   * ```typescript
   * // Start with verbose logging
   * debugRecorder.setVerbosity('verbose');
   *
   * // ... execute some stages ...
   *
   * // Switch to minimal for production-like behavior
   * debugRecorder.setVerbosity('minimal');
   * ```
   */
  setVerbosity(level: DebugVerbosity): void {
    this.verbosity = level;
  }

  /**
   * Clears all recorded entries.
   *
   * Use this to reset the recorder for a new execution run.
   *
   * @example
   * ```typescript
   * // After analyzing entries
   * const entries = debugRecorder.getEntries();
   * console.log(`Analyzed ${entries.length} entries`);
   *
   * // Clear for next run
   * debugRecorder.clear();
   *
   * // Verify cleared
   * console.log(debugRecorder.getEntries().length); // 0
   * ```
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Returns the current verbosity level.
   *
   * @returns The current verbosity level
   */
  getVerbosity(): DebugVerbosity {
    return this.verbosity;
  }
}
