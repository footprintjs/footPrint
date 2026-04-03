/**
 * MetricRecorder — Production-focused recorder for timing and execution counts.
 *
 * Tracks read/write/commit counts per stage and measures stage execution duration.
 *
 * Each instance gets a unique auto-increment ID (`metrics-1`, `metrics-2`, ...),
 * so multiple recorders with different configs coexist. Pass an explicit ID to
 * override a specific instance (e.g., a framework-attached recorder).
 *
 * @example
 * ```typescript
 * // Track all stages (default)
 * executor.attachRecorder(new MetricRecorder());
 *
 * // Track only LLM-related stages
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => ['CallLLM', 'ParseResponse'].includes(name),
 * }));
 *
 * // Two recorders: one for LLM timing, one for everything else
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => name === 'CallLLM',
 * }));
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => name !== 'CallLLM',
 * }));
 *
 * // Override a framework-attached recorder by passing its well-known ID
 * executor.attachRecorder(new MetricRecorder({ id: 'metrics' }));
 * ```
 */

import type { CommitEvent, PauseEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types.js';

export interface StageMetrics {
  stageName: string;
  readCount: number;
  writeCount: number;
  commitCount: number;
  pauseCount: number;
  totalDuration: number;
  invocationCount: number;
}

export interface AggregatedMetrics {
  totalDuration: number;
  totalReads: number;
  totalWrites: number;
  totalCommits: number;
  totalPauses: number;
  stageMetrics: Map<string, StageMetrics>;
}

/** Options for MetricRecorder. All fields are optional. */
export interface MetricRecorderOptions {
  /** Recorder ID. Defaults to auto-increment (`metrics-1`, `metrics-2`, ...). */
  id?: string;
  /**
   * Filter which stages are recorded. Return `true` to record, `false` to skip.
   * When omitted, all stages are recorded.
   *
   * @example
   * ```typescript
   * // Only track stages that start with "Call"
   * stageFilter: (name) => name.startsWith('Call')
   * ```
   */
  stageFilter?: (stageName: string) => boolean;
}

export class MetricRecorder implements Recorder {
  private static _counter = 0;

  readonly id: string;
  private metrics: Map<string, StageMetrics> = new Map();
  private stageStartTimes: Map<string, number> = new Map();
  private stageFilter?: (stageName: string) => boolean;

  constructor(idOrOptions?: string | MetricRecorderOptions) {
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

  onRead(event: ReadEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.getOrCreateStageMetrics(event.stageName).readCount++;
  }

  onWrite(event: WriteEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.getOrCreateStageMetrics(event.stageName).writeCount++;
  }

  onCommit(event: CommitEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.getOrCreateStageMetrics(event.stageName).commitCount++;
  }

  onPause(event: PauseEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.getOrCreateStageMetrics(event.stageName).pauseCount++;
  }

  onStageStart(event: StageEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    this.stageStartTimes.set(event.stageName, event.timestamp);
    this.getOrCreateStageMetrics(event.stageName).invocationCount++;
  }

  onStageEnd(event: StageEvent): void {
    if (!this.shouldRecord(event.stageName)) return;
    const stageMetrics = this.getOrCreateStageMetrics(event.stageName);
    let duration: number;
    if (event.duration !== undefined) {
      duration = event.duration;
    } else {
      const startTime = this.stageStartTimes.get(event.stageName);
      duration = startTime !== undefined ? event.timestamp - startTime : 0;
    }
    stageMetrics.totalDuration += duration;
    this.stageStartTimes.delete(event.stageName);
  }

  getMetrics(): AggregatedMetrics {
    let totalDuration = 0;
    let totalReads = 0;
    let totalWrites = 0;
    let totalCommits = 0;
    let totalPauses = 0;

    for (const stageMetrics of this.metrics.values()) {
      totalDuration += stageMetrics.totalDuration;
      totalReads += stageMetrics.readCount;
      totalWrites += stageMetrics.writeCount;
      totalCommits += stageMetrics.commitCount;
      totalPauses += stageMetrics.pauseCount;
    }

    return {
      totalDuration,
      totalReads,
      totalWrites,
      totalCommits,
      totalPauses,
      stageMetrics: new Map(this.metrics),
    };
  }

  getStageMetrics(stageName: string): StageMetrics | undefined {
    const metrics = this.metrics.get(stageName);
    return metrics ? { ...metrics } : undefined;
  }

  toSnapshot(): { name: string; data: unknown } {
    const metrics = this.getMetrics();
    return {
      name: 'Metrics',
      data: {
        totalDuration: metrics.totalDuration,
        totalReads: metrics.totalReads,
        totalWrites: metrics.totalWrites,
        totalCommits: metrics.totalCommits,
        stages: Object.fromEntries(metrics.stageMetrics),
      },
    };
  }

  reset(): void {
    this.metrics.clear();
    this.stageStartTimes.clear();
  }

  clear(): void {
    this.reset();
  }

  private getOrCreateStageMetrics(stageName: string): StageMetrics {
    let stageMetrics = this.metrics.get(stageName);
    if (!stageMetrics) {
      stageMetrics = {
        stageName,
        readCount: 0,
        writeCount: 0,
        commitCount: 0,
        pauseCount: 0,
        totalDuration: 0,
        invocationCount: 0,
      };
      this.metrics.set(stageName, stageMetrics);
    }
    return stageMetrics;
  }
}
