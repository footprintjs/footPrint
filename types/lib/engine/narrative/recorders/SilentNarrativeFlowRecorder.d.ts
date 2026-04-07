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
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';
export declare class SilentNarrativeFlowRecorder extends NarrativeFlowRecorder {
    private loopCounts;
    private loopOrder;
    constructor(id?: string);
    onLoop(event: FlowLoopEvent): void;
    getSentences(): string[];
    /** Returns the total loop count per target. */
    getLoopCounts(): Map<string, number>;
    clear(): void;
}
