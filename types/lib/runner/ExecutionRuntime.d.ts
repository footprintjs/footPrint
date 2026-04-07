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
export declare class ExecutionRuntime {
    globalStore: SharedMemory;
    rootStageContext: StageContext;
    executionHistory: EventLog;
    /** Original root for getSnapshot() — set before resume changes rootStageContext. */
    private _snapshotRoot?;
    constructor(rootName: string, rootId: string, defaultValues?: unknown, initialState?: unknown);
    /** Preserve the current rootStageContext for snapshots before changing it for resume. */
    preserveSnapshotRoot(): void;
    getPipelines(): string[];
    setRootObject(path: string[], key: string, value: unknown): void;
    getSnapshot(): RuntimeSnapshot;
}
