/**
 * ProgressiveNarrativeFlowRecorder — Exponentially decreasing detail as iterations grow.
 *
 * Emits at exponentially increasing intervals: 1, 2, 4, 8, 16, 32, ...
 * Gives rich detail for early iterations and progressively less as the loop continues.
 *
 * Best for: Convergence-style loops (gradient descent, iterative refinement)
 * where early iterations are most informative.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new ProgressiveNarrativeFlowRecorder());
 * // Emits: pass 1, 2, 4, 8, 16, 32, 64, 128...
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';

export class ProgressiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
  private readonly base: number;
  private suppressedCount = 0;

  /**
   * @param base - The exponential base. Default 2 means emit at 1, 2, 4, 8, 16...
   */
  constructor(base = 2, id?: string) {
    super(id ?? 'narrative-progressive');
    this.base = base;
  }

  override onLoop(event: FlowLoopEvent): void {
    if (this.shouldEmit(event.iteration)) {
      super.onLoop(event);
    } else {
      this.suppressedCount++;
    }
  }

  private shouldEmit(iteration: number): boolean {
    // Always emit iteration 1
    if (iteration === 1) return true;
    // Emit if iteration is a power of base
    let power = 1;
    while (power < iteration) {
      power *= this.base;
    }
    return power === iteration;
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
