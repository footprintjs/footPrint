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
import { isDevMode } from '../../scope/detectCircular.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import type { NarrativeFlowRecorder } from './NarrativeFlowRecorder.js';
import type { FlowBreakEvent, FlowRecorder, IControlFlowNarrative, TraversalContext } from './types.js';

export class FlowRecorderDispatcher implements IControlFlowNarrative {
  private recorders: FlowRecorder[] = [];

  /** Attach a FlowRecorder. Duplicate IDs are allowed (same as scope Recorder). */
  attach(recorder: FlowRecorder): void {
    this.recorders.push(recorder);
  }

  /** Detach all FlowRecorders with the given ID. */
  detach(id: string): void {
    this.recorders = this.recorders.filter((r) => r.id !== id);
  }

  /** Returns a defensive copy of attached recorders. */
  getRecorders(): FlowRecorder[] {
    return [...this.recorders];
  }

  /** Find a recorder by ID. Useful for retrieving built-in recorders like NarrativeFlowRecorder. */
  getRecorderById<T extends FlowRecorder = FlowRecorder>(id: string): T | undefined {
    return this.recorders.find((r) => r.id === id) as T | undefined;
  }

  // ── IControlFlowNarrative implementation ──────────────────────────────────

  onStageExecuted(stageName: string, description?: string, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, description, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onStageExecuted?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onStageExecuted: ${err}`);
      }
    }
  }

  onNext(fromStage: string, toStage: string, description?: string, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { from: fromStage, to: toStage, description, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onNext?.(event);
      } catch (err) {
        if (isDevMode()) console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onNext: ${err}`);
      }
    }
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
    for (const r of this.recorders) {
      try {
        r.onDecision?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onDecision: ${err}`);
      }
    }
  }

  onFork(parentStage: string, childNames: string[], traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { parent: parentStage, children: childNames, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onFork?.(event);
      } catch (err) {
        if (isDevMode()) console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onFork: ${err}`);
      }
    }
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
    for (const r of this.recorders) {
      try {
        r.onSelected?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSelected: ${err}`);
      }
    }
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
    for (const r of this.recorders) {
      try {
        r.onSubflowEntry?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowEntry: ${err}`);
      }
    }
  }

  onSubflowExit(
    subflowName: string,
    subflowId?: string,
    traversalContext?: TraversalContext,
    outputState?: Record<string, unknown>,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { name: subflowName, subflowId, traversalContext, outputState };
    for (const r of this.recorders) {
      try {
        r.onSubflowExit?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowExit: ${err}`);
      }
    }
  }

  onSubflowRegistered(subflowId: string, name: string, description?: string, specStructure?: unknown): void {
    if (this.recorders.length === 0) return;
    const event = { subflowId, name, description, specStructure };
    for (const r of this.recorders) {
      try {
        r.onSubflowRegistered?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowRegistered: ${err}`);
      }
    }
  }

  onLoop(targetStage: string, iteration: number, description?: string, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { target: targetStage, iteration, description, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onLoop?.(event);
      } catch (err) {
        if (isDevMode()) console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onLoop: ${err}`);
      }
    }
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
    for (const r of this.recorders) {
      try {
        r.onBreak?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onBreak: ${err}`);
      }
    }
  }

  onError(stageName: string, errorMessage: string, error: unknown, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const structuredError = extractErrorInfo(error);
    const event = { stageName, message: errorMessage, structuredError, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onError?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onError: ${err}`);
      }
    }
  }

  onPause(
    stageName: string,
    stageId: string,
    pauseData: unknown,
    subflowPath: readonly string[],
    traversalContext?: TraversalContext,
  ): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, stageId, pauseData, subflowPath, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onPause?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onPause: ${err}`);
      }
    }
  }

  onResume(stageName: string, stageId: string, hasInput: boolean, traversalContext?: TraversalContext): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, stageId, hasInput, traversalContext };
    for (const r of this.recorders) {
      try {
        r.onResume?.(event);
      } catch (err) {
        if (isDevMode())
          console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onResume: ${err}`);
      }
    }
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
