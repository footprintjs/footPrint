/**
 * WindowedNarrativeFlowRecorder — Shows first N and last M loop iterations, skips the middle.
 *
 * Best for: Moderate loops (10–200 iterations) where you want to see how it started
 * and how it ended, without the noise in between.
 *
 * When total iterations <= head + tail, all iterations are emitted (no compression).
 * When total > head + tail, the middle is replaced with a summary line.
 *
 * @example
 * ```typescript
 * // Show first 3 and last 2 iterations
 * executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2));
 * ```
 */

import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';

export class WindowedNarrativeFlowRecorder extends NarrativeFlowRecorder {
  private readonly head: number;
  private readonly tail: number;
  private loopEvents: Map<string, FlowLoopEvent[]> = new Map();

  constructor(head = 3, tail = 2, id?: string) {
    super(id ?? 'narrative-windowed');
    this.head = head;
    this.tail = tail;
  }

  override onLoop(event: FlowLoopEvent): void {
    // Accumulate all loop events — we'll render them in getSentences
    const key = event.target;
    let events = this.loopEvents.get(key);
    if (!events) {
      events = [];
      this.loopEvents.set(key, events);
    }
    events.push(event);

    // Don't call super — we handle all loop sentence generation in getSentences
  }

  override getSentences(): string[] {
    const baseSentences = super.getSentences();

    // Append windowed loop sentences for each target
    const result = [...baseSentences];
    for (const [, events] of this.loopEvents) {
      const total = events.length;

      if (total <= this.head + this.tail) {
        // Small loop — emit all iterations
        for (const ev of events) {
          result.push(this.formatLoopSentence(ev));
        }
      } else {
        // Large loop — head + skip summary + tail
        for (let i = 0; i < this.head; i++) {
          result.push(this.formatLoopSentence(events[i]));
        }
        const skipped = total - this.head - this.tail;
        result.push(`... (${skipped} iterations omitted)`);
        for (let i = total - this.tail; i < total; i++) {
          result.push(this.formatLoopSentence(events[i]));
        }
      }
    }

    return result;
  }

  /** Returns the number of suppressed loop sentences. */
  getSuppressedCount(): number {
    let total = 0;
    for (const [, events] of this.loopEvents) {
      if (events.length > this.head + this.tail) {
        total += events.length - this.head - this.tail;
      }
    }
    return total;
  }

  override clear(): void {
    super.clear();
    this.loopEvents.clear();
  }

  private formatLoopSentence(event: FlowLoopEvent): string {
    if (event.description) {
      return `On pass ${event.iteration}: ${event.description} again.`;
    }
    return `On pass ${event.iteration} through ${event.target}.`;
  }
}
