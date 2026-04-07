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
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
import type { FlowLoopEvent } from '../types.js';
export declare class RLENarrativeFlowRecorder extends NarrativeFlowRecorder {
    private currentRun;
    private completedRuns;
    constructor(id?: string);
    onLoop(event: FlowLoopEvent): void;
    getSentences(): string[];
    clear(): void;
}
