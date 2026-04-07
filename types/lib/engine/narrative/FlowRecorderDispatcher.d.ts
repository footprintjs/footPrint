/**
 * FlowRecorderDispatcher — Fans out control flow events to N attached FlowRecorders.
 *
 * Implements IControlFlowNarrative so it can replace the single
 * ControlFlowNarrativeGenerator in the traverser's HandlerDeps.
 *
 * Design mirrors ScopeFacade._invokeHook: iterate recorders, call optional
 * hooks, swallow errors so a failing recorder never breaks execution.
 *
 * When no recorders are attached, every method is a fast no-op (empty array check).
 */
import type { DecisionEvidence, SelectionEvidence } from '../../decide/types.js';
import type { FlowRecorder, IControlFlowNarrative, TraversalContext } from './types.js';
export declare class FlowRecorderDispatcher implements IControlFlowNarrative {
    private recorders;
    /** Attach a FlowRecorder. Duplicate IDs are allowed (same as scope Recorder). */
    attach(recorder: FlowRecorder): void;
    /** Detach all FlowRecorders with the given ID. */
    detach(id: string): void;
    /** Returns a defensive copy of attached recorders. */
    getRecorders(): FlowRecorder[];
    /** Find a recorder by ID. Useful for retrieving built-in recorders like NarrativeFlowRecorder. */
    getRecorderById<T extends FlowRecorder = FlowRecorder>(id: string): T | undefined;
    onStageExecuted(stageName: string, description?: string, traversalContext?: TraversalContext): void;
    onNext(fromStage: string, toStage: string, description?: string, traversalContext?: TraversalContext): void;
    onDecision(deciderName: string, chosenBranch: string, rationale?: string, deciderDescription?: string, traversalContext?: TraversalContext, evidence?: DecisionEvidence): void;
    onFork(parentStage: string, childNames: string[], traversalContext?: TraversalContext): void;
    onSelected(parentStage: string, selectedNames: string[], totalCount: number, traversalContext?: TraversalContext, evidence?: SelectionEvidence): void;
    onSubflowEntry(subflowName: string, subflowId?: string, description?: string, traversalContext?: TraversalContext): void;
    onSubflowExit(subflowName: string, subflowId?: string, traversalContext?: TraversalContext): void;
    onSubflowRegistered(subflowId: string, name: string, description?: string, specStructure?: unknown): void;
    onLoop(targetStage: string, iteration: number, description?: string, traversalContext?: TraversalContext): void;
    onBreak(stageName: string, traversalContext?: TraversalContext): void;
    onError(stageName: string, errorMessage: string, error: unknown, traversalContext?: TraversalContext): void;
    onPause(stageName: string, stageId: string, pauseData: unknown, subflowPath: readonly string[], traversalContext?: TraversalContext): void;
    onResume(stageName: string, stageId: string, hasInput: boolean, traversalContext?: TraversalContext): void;
    /**
     * Returns sentences from an attached NarrativeFlowRecorder (looked up by ID).
     * Callers that need sentences should attach a NarrativeFlowRecorder with id 'narrative'
     * and retrieve it directly via getRecorderById() if they need typed access.
     */
    getSentences(): string[];
}
