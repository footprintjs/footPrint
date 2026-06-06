/**
 * MetricRecorder — per-step timing and execution counts, keyed by runtimeStageId.
 *
 * Stores per-invocation data during traversal. Aggregated views computed on read.
 * Composes a `KeyedStore<StepMetrics>` for O(1) lookup and standard operations
 * (Convention 1 — one purpose per recorder: this is the ScopeRecorder; the store
 * is the storage).
 *
 * @example
 * ```typescript
 * const metric = new MetricRecorder();
 * executor.attachScopeRecorder(metric);
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

import { KeyedStore } from '../../recorder/KeyedStore.js';
import type { RecorderOperation } from '../../recorder/RecorderOperation.js';
import type { CommitEvent, PauseEvent, ReadEvent, ScopeRecorder, StageEvent, WriteEvent } from '../types.js';

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
  /** ScopeRecorder ID. Defaults to auto-increment (`metrics-1`, `metrics-2`, ...). */
  id?: string;
  /** Filter which stages are recorded. Return `true` to record, `false` to skip. */
  stageFilter?: (stageName: string) => boolean;
  /** Preferred UI operation. Defaults to 'aggregate' (dashboard totals). */
  preferredOperation?: RecorderOperation;
}

export class MetricRecorder implements ScopeRecorder {
  private static _counter = 0;

  readonly id: string;
  readonly preferredOperation: RecorderOperation;
  /** 1:1 per-step storage (Convention 1 — composed, not inherited). */
  private readonly store = new KeyedStore<StepMetrics>();
  private stageStartTimes = new Map<string, number>();
  private currentRuntimeStageId = '';
  private stageFilter?: (stageName: string) => boolean;

  constructor(idOrOptions?: string | MetricRecorderOptions) {
    if (typeof idOrOptions === 'string') {
      this.id = idOrOptions;
      this.preferredOperation = 'aggregate';
    } else {
      this.id = idOrOptions?.id ?? `metrics-${++MetricRecorder._counter}`;
      this.stageFilter = idOrOptions?.stageFilter;
      this.preferredOperation = idOrOptions?.preferredOperation ?? 'aggregate';
    }
  }

  private shouldRecord(stageName: string): boolean {
    return !this.stageFilter || this.stageFilter(stageName);
  }

  /** Get or create the StepMetrics for the current stage. */
  private current(): StepMetrics {
    const key = this.currentRuntimeStageId;
    let m = this.store.get(key);
    if (!m) {
      m = { stageName: '', readCount: 0, writeCount: 0, commitCount: 0, pauseCount: 0, duration: 0 };
      this.store.set(key, m);
    }
    return m;
  }

  // ── Per-step query API (delegates to the composed store) ───────────────

  /** Translate: per-step metrics by runtimeStageId. */
  getByKey(runtimeStageId: string): StepMetrics | undefined {
    return this.store.get(runtimeStageId);
  }

  /** All per-step metrics as a read-only Map (insertion-ordered). */
  getMap(): ReadonlyMap<string, StepMetrics> {
    return this.store.getMap();
  }

  /** All per-step metrics (insertion-ordered). */
  values(): StepMetrics[] {
    return this.store.values();
  }

  /** Number of recorded steps. */
  get size(): number {
    return this.store.size;
  }

  /** Aggregate: reduce ALL steps to a single value (dashboards, totals). */
  aggregate<R>(fn: (acc: R, entry: StepMetrics, key: string) => R, initial: R): R {
    return this.store.aggregate(fn, initial);
  }

  /** Accumulate: reduce steps up to a slider position (progressive view). */
  accumulate<R>(fn: (acc: R, entry: StepMetrics, key: string) => R, initial: R, keys?: ReadonlySet<string>): R {
    return this.store.accumulate(fn, initial, keys);
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

  toSnapshot() {
    const metrics = this.getMetrics();
    // Expose per-step data keyed by runtimeStageId (for time-travel UI)
    // alongside the aggregated totals
    const steps: Record<string, unknown> = {};
    for (const [key, value] of this.getMap()) {
      steps[key] = value;
    }
    return {
      name: 'Metrics',
      description: 'Aggregator (KeyedStore) — per-step timing and I/O counts',
      preferredOperation: this.preferredOperation,
      data: {
        numericField: 'readCount',
        grandTotal: metrics.totalReads,
        totalDuration: metrics.totalDuration,
        totalReads: metrics.totalReads,
        totalWrites: metrics.totalWrites,
        totalCommits: metrics.totalCommits,
        totalPauses: metrics.totalPauses,
        steps,
      },
    };
  }

  /** Clear all state — called by executor before each run(). */
  clear(): void {
    this.store.clear();
    this.stageStartTimes.clear();
    this.currentRuntimeStageId = '';
  }

  /** Alias for clear() (backward compat). */
  reset(): void {
    this.clear();
  }
}
