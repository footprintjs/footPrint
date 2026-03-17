/**
 * MetricRecorder — Production-focused recorder for timing and execution counts
 *
 * Tracks read/write/commit counts per stage and measures stage execution duration.
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
  readonly id: string;
  private metrics: Map<string, StageMetrics> = new Map();
  private stageStartTimes: Map<string, number> = new Map();

  constructor(id?: string) {
    this.id = id ?? `metric-recorder-${Date.now()}`;
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

  reset(): void {
    this.metrics.clear();
    this.stageStartTimes.clear();
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
