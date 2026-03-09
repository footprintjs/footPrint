/**
 * RLENarrativeFlowRecorder — Run-Length Encoding for consecutive identical loop targets.
 *
 * Instead of emitting one sentence per iteration, collapses consecutive loops
 * through the same target into a single "Looped N times through X" sentence.
 *
 * Best for: Simple retry loops where every iteration looks the same.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new RLENarrativeFlowRecorder());
 * // Instead of 50 "On pass N..." lines:
 * // "Looped through AskLLM 50 times (passes 1–50)."
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder';
import type { FlowLoopEvent } from '../types';

interface RunGroup {
  target: string;
  startIteration: number;
  endIteration: number;
  description?: string;
}

export class RLENarrativeFlowRecorder extends NarrativeFlowRecorder {
  private currentRun: RunGroup | null = null;
  private completedRuns: RunGroup[] = [];

  constructor(id?: string) {
    super(id ?? 'narrative-rle');
  }

  override onLoop(event: FlowLoopEvent): void {
    // Don't call super — we handle sentence generation ourselves

    if (this.currentRun && this.currentRun.target === event.target) {
      // Extend the current run
      this.currentRun.endIteration = event.iteration;
    } else {
      // Flush previous run and start new one
      if (this.currentRun) {
        this.completedRuns.push(this.currentRun);
      }
      this.currentRun = {
        target: event.target,
        startIteration: event.iteration,
        endIteration: event.iteration,
        description: event.description,
      };
    }
  }

  override getSentences(): string[] {
    // Flush any pending run
    const runs = [...this.completedRuns];
    if (this.currentRun) {
      runs.push(this.currentRun);
    }

    const base = super.getSentences();

    // Inject RLE summaries
    const summaries: string[] = [];
    for (const run of runs) {
      const count = run.endIteration - run.startIteration + 1;
      if (count === 1) {
        // Single iteration — emit normal sentence
        if (run.description) {
          summaries.push(`On pass ${run.startIteration}: ${run.description} again.`);
        } else {
          summaries.push(`On pass ${run.startIteration} through ${run.target}.`);
        }
      } else {
        summaries.push(
          `Looped through ${run.target} ${count} times (passes ${run.startIteration}–${run.endIteration}).`,
        );
      }
    }

    return [...base, ...summaries];
  }

  override clear(): void {
    super.clear();
    this.currentRun = null;
    this.completedRuns = [];
  }
}
