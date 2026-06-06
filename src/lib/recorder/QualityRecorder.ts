/**
 * QualityRecorder — per-step quality scoring keyed by runtimeStageId.
 *
 * Collects quality scores during traversal (accumulate pattern).
 * After execution, use qualityTrace() to backtrack from any low-scoring step.
 *
 * Composes a `KeyedStore<QualityEntry>` for O(1) lookup and standard operations
 * (Convention 1 — one purpose per recorder):
 *   - **Translate**: `getByKey('call-llm#5')` — quality at this step
 *   - **Accumulate**: progressive quality up to slider position
 *   - **Aggregate**: overall pipeline quality score
 *
 * @example
 * ```typescript
 * const quality = new QualityRecorder((runtimeStageId, context) => {
 *   // Custom scoring function — return { score: 0.0–1.0, factors? }
 *   if (context.stageName.includes('llm')) return { score: 0.7, factors: ['llm stage'] };
 *   return { score: 1.0 };
 * });
 * executor.attachScopeRecorder(quality);
 * await executor.run();
 *
 * // Per-step score
 * quality.getByKey('call-llm#5');  // { score: 0.7, stageName: 'CallLLM', factors: [...] }
 *
 * // Overall quality
 * quality.getOverallScore();  // 0.85
 *
 * // Lowest-scoring step
 * quality.getLowest();  // { runtimeStageId: 'call-llm#5', entry: { score: 0.7, ... } }
 * ```
 */

import type { ReadEvent, ScopeRecorder, StageEvent, WriteEvent } from '../scope/types.js';
import { KeyedStore } from './KeyedStore.js';
import type { RecorderOperation } from './RecorderOperation.js';

/** Per-step quality data stored by QualityRecorder. */
export interface QualityEntry {
  /** Human-readable stage name. */
  stageName: string;
  /** Stable stage identifier. */
  stageId: string;
  /** Quality score for this step (0.0 = worst, 1.0 = best). */
  score: number;
  /** What contributed to this score. */
  factors: string[];
  /** Keys read during this step (for backtracking). */
  keysRead: string[];
  /** Keys written during this step (for backtracking). */
  keysWritten: string[];
}

/**
 * Scoring function called at the end of each stage.
 * Receives the runtimeStageId, stage event, and a summary of reads/writes.
 * Return a score (0.0–1.0) and optional factors explaining the score.
 */
export type QualityScoringFn = (
  runtimeStageId: string,
  context: {
    stageName: string;
    stageId: string;
    keysRead: string[];
    keysWritten: string[];
    duration?: number;
  },
) => { score: number; factors?: string[] };

/** Options for QualityRecorder. */
export interface QualityRecorderOptions {
  /** ScopeRecorder ID. Defaults to auto-increment. */
  id?: string;
  /** Preferred UI operation. Defaults to 'accumulate' (progressive quality). */
  preferredOperation?: RecorderOperation;
}

export class QualityRecorder implements ScopeRecorder {
  private static _counter = 0;

  readonly id: string;
  readonly preferredOperation: RecorderOperation;
  /** 1:1 per-step storage (Convention 1 — composed, not inherited). */
  private readonly store = new KeyedStore<QualityEntry>();
  private readonly scoringFn: QualityScoringFn;

  // Per-stage buffers (reset on each stageStart)
  private currentRuntimeStageId = '';
  private currentStageId = '';
  private currentStageName = '';
  private currentKeysRead: string[] = [];
  private currentKeysWritten: string[] = [];

  constructor(scoringFn: QualityScoringFn, options?: QualityRecorderOptions) {
    this.scoringFn = scoringFn;
    this.id = options?.id ?? `quality-${++QualityRecorder._counter}`;
    this.preferredOperation = options?.preferredOperation ?? 'accumulate';
  }

  onStageStart(event: StageEvent): void {
    this.currentRuntimeStageId = event.runtimeStageId;
    this.currentStageId = event.stageId;
    this.currentStageName = event.stageName;
    this.currentKeysRead = [];
    this.currentKeysWritten = [];
  }

  onRead(event: ReadEvent): void {
    if (event.key) this.currentKeysRead.push(event.key);
  }

  onWrite(event: WriteEvent): void {
    this.currentKeysWritten.push(event.key);
  }

  onStageEnd(event: StageEvent): void {
    const { score, factors } = this.scoringFn(this.currentRuntimeStageId, {
      stageName: this.currentStageName,
      stageId: this.currentStageId,
      keysRead: this.currentKeysRead,
      keysWritten: this.currentKeysWritten,
      duration: event.duration,
    });

    this.store.set(this.currentRuntimeStageId, {
      stageName: this.currentStageName,
      stageId: this.currentStageId,
      score: Math.max(0, Math.min(1, score)),
      factors: factors ?? [],
      keysRead: [...this.currentKeysRead],
      keysWritten: [...this.currentKeysWritten],
    });
  }

  // ── Per-step query API (delegates to the composed store) ───────────────

  /** Translate: quality entry for a specific runtimeStageId. */
  getByKey(runtimeStageId: string): QualityEntry | undefined {
    return this.store.get(runtimeStageId);
  }

  /** All per-step quality entries as a read-only Map (insertion-ordered). */
  getMap(): ReadonlyMap<string, QualityEntry> {
    return this.store.getMap();
  }

  /** All per-step quality entries (insertion-ordered). */
  values(): QualityEntry[] {
    return this.store.values();
  }

  /** Number of scored steps. */
  get size(): number {
    return this.store.size;
  }

  /** Aggregate: reduce ALL scored steps to a single value. */
  aggregate<R>(fn: (acc: R, entry: QualityEntry, key: string) => R, initial: R): R {
    return this.store.aggregate(fn, initial);
  }

  /** Accumulate: reduce scored steps up to a slider position. */
  accumulate<R>(fn: (acc: R, entry: QualityEntry, key: string) => R, initial: R, keys?: ReadonlySet<string>): R {
    return this.store.accumulate(fn, initial, keys);
  }

  /** Overall quality score — average of all step scores. */
  getOverallScore(): number {
    if (this.store.size === 0) return 1.0;
    const total = this.store.aggregate((sum, e) => sum + e.score, 0);
    return total / this.store.size;
  }

  /** Find the lowest-scoring step. */
  getLowest(): { runtimeStageId: string; entry: QualityEntry } | undefined {
    let lowest: { runtimeStageId: string; entry: QualityEntry } | undefined;
    for (const [key, entry] of this.store.getMap()) {
      if (!lowest || entry.score < lowest.entry.score) {
        lowest = { runtimeStageId: key, entry };
      }
    }
    return lowest;
  }

  /** Progressive quality score up to a slider position. */
  getScoreUpTo(visibleKeys: ReadonlySet<string>): number {
    let count = 0;
    const total = this.store.accumulate(
      (sum, e) => {
        count++;
        return sum + e.score;
      },
      0,
      visibleKeys,
    );
    return count === 0 ? 1.0 : total / count;
  }

  toSnapshot() {
    const steps: Record<string, unknown> = {};
    for (const [key, value] of this.store.getMap()) {
      steps[key] = value;
    }
    return {
      name: 'Quality',
      description: 'Quality scores per execution step with backtracking support',
      preferredOperation: this.preferredOperation,
      data: {
        numericField: 'score',
        overallScore: this.getOverallScore(),
        lowestStep: this.getLowest()?.runtimeStageId,
        steps,
      },
    };
  }

  clear(): void {
    this.store.clear();
    this.currentRuntimeStageId = '';
    this.currentStageId = '';
    this.currentStageName = '';
    this.currentKeysRead = [];
    this.currentKeysWritten = [];
  }
}
