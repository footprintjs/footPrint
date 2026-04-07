/**
 * MilestoneNarrativeFlowRecorder — Emits every Nth iteration (milestones only).
 *
 * Best for: High-iteration loops where you want regular progress markers
 * without caring about individual iterations.
 *
 * @example
 * ```typescript
 * // Emit every 10th iteration
 * executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder(10));
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';
export declare class MilestoneNarrativeFlowRecorder extends NarrativeFlowRecorder {
    private readonly interval;
    private readonly alwaysEmitFirst;
    private suppressedCount;
    constructor(interval?: number, alwaysEmitFirst?: boolean, id?: string);
    onLoop(event: FlowLoopEvent): void;
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount(): number;
    clear(): void;
}
