/**
 * CombinedNarrativeRecorder — Inline narrative builder that merges flow + data during traversal.
 *
 * Replaces the post-processing CombinedNarrativeBuilder by implementing BOTH
 * FlowRecorder (control-flow events) and Recorder (scope data events).
 *
 * Event ordering guarantees this works:
 *   1. Scope events (onRead, onWrite) fire DURING stage execution
 *   2. Flow events (onStageExecuted, onDecision) fire AFTER stage execution
 *   3. Both carry the same `stageName` — no matching ambiguity
 *
 * So we buffer scope ops per-stage, then when the flow event arrives,
 * emit the stage entry + flush the buffered ops in one pass.
 */
import type { ReadEvent, Recorder, WriteEvent } from '../../scope/types.js';
import type { CombinedNarrativeEntry, NarrativeRenderer } from './narrativeTypes.js';
import type { FlowBreakEvent, FlowDecisionEvent, FlowErrorEvent, FlowForkEvent, FlowLoopEvent, FlowPauseEvent, FlowRecorder, FlowResumeEvent, FlowSelectedEvent, FlowStageEvent, FlowSubflowEvent } from './types.js';
export interface CombinedNarrativeRecorderOptions {
    includeStepNumbers?: boolean;
    includeValues?: boolean;
    maxValueLength?: number;
    /** Custom value formatter. Called at render time (flushOps), not capture time.
     *  Receives the raw value and maxValueLength. Defaults to summarizeValue(). */
    formatValue?: (value: unknown, maxLen: number) => string;
    /** Pluggable renderer for customizing narrative output. Unimplemented methods
     *  fall back to the default English renderer. See NarrativeRenderer docs. */
    renderer?: NarrativeRenderer;
}
export declare class CombinedNarrativeRecorder implements FlowRecorder, Recorder {
    readonly id: string;
    private entries;
    /**
     * Pending scope ops keyed by stageName. Flushed in onStageExecuted/onDecision.
     *
     * Name collisions (two stages with the same name, different IDs) are prevented by
     * the event ordering contract: scope events (onRead/onWrite) for stage N are always
     * flushed by onStageExecuted for stage N before stage N+1's scope events begin.
     * So the key is always uniquely bound to the currently-executing stage.
     */
    private pendingOps;
    /** Per-subflow stage counters. Key '' = root flow. */
    private stageCounters;
    /** Per-subflow first-stage flags. Key '' = root flow. */
    private firstStageFlags;
    private includeStepNumbers;
    private includeValues;
    private maxValueLength;
    private formatValue;
    private renderer?;
    constructor(options?: CombinedNarrativeRecorderOptions & {
        id?: string;
    });
    onRead(event: ReadEvent): void;
    onWrite(event: WriteEvent): void;
    onStageExecuted(event: FlowStageEvent): void;
    onDecision(event: FlowDecisionEvent): void;
    onNext(): void;
    onFork(event: FlowForkEvent): void;
    onSelected(event: FlowSelectedEvent): void;
    onSubflowEntry(event: FlowSubflowEvent): void;
    onSubflowExit(event: FlowSubflowEvent): void;
    onLoop(event: FlowLoopEvent): void;
    onBreak(event: FlowBreakEvent): void;
    onPause(event: FlowPauseEvent | {
        stageName?: string;
        stageId?: string;
    }): void;
    onResume(event: FlowResumeEvent | {
        stageName?: string;
        stageId?: string;
    }): void;
    /**
     * Handles errors from both channels:
     * - FlowRecorder.onError (FlowErrorEvent with message + structuredError)
     * - Recorder.onError (ErrorEvent from scope system — ignored for narrative)
     */
    onError(event: FlowErrorEvent | {
        stageName?: string;
        message?: string;
    }): void;
    /** Returns structured entries for programmatic consumption. */
    getEntries(): CombinedNarrativeEntry[];
    /** Returns formatted narrative lines (same output as CombinedNarrativeBuilder.build). */
    getNarrative(indent?: string): string[];
    /**
     * Returns entries grouped by subflowId for structured access.
     * Root-level entries have subflowId = undefined.
     */
    getEntriesBySubflow(): Record<string, CombinedNarrativeEntry[]>;
    /** Clears all state. Called automatically before each run. */
    clear(): void;
    /** Increment and return the stage counter for a given subflow ('' = root). */
    private incrementStageCounter;
    /** Returns true if this is the first stage for the given subflow, consuming the flag. */
    private consumeFirstStageFlag;
    private bufferOp;
    private flushOps;
    private defaultRenderStage;
    private defaultRenderOp;
    private defaultRenderDecision;
    private defaultRenderFork;
    private defaultRenderSelected;
    private defaultRenderSubflow;
    private defaultRenderLoop;
    private defaultRenderBreak;
    private defaultRenderError;
}
