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

import { extractErrorInfo } from '../errors/errorInfo';
import type { FlowRecorder, IControlFlowNarrative } from './types';

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

  onStageExecuted(stageName: string, description?: string): void {
    if (this.recorders.length === 0) return;
    const event = { stageName, description };
    for (const r of this.recorders) {
      try {
        r.onStageExecuted?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onNext(fromStage: string, toStage: string, description?: string): void {
    if (this.recorders.length === 0) return;
    const event = { from: fromStage, to: toStage, description };
    for (const r of this.recorders) {
      try {
        r.onNext?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onDecision(deciderName: string, chosenBranch: string, rationale?: string, deciderDescription?: string): void {
    if (this.recorders.length === 0) return;
    const event = { decider: deciderName, chosen: chosenBranch, rationale, description: deciderDescription };
    for (const r of this.recorders) {
      try {
        r.onDecision?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onFork(parentStage: string, childNames: string[]): void {
    if (this.recorders.length === 0) return;
    const event = { parent: parentStage, children: childNames };
    for (const r of this.recorders) {
      try {
        r.onFork?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onSelected(parentStage: string, selectedNames: string[], totalCount: number): void {
    if (this.recorders.length === 0) return;
    const event = { parent: parentStage, selected: selectedNames, total: totalCount };
    for (const r of this.recorders) {
      try {
        r.onSelected?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onSubflowEntry(subflowName: string, subflowId?: string, description?: string): void {
    if (this.recorders.length === 0) return;
    const event = { name: subflowName, subflowId, description };
    for (const r of this.recorders) {
      try {
        r.onSubflowEntry?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onSubflowExit(subflowName: string, subflowId?: string): void {
    if (this.recorders.length === 0) return;
    const event = { name: subflowName, subflowId };
    for (const r of this.recorders) {
      try {
        r.onSubflowExit?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onSubflowRegistered(subflowId: string, name: string, description?: string, specStructure?: unknown): void {
    if (this.recorders.length === 0) return;
    const event = { subflowId, name, description, specStructure };
    for (const r of this.recorders) {
      try {
        r.onSubflowRegistered?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onLoop(targetStage: string, iteration: number, description?: string): void {
    if (this.recorders.length === 0) return;
    const event = { target: targetStage, iteration, description };
    for (const r of this.recorders) {
      try {
        r.onLoop?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onBreak(stageName: string): void {
    if (this.recorders.length === 0) return;
    const event = { stageName };
    for (const r of this.recorders) {
      try {
        r.onBreak?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  onError(stageName: string, errorMessage: string, error: unknown): void {
    if (this.recorders.length === 0) return;
    const structuredError = extractErrorInfo(error);
    const event = { stageName, message: errorMessage, structuredError };
    for (const r of this.recorders) {
      try {
        r.onError?.(event);
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Returns sentences from the first attached recorder that provides them.
   * By convention, NarrativeFlowRecorder exposes getSentences().
   */
  getSentences(): string[] {
    for (const r of this.recorders) {
      const candidate = r as unknown as Record<string, unknown>;
      if (typeof candidate.getSentences === 'function') {
        return (candidate.getSentences as () => string[])();
      }
    }
    return [];
  }
}
