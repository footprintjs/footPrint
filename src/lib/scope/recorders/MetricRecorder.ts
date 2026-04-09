/**
 * MetricRecorder — per-step timing and execution counts, keyed by runtimeStageId.
 *
 * Stores per-invocation data during traversal. Aggregated views computed on read.
 * Extends KeyedRecorder<StepMetrics> for O(1) lookup and standard operations.
 *
 * @example
 * ```typescript
 * const metric = new MetricRecorder();
 * executor.attachRecorder(metric);
 * await executor.run();
 *
 * // Per-step (time-travel):
 * metric.getByKey('call-llm#5');  // { stageName, readCount, writeCount, duration }
 *
 * // Aggregated (backward compat):
 * metric.getMetrics();  // { totalDuration, totalReads, stageMetrics: Map<stageName, aggregated> }
 *
 * // Progressive (slider):
 * metric.accumulate((sum, m) => sum + m.duration, 0, visibleKeys);
 * ```
 */

import { KeyedRecorder } from '../../recorder/KeyedRecorder.js';
import type { CommitEvent, PauseEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types.js';

/** Per-invocation metrics for a single execution step. */
export interface StepMetrics {
  /** Human-readable stage name. */
  stageName: string;
  /** Number of scope reads during this invocation. */
  readCount: number;
  /** Number of scope writes during this invocation. */
  writeCount: number;
  /** Number of commits during this invocation. */
  commitCount: number;
  /** Number of pauses during this invocation. */
  pauseCount: number;
  /** Duration in ms for this invocation. */
  duration: number;
}

/** Aggregated metrics across all invocations (backward compatible). */
export interface AggregatedMetrics {
  totalDuration: number;
  totalReads: number;
  totalWrites: number;
  totalCommits: number;
  totalPauses: number;
  /** Aggregated by stageName — sums across loop invocations. */
  stageMetrics: Map<string, StageMetrics>;
}

/** Aggregated per-stageName (backward compatible with pre-runtimeStageId API). */
export interface StageMetrics {
  stageName: string;
  readCount: number;
  writeCount: number;
  commitCount: number;
  pauseCount: number;
  totalDuration: number;
  invocationCount: number;
}

/** Options for MetricRecorder. */
export interface MetricRecorderOptions {
  /** Recorder ID. Defaults to auto-increment (`metrics-1`, `metrics-2`, ...). */
  id?: string;
  /** Filter which stages are recorded. Return `true` to record, `false` to skip. */
  stageFilter?: (stageName: string) => boolean;
}

export class MetricRecorder extends KeyedRecorder<StepMetrics> implements Recorder {
  private static _counter = 0;

  readonly id: string;
  private stageStartTimes = new Map<string, number>();
  private currentRuntimeStageId = '';
  private stageFilter?: (stageName: string) => boolean;

  constructor(idOrOptions?: string | MetricRecorderOptions) {
    super();
    if (typeof idOrOptions === 'string') {
      this.id = idOrOptions;
    } else {
      this.id = idOrOptions?.id ?? `metrics-${++MetricRecorder._counter}`;
      this.stageFilter = idOrOptions?.stageFilter;
    }
  }

  private shouldRecord(stageName: string): boolean {
    return !this.stageFilter || this.stageFilter(stageName);
  }

  /** Get or create the StepMetrics for the current stage. */
  private current(): StepMetrics {
    const key = this.currentRuntimeStageId;
    let m = this.getByKey(key);
    if (!m) {
      m = { stageName: '', readCount: 0, writeCount: 0, commitCount: 0, pauseCount: 0, duration: 0 };
      this.store(key, m);
    }
    return m;
  }

  onStageStart(event: StageEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.currentRuntimeStageId = event.runtimeStageId;
    this.stageStartTimes.set(event.runtimeStageId, event.timestamp);
    const m = this.current();
    m.stageName = event.stageName;
  }

  onRead(event: ReadEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.current().readCount++;
  }

  onWrite(event: WriteEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.current().writeCount++;
  }

  onCommit(event: CommitEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.current().commitCount++;
  }

  onPause(event: PauseEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.current().pauseCount++;
  }

  onStageEnd(event: StageEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    const m = this.current();
    if (event.duration !== undefined) {
      m.duration = event.duration;
    } else {
      const startTime = this.stageStartTimes.get(event.runtimeStageId);
      m.duration = startTime !== undefined ? event.timestamp - startTime : 0;
    }
    this.stageStartTimes.delete(event.runtimeStageId);
  }

  /** Aggregated metrics — computes totals on the fly from per-step data (backward compatible). */
  getMetrics(): AggregatedMetrics {
    const byName = new Map<string, StageMetrics>();

    const totalDuration = this.aggregate((sum, m) => sum + m.duration, 0);
    const totalReads = this.aggregate((sum, m) => sum + m.readCount, 0);
    const totalWrites = this.aggregate((sum, m) => sum + m.writeCount, 0);
    const totalCommits = this.aggregate((sum, m) => sum + m.commitCount, 0);
    const totalPauses = this.aggregate((sum, m) => sum + m.pauseCount, 0);

    // Group by stageName for backward compat
    for (const m of this.values()) {
      const existing = byName.get(m.stageName);
      if (existing) {
        existing.readCount += m.readCount;
        existing.writeCount += m.writeCount;
        existing.commitCount += m.commitCount;
        existing.pauseCount += m.pauseCount;
        existing.totalDuration += m.duration;
        existing.invocationCount++;
      } else {
        byName.set(m.stageName, {
          stageName: m.stageName,
          readCount: m.readCount,
          writeCount: m.writeCount,
          commitCount: m.commitCount,
          pauseCount: m.pauseCount,
          totalDuration: m.duration,
          invocationCount: 1,
        });
      }
    }

    return { totalDuration, totalReads, totalWrites, totalCommits, totalPauses, stageMetrics: byName };
  }

  /** Get aggregated metrics for a specific stage name (backward compatible). */
  getStageMetrics(stageName: string): StageMetrics | undefined {
    const metrics = this.getMetrics();
    return metrics.stageMetrics.get(stageName);
  }

  /** Snapshot for serialization. */
  toSnapshot(): { name: string; description: string; data: unknown } {
    const metrics = this.getMetrics();
    return {
      name: 'Metrics',
      description: 'Aggregator (KeyedRecorder) — per-step timing and I/O counts',
      data: {
        totalDuration: metrics.totalDuration,
        totalReads: metrics.totalReads,
        totalWrites: metrics.totalWrites,
        totalCommits: metrics.totalCommits,
        stages: Object.fromEntries(metrics.stageMetrics),
      },
    };
  }

  /** Clear all state — called by executor before each run(). */
  override clear(): void {
    super.clear();
    this.stageStartTimes.clear();
    this.currentRuntimeStageId = '';
  }

  /** Alias for clear() (backward compat). */
  reset(): void {
    this.clear();
  }
}
