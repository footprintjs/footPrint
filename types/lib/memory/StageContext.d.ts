/**
 * StageContext — Execution context for a single stage in a flowchart run
 *
 * Like a stack frame in a compiler/runtime:
 * - Reference to SharedMemory (accessing heap memory)
 * - TransactionBuffer for staging mutations (transaction buffer)
 * - Links to parent/child/next contexts (call stack frames)
 * - DiagnosticCollector for logs, errors, metrics
 */
import { DiagnosticCollector } from './DiagnosticCollector.js';
import { EventLog } from './EventLog.js';
import { SharedMemory } from './SharedMemory.js';
import { TransactionBuffer } from './TransactionBuffer.js';
import type { FlowControlType, StageSnapshot } from './types.js';
export declare class StageContext {
    private sharedMemory;
    private buffer?;
    private eventLog?;
    stageName: string;
    /** Unique stage identifier from the builder (matches spec node id). */
    stageId: string;
    runId: string;
    branchId?: string;
    isDecider: boolean;
    isFork: boolean;
    /** Human-readable description from builder (set by traverser before execution). */
    description?: string;
    /** Subflow identifier (set by traverser when this is a subflow entry point). */
    subflowId?: string;
    parent?: StageContext;
    next?: StageContext;
    children?: StageContext[];
    debug: DiagnosticCollector;
    /** Tracks user-level writes (pre-namespace) for the memory view and onCommit. */
    private _stageWrites;
    /** Tracks user-level reads (pre-namespace) for the memory view. */
    private _stageReads;
    /** Observer called after commit() — used by ScopeFacade to fire Recorder.onCommit. */
    private _commitObserver?;
    constructor(runId: string, name: string, stageId: string, sharedMemory: SharedMemory, branchId?: string, eventLog?: EventLog, isDecider?: boolean);
    /** Returns the SharedMemory instance (needed by scope layer). */
    getSharedMemory(): SharedMemory;
    /** Lazily creates the transaction buffer (pay clone cost only if stage writes). */
    getTransactionBuffer(): TransactionBuffer;
    /** Builds an absolute path inside the shared memory (run namespace). */
    private withNamespace;
    patch(path: string[], key: string, value: unknown, shouldRedact?: boolean): void;
    set(path: string[], key: string, value: unknown): void;
    merge(path: string[], key: string, value: unknown): void;
    setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string, operationOverride?: 'set' | 'delete'): void;
    updateObject(path: string[], key: string, value: unknown, description?: string, shouldRedact?: boolean): void;
    setRoot(key: string, value: unknown): void;
    setGlobal(key: string, value: unknown, description?: string): void;
    updateGlobalContext(key: string, value: unknown): void;
    appendToArray(path: string[], key: string, items: unknown[], description?: string): void;
    mergeObject(path: string[], key: string, obj: Record<string, unknown>, description?: string): void;
    getValue(path: string[], key?: string, description?: string): any;
    /** Read state without tracking in _stageReads or paying structuredClone cost.
     *  Used by ScopeFacade.getValueSilent() for array proxy internal operations. */
    getValueDirect(path: string[], key?: string): unknown;
    getRoot(key: string): any;
    getGlobal(key: string): any;
    getScope(): Record<string, unknown>;
    getRunId(): string;
    /** Register an observer that fires after commit() applies patches.
     *  Used by ScopeFacade to dispatch Recorder.onCommit events. */
    setCommitObserver(observer: (mutations: Record<string, {
        value: unknown;
        operation: 'set' | 'update' | 'delete';
    }>) => void): void;
    commit(): void;
    createNext(path: string, stageName: string, stageId: string, isDecider?: boolean): StageContext;
    createChild(runId: string, branchId: string, stageName: string, stageId: string, isDecider?: boolean): StageContext;
    createDecider(path: string, stageName: string, stageId: string): StageContext;
    setAsDecider(): StageContext;
    setAsFork(): StageContext;
    addLog(key: string, value: unknown, path?: string[]): void;
    setLog(key: string, value: unknown, path?: string[]): void;
    addMetric(key: string, value: unknown, path?: string[]): void;
    setMetric(key: string, value: unknown, path?: string[]): void;
    addEval(key: string, value: unknown, path?: string[]): void;
    setEval(key: string, value: unknown, path?: string[]): void;
    addError(key: string, value: unknown, path?: string[]): void;
    addFlowDebugMessage(type: FlowControlType, description: string, options?: {
        targetStage?: string | string[];
        rationale?: string;
        count?: number;
        iteration?: number;
    }): void;
    getStageId(): string;
    getSnapshot(): StageSnapshot;
}
