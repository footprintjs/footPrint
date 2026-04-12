/**
 * QualityRecorder — per-step quality scoring keyed by runtimeStageId.
 *
 * Collects quality scores during traversal (accumulate pattern).
 * After execution, use qualityTrace() to backtrack from any low-scoring step.
 *
 * Extends KeyedRecorder<QualityEntry> for O(1) lookup and standard operations:
 *   - **Translate**: `getByKey('call-llm#5')` — quality at this step
 *   - **Accumulate**: progressive quality up to slider position
 *   - **Aggregate**: overall pipeline quality score
 *
 * @example
 * ```typescript
 * const quality = new QualityRecorder((runtimeStageId, event) => {
 *   // Custom scoring function — return 0.0–1.0
 *   if (event.stageName.includes('llm')) return 0.7;
 *   return 1.0;
 * });
 * executor.attachRecorder(quality);
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

import type { ReadEvent, Recorder, StageEvent, WriteEvent } from '../scope/types.js';
import { KeyedRecorder } from './KeyedRecorder.js';
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
  /** Recorder ID. Defaults to auto-increment. */
  id?: string;
  /** Preferred UI operation. Defaults to 'accumulate' (progressive quality). */
  preferredOperation?: RecorderOperation;
}

export class QualityRecorder extends KeyedRecorder<QualityEntry> implements Recorder {
  private static _counter = 0;

  readonly id: string;
  readonly preferredOperation: RecorderOperation;
  private readonly scoringFn: QualityScoringFn;

  // Per-stage buffers (reset on each stageStart)
  private currentRuntimeStageId = '';
  private currentStageId = '';
  private currentStageName = '';
  private currentKeysRead: string[] = [];
  private currentKeysWritten: string[] = [];

  constructor(scoringFn: QualityScoringFn, options?: QualityRecorderOptions) {
    super();
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

    this.store(this.currentRuntimeStageId, {
      stageName: this.currentStageName,
      stageId: this.currentStageId,
      score: Math.max(0, Math.min(1, score)),
      factors: factors ?? [],
      keysRead: [...this.currentKeysRead],
      keysWritten: [...this.currentKeysWritten],
    });
  }

  /** Overall quality score — average of all step scores. */
  getOverallScore(): number {
    if (this.size === 0) return 1.0;
    const total = this.aggregate((sum, e) => sum + e.score, 0);
    return total / this.size;
  }

  /** Find the lowest-scoring step. */
  getLowest(): { runtimeStageId: string; entry: QualityEntry } | undefined {
    let lowest: { runtimeStageId: string; entry: QualityEntry } | undefined;
    for (const [key, entry] of this.getMap()) {
      if (!lowest || entry.score < lowest.entry.score) {
        lowest = { runtimeStageId: key, entry };
      }
    }
    return lowest;
  }

  /** Progressive quality score up to a slider position. */
  getScoreUpTo(visibleKeys: ReadonlySet<string>): number {
    let count = 0;
    const total = this.accumulate(
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
    for (const [key, value] of this.getMap()) {
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

  override clear(): void {
    super.clear();
    this.currentRuntimeStageId = '';
    this.currentStageId = '';
    this.currentStageName = '';
    this.currentKeysRead = [];
    this.currentKeysWritten = [];
  }
}
