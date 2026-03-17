/**
 * AdaptiveNarrativeFlowRecorder — Full detail until threshold, then samples every Nth.
 *
 * Best for: Unknown loop counts where you want full detail for short loops
 * but automatic compression for long ones.
 *
 * @example
 * ```typescript
 * // Full detail for first 5, then every 10th iteration
 * executor.attachFlowRecorder(new AdaptiveNarrativeFlowRecorder(5, 10));
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';

export class AdaptiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
  private readonly threshold: number;
  private readonly sampleRate: number;
  private totalPerTarget: Map<string, number> = new Map();
  private suppressedCount = 0;

  constructor(threshold = 5, sampleRate = 10, id?: string) {
    super(id ?? 'narrative-adaptive');
    this.threshold = threshold;
    this.sampleRate = sampleRate;
  }

  override onLoop(event: FlowLoopEvent): void {
    const count = (this.totalPerTarget.get(event.target) ?? 0) + 1;
    this.totalPerTarget.set(event.target, count);

    if (event.iteration <= this.threshold) {
      // Full detail phase
      super.onLoop(event);
    } else if ((event.iteration - this.threshold) % this.sampleRate === 0) {
      // Sample phase — emit every Nth
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
    this.totalPerTarget.clear();
    this.suppressedCount = 0;
  }
}
