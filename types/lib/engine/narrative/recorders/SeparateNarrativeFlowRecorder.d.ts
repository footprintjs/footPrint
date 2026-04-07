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
export declare class SeparateNarrativeFlowRecorder extends NarrativeFlowRecorder {
    private loopSentences;
    private loopCounts;
    constructor(id?: string);
    onLoop(event: FlowLoopEvent): void;
    /** Returns all loop iteration sentences (the separate channel). */
    getLoopSentences(): string[];
    /** Returns total loop count per target. */
    getLoopCounts(): Map<string, number>;
    clear(): void;
}
