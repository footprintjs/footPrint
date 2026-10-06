/**
 * FlowRecorderDispatcher — Fans out control flow events to N attached FlowRecorders.
 *
 * Implements IControlFlowNarrative so it can replace the single
 * ControlFlowNarrativeGenerator in the traverser's HandlerDeps.
 *
 * Every event goes through `recorder/hooks.ts · fire` (the one per-recorder loop): a failing
 * recorder is warned about in dev mode and never breaks execution — even when what it threw
 * cannot be turned into a string.
 *
 * When no recorders are attached, every method is a fast no-op (empty array check).
 */

import type { DecisionEvidence, SelectionEvidence } from '../../decide/types.js';
import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import { extractErrorInfo } from '../../errors/errorInfo.js';
import { fire, warnInDevMode } from '../../recorder/hooks.js';
import type { NarrativeFlowRecorder } from './NarrativeFlowRecorder.js';
import type {
  FlowBreakEvent,
  FlowRecorder,
  FlowStageEvent,
  FlowStageRetryEvent,
  FlowThrottledEvent,
  IControlFlowNarrative,
  StageType,
  TraversalContext,
} from './types.js';

/** The flow channel's isolation: a throwing recorder is warned about in dev mode, then skipped. */
const FLOW_FAILURE = warnInDevMode('FlowRecorderDispatcher');

export class FlowRecorderDispatcher implements IControlFlowNarrative {
  private recorders: FlowRecorder[] = [];

  /** Attach a FlowRecorder. Duplicate IDs are allowed (same as scope ScopeRecorder). */
  attach(recorder: FlowRecorder): void {
    this.recorders.push(recorder);
  }

  /** Detach all FlowRecorders with the given ID. */
  detach(id: string): void {
    this.recorders = this.recorders.filter((r) => r.id !== id);
  }

  /** Returns a defensive copy of attached recorders. */
  getScopeRecorders(): FlowRecorder[] {
    return [...this.recorders];
  }

  /** Find a recorder by ID. Useful for retrieving built-in recorders like NarrativeFlowRecorder. */
  getRecorderById<T extends FlowRecorder = FlowRecorder>(id: string): T | undefined {
    return this.recorders.find((r) => r.id === id) as T | undefined;
  }

  // ── IControlFlowNarrative implementation ──────────────────────────────────

  onStageExecuted(
    stageName: string,
    description: string | undefined,
    traversalContext: TraversalContext | undefined,
    stageType: StageType,
  ): void {
    if (this.recorders.length === 0) return;
    const event: FlowStageEvent = { stageName, description, traversalContext, stageType };
    fire(this.recorders, 'onStageExecuted', event, FLOW_FAILURE);
  }

  onNext(fromStage: string, toStage: string, description?: string, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { from: fromStage, to: toStage, description, traversalContext };
    fire(this.recorders, 'onNext', event, FLOW_FAILURE);
  }

  onDecision(
    deciderName: string,
    chosenBranch: string,
    rationale?: string,
    deciderDescription?: string,
    traversalContext?: TraversalContext,
    evidence?: DecisionEvidence,
  ): void {
    if (this.recorders.length === 0) return;
    const event = {
      decider: deciderName,
      chosen: chosenBranch,
      rationale,
      description: deciderDescription,
      traversalContext,
      evidence,
    };
    fire(this.recorders, 'onDecision', event, FLOW_FAILURE);
  }

  onFork(parentStage: string, childNames: string[], traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { parent: parentStage, children: childNames, traversalContext };
    fire(this.recorders, 'onFork', event, FLOW_FAILURE);
  }

  onSelected(
    parentStage: string,
    selectedNames: string[],
    totalCount: number,
    traversalContext?: TraversalContext,
    evidence?: SelectionEvidence,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { parent: parentStage, selected: selectedNames, total: totalCount, traversalContext, evidence };
    fire(this.recorders, 'onSelected', event, FLOW_FAILURE);
  }

  onSubflowEntry(
    subflowName: string,
    subflowId?: string,
    description?: string,
    traversalContext?: TraversalContext,
    mappedInput?: Record<string, unknown>,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { name: subflowName, subflowId, description, traversalContext, mappedInput };
    fire(this.recorders, 'onSubflowEntry', event, FLOW_FAILURE);
  }

  onSubflowExit(
    subflowName: string,
    subflowId?: string,
    traversalContext?: TraversalContext,
    outputState?: Record<string, unknown>,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { name: subflowName, subflowId, traversalContext, outputState };
    fire(this.recorders, 'onSubflowExit', event, FLOW_FAILURE);
  }

  onSubflowRegistered(subflowId: string, name: string, description?: string, specStructure?: unknown): void {
    if (this.recorders.length === 0) return;
    const event = { subflowId, name, description, specStructure };
    fire(this.recorders, 'onSubflowRegistered', event, FLOW_FAILURE);
  }

  onLoop(targetStage: string, iteration: number, description?: string, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { target: targetStage, iteration, description, traversalContext };
    fire(this.recorders, 'onLoop', event, FLOW_FAILURE);
  }

  onBreak(
    stageName: string,
    traversalContext?: TraversalContext,
    reason?: string,
    propagatedFromSubflow?: string,
  ): void {
    if (this.recorders.length === 0) return;
    const event: FlowBreakEvent = {
      stageName,
      ...(traversalContext && { traversalContext }),
      ...(reason !== undefined && { reason }),
      ...(propagatedFromSubflow !== undefined && { propagatedFromSubflow }),
    };
    fire(this.recorders, 'onBreak', event, FLOW_FAILURE);
  }

  onError(
    stageName: string,
    errorMessage: string,
    structuredError: StructuredErrorInfo,
    traversalContext?: TraversalContext,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, message: errorMessage, structuredError, traversalContext, channel: 'flow' as const };
    fire(this.recorders, 'onError', event, FLOW_FAILURE);
  }

  onStageRetry(
    stageName: string,
    stageId: string,
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    error: unknown,
    traversalContext?: TraversalContext,
  ): void {
    if (this.recorders.length === 0) return;
    const structuredError = extractErrorInfo(error);
    const event: FlowStageRetryEvent = {
      stageName,
      stageId,
      attempt,
      maxAttempts,
      delayMs,
      message: structuredError.message,
      structuredError,
      traversalContext,
      channel: 'flow' as const,
    };
    fire(this.recorders, 'onStageRetry', event, FLOW_FAILURE);
  }

  onThrottled(stageName: string, stageId: string, error: unknown, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const structuredError = extractErrorInfo(error);
    const event: FlowThrottledEvent = {
      stageName,
      stageId,
      message: structuredError.message,
      structuredError,
      traversalContext,
      channel: 'flow' as const,
    };
    fire(this.recorders, 'onThrottled', event, FLOW_FAILURE);
  }

  onPause(
    stageName: string,
    stageId: string,
    pauseData: unknown,
    subflowPath: readonly string[],
    traversalContext?: TraversalContext,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, stageId, pauseData, subflowPath, traversalContext, channel: 'flow' as const };
    fire(this.recorders, 'onPause', event, FLOW_FAILURE);
  }

  onResume(stageName: string, stageId: string, hasInput: boolean, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, stageId, hasInput, traversalContext, channel: 'flow' as const };
    fire(this.recorders, 'onResume', event, FLOW_FAILURE);
  }

  onRunStart(input: unknown, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { payload: input, traversalContext };
    fire(this.recorders, 'onRunStart', event, FLOW_FAILURE);
  }

  onRunEnd(output: unknown, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { payload: output, traversalContext };
    fire(this.recorders, 'onRunEnd', event, FLOW_FAILURE);
  }

  onRunFailed(error: StructuredErrorInfo, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { structuredError: error, traversalContext };
    fire(this.recorders, 'onRunFailed', event, FLOW_FAILURE);
  }

  /**
   * Returns sentences from an attached NarrativeFlowRecorder (looked up by ID).
   * Callers that need sentences should attach a NarrativeFlowRecorder with id 'narrative'
   * and retrieve it directly via getRecorderById() if they need typed access.
   */
  getSentences(): string[] {
    const narrative = this.getRecorderById<NarrativeFlowRecorder>('narrative');
    return narrative?.getSentences() ?? [];
  }
}
