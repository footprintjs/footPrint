/**
 * SeparateNarrativeFlowRecorder — Collects loop iterations in a separate channel.
 *
 * Keeps the main narrative clean (no loop sentences) while preserving full
 * iteration detail in a separate accessor for consumers who need it.
 *
 * Best for: UIs or reports where loop detail is in a collapsible section,
 * or LLM pipelines where loop context should be available but not in the main prompt.
 *
 * @example
 * ```typescript
 * const recorder = new SeparateNarrativeFlowRecorder();
 * executor.attachFlowRecorder(recorder);
 * await executor.run();
 *
 * const mainNarrative = executor.getNarrative();     // No loop sentences
 * const loopDetail = recorder.getLoopSentences();    // All loop detail
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';

export class SeparateNarrativeFlowRecorder extends NarrativeFlowRecorder {
  private loopSentences: string[] = [];
  private loopCounts: Map<string, number> = new Map();

  constructor(id?: string) {
    super(id ?? 'narrative-separate');
  }

  override onLoop(event: FlowLoopEvent): void {
    // Don't call super — keep loops out of main narrative

    // Track count for summary
    const count = (this.loopCounts.get(event.target) ?? 0) + 1;
    this.loopCounts.set(event.target, count);

    // Store in separate channel
    if (event.description) {
      this.loopSentences.push(`On pass ${event.iteration}: ${event.description} again.`);
    } else {
      this.loopSentences.push(`On pass ${event.iteration} through ${event.target}.`);
    }
  }

  /** Returns all loop iteration sentences (the separate channel). */
  getLoopSentences(): string[] {
    return [...this.loopSentences];
  }

  /** Returns total loop count per target. */
  getLoopCounts(): Map<string, number> {
    return new Map(this.loopCounts);
  }

  override clear(): void {
    super.clear();
    this.loopSentences = [];
    this.loopCounts.clear();
  }
}
