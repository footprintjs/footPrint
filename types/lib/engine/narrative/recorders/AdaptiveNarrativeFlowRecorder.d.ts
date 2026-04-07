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
export declare class AdaptiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
    private readonly threshold;
    private readonly sampleRate;
    private totalPerTarget;
    private suppressedCount;
    constructor(threshold?: number, sampleRate?: number, id?: string);
    onLoop(event: FlowLoopEvent): void;
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount(): number;
    clear(): void;
}
