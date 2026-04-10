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
import type { CommitBundle, StageSnapshot } from '../memory/types.js';

/** Snapshot of a single recorder's collected data. */
export interface RecorderSnapshot {
  id: string;
  name: string;
  /** Recorder type and pattern description (e.g., "Translator (KeyedRecorder) — per-step token usage"). */
  description?: string;
  /** Preferred read-time operation — hints the UI about which view to show prominently. */
  preferredOperation?: 'translate' | 'accumulate' | 'aggregate';
  data: unknown;
}

export type RuntimeSnapshot = {
  sharedState: Record<string, unknown>;
  executionTree: StageSnapshot;
  commitLog: CommitBundle[];
  /** Per-subflow execution results (keyed by subflowId). */
  subflowResults?: Record<string, unknown>;
  /** Snapshot data from recorders that implement toSnapshot(). */
  recorders?: RecorderSnapshot[];
};

export class ExecutionRuntime {
  public globalStore: SharedMemory;
  public rootStageContext: StageContext;
  public executionHistory: EventLog;
  /** Original root for getSnapshot() — set before resume changes rootStageContext. */
  private _snapshotRoot?: StageContext;

  constructor(rootName: string, rootId: string, defaultValues?: unknown, initialState?: unknown) {
    this.executionHistory = new EventLog(initialState);
    this.globalStore = new SharedMemory(defaultValues, initialState);
    this.rootStageContext = new StageContext('', rootName, rootId, this.globalStore, '', this.executionHistory);
  }

  /** Preserve the current rootStageContext for snapshots before changing it for resume. */
  preserveSnapshotRoot(): void {
    if (!this._snapshotRoot) {
      this._snapshotRoot = this.rootStageContext;
    }
  }

  getPipelines(): string[] {
    const state = this.globalStore.getState();
    return state.pipelines ? Object.keys(state.pipelines as Record<string, unknown>) : [];
  }

  setRootObject(path: string[], key: string, value: unknown) {
    this.rootStageContext.setObject(path, key, value);
  }

  getSnapshot(): RuntimeSnapshot {
    // Use the original root (preserved before resume) for the full execution tree
    const snapshotRoot = this._snapshotRoot ?? this.rootStageContext;
    return {
      sharedState: this.globalStore.getState(),
      executionTree: snapshotRoot.getSnapshot(),
      commitLog: this.executionHistory.list(),
    };
  }
}
