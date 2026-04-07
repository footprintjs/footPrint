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
export declare class WindowedNarrativeFlowRecorder extends NarrativeFlowRecorder {
    private readonly head;
    private readonly tail;
    private loopEvents;
    constructor(head?: number, tail?: number, id?: string);
    onLoop(event: FlowLoopEvent): void;
    getSentences(): string[];
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount(): number;
    clear(): void;
    private formatLoopSentence;
}
