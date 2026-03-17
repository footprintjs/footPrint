/**
 * ExecutionRuntime — The runtime environment for one flowchart execution.
 *
 * Wires up the three memory primitives into a single container:
 *   - SharedMemory (the heap — shared state across all stages)
 *   - StageContext  (the call stack — per-stage execution tree)
 *   - EventLog      (the transaction log — commit history for replay)
 *
 * The engine (FlowchartTraverser) receives this as its runtime parameter.
 * After execution, consumers query it for the full execution state.
 */

import { EventLog } from '../memory/EventLog.js';
import { SharedMemory } from '../memory/SharedMemory.js';
import { StageContext } from '../memory/StageContext.js';
import type { CommitBundle, FlowMessage, StageSnapshot } from '../memory/types.js';

export interface NarrativeEntry {
  stageId: string;
  stageName: string;
  stageMessages: string[];
  flowMessage?: FlowMessage;
  timeIndex: number;
}

export type RuntimeSnapshot = {
  sharedState: Record<string, unknown>;
  executionTree: StageSnapshot;
  commitLog: CommitBundle[];
  /** Per-subflow execution results (keyed by subflowId). */
  subflowResults?: Record<string, unknown>;
};

export class ExecutionRuntime {
  public globalStore: SharedMemory;
  public rootStageContext: StageContext;
  public executionHistory: EventLog;

  constructor(rootName: string, defaultValues?: unknown, initialState?: unknown) {
    this.executionHistory = new EventLog(initialState);
    this.globalStore = new SharedMemory(defaultValues, initialState);
    this.rootStageContext = new StageContext('', rootName, this.globalStore, '', this.executionHistory);
  }

  getPipelines(): string[] {
    const state = this.globalStore.getState();
    return state.pipelines ? Object.keys(state.pipelines as Record<string, unknown>) : [];
  }

  setRootObject(path: string[], key: string, value: unknown) {
    this.rootStageContext.setObject(path, key, value);
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      sharedState: this.globalStore.getState(),
      executionTree: this.rootStageContext.getSnapshot(),
      commitLog: this.executionHistory.list(),
    };
  }

  getFullNarrative(): NarrativeEntry[] {
    const narrative: NarrativeEntry[] = [];
    let timeIndex = 0;

    this.walkContextTree(this.rootStageContext, (context) => {
      const stageMessages = (context.debug.logContext.message as string[]) || [];
      const flowMessages = context.debug.flowMessages;
      const flowMessage = flowMessages.length > 0 ? flowMessages[0] : undefined;

      narrative.push({
        stageId: context.getStageId(),
        stageName: context.stageName,
        stageMessages,
        flowMessage,
        timeIndex: timeIndex++,
      });
    });

    return narrative;
  }

  private walkContextTree(context: StageContext, visitor: (ctx: StageContext) => void): void {
    visitor(context);
    if (context.children) {
      for (const child of context.children) {
        this.walkContextTree(child, visitor);
      }
    }
    if (context.next) {
      this.walkContextTree(context.next, visitor);
    }
  }
}
