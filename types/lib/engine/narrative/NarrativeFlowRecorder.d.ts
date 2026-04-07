/**
 * NarrativeFlowRecorder — Default FlowRecorder that generates plain-English narrative.
 *
 * This is the FlowRecorder equivalent of ControlFlowNarrativeGenerator.
 * Produces the same sentences, same format, same behavior — but as a
 * pluggable FlowRecorder that can be swapped, extended, or composed.
 *
 * Consumers who want different narrative behavior (windowed loops, adaptive
 * summarization, etc.) can replace this with a different FlowRecorder.
 */
import type { FlowBreakEvent, FlowDecisionEvent, FlowErrorEvent, FlowForkEvent, FlowLoopEvent, FlowNextEvent, FlowPauseEvent, FlowRecorder, FlowResumeEvent, FlowSelectedEvent, FlowStageEvent, FlowSubflowEvent } from './types.js';
export declare class NarrativeFlowRecorder implements FlowRecorder {
    readonly id: string;
    private sentences;
    /** Parallel array: the actual stage name that produced each sentence. */
    private stageNames;
    constructor(id?: string);
    onStageExecuted(event: FlowStageEvent): void;
    onNext(event: FlowNextEvent): void;
    onDecision(event: FlowDecisionEvent): void;
    onFork(event: FlowForkEvent): void;
    onSelected(event: FlowSelectedEvent): void;
    onSubflowEntry(event: FlowSubflowEvent): void;
    onSubflowExit(event: FlowSubflowEvent): void;
    onLoop(event: FlowLoopEvent): void;
    onBreak(event: FlowBreakEvent): void;
    onError(event: FlowErrorEvent): void;
    onPause(event: FlowPauseEvent): void;
    onResume(event: FlowResumeEvent): void;
    /** Returns a defensive copy of accumulated sentences. */
    getSentences(): string[];
    /** Clears accumulated sentences. Useful for reuse across runs. */
    clear(): void;
}
