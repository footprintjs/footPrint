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
 * // Basic — auto-generated unique ID
 * executor.attachRecorder(new MetricRecorder());
 *
 * // Two instances coexist (different auto IDs)
 * executor.attachRecorder(new MetricRecorder()); // metrics-1
 * executor.attachRecorder(new MetricRecorder()); // metrics-2
 *
 * // Override a framework-attached recorder with well-known ID
 * executor.attachRecorder(new MetricRecorder('metrics')); // replaces framework's
 * ```
 */

import type { CommitEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types.js';

export interface StageMetrics {
  stageName: string;
  readCount: number;
  writeCount: number;
  commitCount: number;
  totalDuration: number;
  invocationCount: number;
}

export interface AggregatedMetrics {
  totalDuration: number;
  totalReads: number;
  totalWrites: number;
  totalCommits: number;
  stageMetrics: Map<string, StageMetrics>;
}

export class MetricRecorder implements Recorder {
  private static _counter = 0;

  readonly id: string;
  private metrics: Map<string, StageMetrics> = new Map();
  private stageStartTimes: Map<string, number> = new Map();

  constructor(id?: string) {
    this.id = id ?? `metrics-${++MetricRecorder._counter}`;
  }

  onRead(event: ReadEvent): void {
    this.getOrCreateStageMetrics(event.stageName).readCount++;
  }

  onWrite(event: WriteEvent): void {
    this.getOrCreateStageMetrics(event.stageName).writeCount++;
  }

  onCommit(event: CommitEvent): void {
    this.getOrCreateStageMetrics(event.stageName).commitCount++;
  }

  onStageStart(event: StageEvent): void {
    this.stageStartTimes.set(event.stageName, event.timestamp);
    this.getOrCreateStageMetrics(event.stageName).invocationCount++;
  }

  onStageEnd(event: StageEvent): void {
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
        totalDuration: 0,
        invocationCount: 0,
      };
      this.metrics.set(stageName, stageMetrics);
    }
    return stageMetrics;
  }
}
