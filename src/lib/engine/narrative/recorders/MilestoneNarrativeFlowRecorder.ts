/**
 * MilestoneNarrativeFlowRecorder — Emits every Nth iteration (milestones only).
 *
 * Best for: High-iteration loops where you want regular progress markers
 * without caring about individual iterations.
 *
 * @example
 * ```typescript
 * // Emit every 10th iteration
 * executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder(10));
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';

export class MilestoneNarrativeFlowRecorder extends NarrativeFlowRecorder {
  private readonly interval: number;
  private readonly alwaysEmitFirst: boolean;
  private suppressedCount = 0;

  /**
   * @param interval - Tell every `interval`-th pass.
   * @throws RangeError when `interval` is 0 or NaN: no pass number is a multiple of it, so every pass would be suppressed.
   */
  constructor(interval = 10, alwaysEmitFirst = true, id?: string) {
    super(id ?? 'narrative-milestone');
    if (interval === 0 || Number.isNaN(interval)) {
      throw new RangeError(`MilestoneNarrativeFlowRecorder: interval must not be 0 or NaN, got ${String(interval)}.`);
    }
    this.interval = interval;
    this.alwaysEmitFirst = alwaysEmitFirst;
  }

  override onLoop(event: FlowLoopEvent): void {
    if (this.alwaysEmitFirst && event.iteration === 1) {
      super.onLoop(event);
    } else if (event.iteration % this.interval === 0) {
      super.onLoop(event);
    } else {
      this.suppressedCount++;
    }
  }

  /** Returns the number of suppressed loop sentences. */
  getSuppressedCount(): number {
    return this.suppressedCount;
  }

  override clear(): void {
    super.clear();
    this.suppressedCount = 0;
  }
}
