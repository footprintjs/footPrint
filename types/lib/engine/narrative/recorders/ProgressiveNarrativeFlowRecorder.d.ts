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
export declare class ProgressiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
    private readonly base;
    private suppressedCount;
    /**
     * @param base - The exponential base. Default 2 means emit at 1, 2, 4, 8, 16...
     */
    constructor(base?: number, id?: string);
    onLoop(event: FlowLoopEvent): void;
    private shouldEmit;
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount(): number;
    clear(): void;
}
