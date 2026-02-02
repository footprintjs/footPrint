/**
 * MetricRecorder - Production-focused recorder for timing and execution counts
 * ----------------------------------------------------------------------------
 * The MetricRecorder captures timing data and execution counts for production
 * monitoring. It tracks read/write/commit operations per stage and measures
 * stage execution duration.
 *
 * Key features:
 *   - Track read/write/commit counts per stage
 *   - Track stage duration via onStageStart/onStageEnd
 *   - Aggregate metrics across all stages
 *   - Reset metrics to initial state
 *
 * @module scope/recorders/MetricRecorder
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import type { CommitEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Metrics collected for a single stage.
 *
 * @property stageName - The name of the stage
 * @property readCount - Number of read operations in this stage
 * @property writeCount - Number of write operations in this stage
 * @property commitCount - Number of commit operations in this stage
 * @property totalDuration - Total execution time in milliseconds
 * @property invocationCount - Number of times the stage was entered
 */
export interface StageMetrics {
  /** The name of the stage */
  stageName: string;
  /** Number of read operations in this stage */
  readCount: number;
  /** Number of write operations in this stage */
  writeCount: number;
  /** Number of commit operations in this stage */
  commitCount: number;
  /** Total execution time in milliseconds */
  totalDuration: number;
  /** Number of times the stage was entered */
  invocationCount: number;
}

/**
 * Aggregated metrics across all stages.
 *
 * @property totalDuration - Sum of all stage durations
 * @property totalReads - Sum of all read operations
 * @property totalWrites - Sum of all write operations
 * @property totalCommits - Sum of all commit operations
 * @property stageMetrics - Map of stage name to stage-specific metrics
 */
export interface AggregatedMetrics {
  /** Sum of all stage durations */
  totalDuration: number;
  /** Sum of all read operations */
  totalReads: number;
  /** Sum of all write operations */
  totalWrites: number;
  /** Sum of all commit operations */
  totalCommits: number;
  /** Map of stage name to stage-specific metrics */
  stageMetrics: Map<string, StageMetrics>;
}

// ============================================================================
// MetricRecorder Implementation
// ============================================================================

/**
 * MetricRecorder - captures timing and execution counts for production monitoring.
 *
 * This recorder implements the Recorder interface to observe scope operations
 * and collect metrics. It tracks:
 *   - Read/write/commit counts per stage
 *   - Stage execution duration
 *   - Stage invocation counts
 *
 * @example
 * ```typescript
 * const metricRecorder = new MetricRecorder('my-metrics');
 * scope.attachRecorder(metricRecorder);
 *
 * // ... execute pipeline stages ...
 *
 * const metrics = metricRecorder.getMetrics();
 * console.log(`Total reads: ${metrics.totalReads}`);
 * console.log(`Total duration: ${metrics.totalDuration}ms`);
 *
 * // Get metrics for a specific stage
 * const stageMetrics = metricRecorder.getStageMetrics('processData');
 * if (stageMetrics) {
 *   console.log(`Stage reads: ${stageMetrics.readCount}`);
 * }
 *
 * // Reset metrics for a new run
 * metricRecorder.reset();
 * ```
 */
export class MetricRecorder implements Recorder {
  /**
   * Unique identifier for this recorder instance.
   */
  readonly id: string;

  /**
   * Metrics collected per stage.
   */
  private metrics: Map<string, StageMetrics> = new Map();

  /**
   * Start times for stages currently in progress.
   * Used to calculate duration when onStageEnd is called.
   */
  private stageStartTimes: Map<string, number> = new Map();

  /**
   * Creates a new MetricRecorder instance.
   *
   * @param id - Optional unique identifier. Defaults to 'metric-recorder-{timestamp}'
   */
  constructor(id?: string) {
    this.id = id ?? `metric-recorder-${Date.now()}`;
  }

  // ==========================================================================
  // Recorder Hooks
  // ==========================================================================

  /**
   * Called when a value is read from scope.
   *
   * Increments the read count for the current stage.
   *
   * @param event - Details about the read operation
   *
   * Requirements: 5.2
   */
  onRead(event: ReadEvent): void {
    const stageMetrics = this.getOrCreateStageMetrics(event.stageName);
    stageMetrics.readCount++;
  }

  /**
   * Called when a value is written to scope.
   *
   * Increments the write count for the current stage.
   *
   * @param event - Details about the write operation
   *
   * Requirements: 5.3
   */
  onWrite(event: WriteEvent): void {
    const stageMetrics = this.getOrCreateStageMetrics(event.stageName);
    stageMetrics.writeCount++;
  }

  /**
   * Called when staged writes are committed.
   *
   * Increments the commit count for the current stage.
   *
   * @param event - Details about the commit operation
   *
   * Requirements: 5.4
   */
  onCommit(event: CommitEvent): void {
    const stageMetrics = this.getOrCreateStageMetrics(event.stageName);
    stageMetrics.commitCount++;
  }

  /**
   * Called when a stage begins execution.
   *
   * Records the start time for duration calculation.
   *
   * @param event - Stage context
   *
   * Requirements: 5.1
   */
  onStageStart(event: StageEvent): void {
    // Record start time for this stage
    this.stageStartTimes.set(event.stageName, event.timestamp);

    // Increment invocation count
    const stageMetrics = this.getOrCreateStageMetrics(event.stageName);
    stageMetrics.invocationCount++;
  }

  /**
   * Called when a stage completes execution.
   *
   * Calculates and stores the total execution time for the stage.
   * Uses the duration from the event if available, otherwise calculates
   * from the recorded start time.
   *
   * @param event - Stage context with optional duration
   *
   * Requirements: 5.1, 5.7
   */
  onStageEnd(event: StageEvent): void {
    const stageMetrics = this.getOrCreateStageMetrics(event.stageName);

    // Calculate duration
    let duration: number;
    if (event.duration !== undefined) {
      // Use duration from event if provided
      duration = event.duration;
    } else {
      // Calculate from recorded start time
      const startTime = this.stageStartTimes.get(event.stageName);
      if (startTime !== undefined) {
        duration = event.timestamp - startTime;
      } else {
        // No start time recorded, use 0
        duration = 0;
      }
    }

    // Add to total duration for this stage
    stageMetrics.totalDuration += duration;

    // Clean up start time
    this.stageStartTimes.delete(event.stageName);
  }

  // ==========================================================================
  // Metrics Access
  // ==========================================================================

  /**
   * Returns aggregated metrics across all stages.
   *
   * Calculates totals by summing metrics from all tracked stages.
   *
   * @returns Aggregated metrics including totals and per-stage breakdown
   *
   * Requirements: 5.5
   *
   * @example
   * ```typescript
   * const metrics = metricRecorder.getMetrics();
   * console.log(`Total reads: ${metrics.totalReads}`);
   * console.log(`Total writes: ${metrics.totalWrites}`);
   * console.log(`Total commits: ${metrics.totalCommits}`);
   * console.log(`Total duration: ${metrics.totalDuration}ms`);
   *
   * // Iterate over stage metrics
   * for (const [stageName, stageMetrics] of metrics.stageMetrics) {
   *   console.log(`${stageName}: ${stageMetrics.readCount} reads`);
   * }
   * ```
   */
  getMetrics(): AggregatedMetrics {
    let totalDuration = 0;
    let totalReads = 0;
    let totalWrites = 0;
    let totalCommits = 0;

    // Sum up metrics from all stages
    for (const stageMetrics of this.metrics.values()) {
      totalDuration += stageMetrics.totalDuration;
      totalReads += stageMetrics.readCount;
      totalWrites += stageMetrics.writeCount;
      totalCommits += stageMetrics.commitCount;
    }

    return {
      totalDuration,
      totalReads,
      totalWrites,
      totalCommits,
      // Return a copy of the map to prevent external modification
      stageMetrics: new Map(this.metrics),
    };
  }

  /**
   * Returns metrics for a specific stage.
   *
   * @param stageName - The name of the stage to get metrics for
   * @returns The stage metrics, or undefined if the stage has no recorded metrics
   *
   * Requirements: 5.5
   *
   * @example
   * ```typescript
   * const stageMetrics = metricRecorder.getStageMetrics('processData');
   * if (stageMetrics) {
   *   console.log(`Reads: ${stageMetrics.readCount}`);
   *   console.log(`Writes: ${stageMetrics.writeCount}`);
   *   console.log(`Duration: ${stageMetrics.totalDuration}ms`);
   * }
   * ```
   */
  getStageMetrics(stageName: string): StageMetrics | undefined {
    const metrics = this.metrics.get(stageName);
    if (!metrics) {
      return undefined;
    }

    // Return a copy to prevent external modification
    return { ...metrics };
  }

  /**
   * Resets all metrics to initial state.
   *
   * Clears all recorded metrics and stage start times. Use this to
   * start fresh for a new pipeline execution.
   *
   * Requirements: 5.6
   *
   * @example
   * ```typescript
   * // After a pipeline run
   * const metrics = metricRecorder.getMetrics();
   * console.log(`Run completed with ${metrics.totalReads} reads`);
   *
   * // Reset for next run
   * metricRecorder.reset();
   *
   * // Verify reset
   * const newMetrics = metricRecorder.getMetrics();
   * console.log(newMetrics.totalReads); // 0
   * ```
   */
  reset(): void {
    this.metrics.clear();
    this.stageStartTimes.clear();
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Gets or creates stage metrics for the given stage name.
   *
   * If metrics don't exist for the stage, creates a new entry with
   * all counts initialized to zero.
   *
   * @param stageName - The name of the stage
   * @returns The stage metrics object (mutable)
   */
  private getOrCreateStageMetrics(stageName: string): StageMetrics {
    let stageMetrics = this.metrics.get(stageName);

    if (!stageMetrics) {
      stageMetrics = {
        stageName,
        readCount: 0,
        writeCount: 0,
        commitCount: 0,
        totalDuration: 0,
        invocationCount: 0,
      };
      this.metrics.set(stageName, stageMetrics);
    }

    return stageMetrics;
  }
}
