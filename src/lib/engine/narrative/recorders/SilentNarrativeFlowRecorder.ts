/**
 * SilentNarrativeFlowRecorder — Suppresses all per-iteration loop sentences,
 * emits a single summary sentence at the end.
 *
 * Best for: Loops where iteration details are irrelevant and you only care
 * about the total count.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new SilentNarrativeFlowRecorder());
 * // Produces: "Looped 50 times through AskLLM."
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder';
import type { FlowLoopEvent } from '../types';

export class SilentNarrativeFlowRecorder extends NarrativeFlowRecorder {
  private loopCounts: Map<string, number> = new Map();
  private loopOrder: string[] = [];

  constructor(id?: string) {
    super(id ?? 'narrative-silent');
  }

  override onLoop(event: FlowLoopEvent): void {
    // Don't call super — suppress all per-iteration sentences
    const count = (this.loopCounts.get(event.target) ?? 0) + 1;
    if (!this.loopCounts.has(event.target)) {
      this.loopOrder.push(event.target);
    }
    this.loopCounts.set(event.target, count);
  }

  override getSentences(): string[] {
    const base = super.getSentences();

    // Inject loop summaries at the end (or you could insert them in-place)
    const summaries: string[] = [];
    for (const target of this.loopOrder) {
      const count = this.loopCounts.get(target)!;
      summaries.push(`Looped ${count} time${count !== 1 ? 's' : ''} through ${target}.`);
    }

    return [...base, ...summaries];
  }

  /** Returns the total loop count per target. */
  getLoopCounts(): Map<string, number> {
    return new Map(this.loopCounts);
  }

  override clear(): void {
    super.clear();
    this.loopCounts.clear();
    this.loopOrder = [];
  }
}
