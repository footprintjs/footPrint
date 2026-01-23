/****************************************************************************************
 * StageContext
 * ----------------------------------------------------------------------------
 *  The execution context for a single stage in the pipeline.
 *
 *  Think of it like a stack frame in a compiler/runtime - it holds:
 *    - Reference to the global store (like accessing heap memory)
 *    - A write buffer for staging mutations (like a transaction buffer)
 *    - Links to parent/child/next contexts (like call stack frames)
 *    - Metadata collector for logs, errors, metrics
 *
 *  Key responsibilities:
 *    ➤ Holds *ephemeral* state for a single stage execution
 *    ➤ Delegates all reads/writes to a WriteBuffer so we can batch
 *      changes and atomically commit them into the shared GlobalStore
 *    ➤ Creates child / next StageContext objects to model linear and branch
 *      execution inside a pipeline
 ****************************************************************************************/

import { ExecutionHistory } from '../stateManagement/ExecutionHistory';
import { WriteBuffer } from '../stateManagement/WriteBuffer';
import { redactPatch } from '../stateManagement/utils';
import { StageMetadata } from './StageMetadata';
import { GlobalStore } from './GlobalStore';
import { treeConsole } from './scopeLog';
import type { FlowControlType, FlowMessage } from '../pipeline/types';

/**
 * StageSnapshot - Serializable representation of a stage's state
 * 
 * Used for debugging, visualization, and time-travel features.
 *
 * _Requirements: flow-control-narrative REQ-5_
 */
export type StageSnapshot = {
  id: string;
  name?: string;
  isDecider?: boolean;
  isFork?: boolean;
  logs: Record<string, unknown>;
  errors: Record<string, unknown>;
  metrics: Record<string, unknown>;
  evals: Record<string, unknown>;
  flowMessages?: FlowMessage[];
  next?: StageSnapshot;
  children?: StageSnapshot[];
};

/** @deprecated Use StageSnapshot instead */
export type StageType = StageSnapshot;

/**
 * StageContext - Execution context for a single pipeline stage
 * 
 * Manages state access, mutations, and metadata for one stage's execution.
 * Creates a tree structure linking parent, child, and next stages.
 */
export class StageContext {
  /* ------------------------------------------------------------------------
   * Data members
   * ---------------------------------------------------------------------- */
  private globalStore: GlobalStore; // reference to the singleton
  private writeBuffer?: WriteBuffer; // lazily created per stage
  private executionHistory?: ExecutionHistory; // shared history tracker

  /** Name of the stage (for logging / debugging) */
  public stageName = '';
  /** Pipeline + branch identifiers */
  public pipelineId: string;
  public branchId?: string;
  public isDecider: boolean;
  public isFork: boolean;

  /** Links for walking the stage tree */
  public parent?: StageContext;
  public next?: StageContext;
  public children?: StageContext[];

  /** Per-stage metadata collector (logs, errors, metrics, evals) */
  public debug: StageMetadata = new StageMetadata();

  constructor(
    pipelineId: string,
    name: string,
    globalStore: GlobalStore,
    branchId?: string,
    executionHistory?: ExecutionHistory,
    isDecider?: boolean,
  ) {
    this.pipelineId = pipelineId;
    this.stageName = name;
    this.globalStore = globalStore;
    this.branchId = branchId;
    this.executionHistory = executionHistory as ExecutionHistory;
    this.isDecider = !!isDecider;
    this.isFork = false;
  }

  /* ==========================================================================
   * Write Buffer Access
   * ======================================================================= */

  /**
   * getWriteBuffer() - Get the write buffer for staging mutations
   * 
   * Lazily instantiates the WriteBuffer so we pay the clone cost
   * *only* if the stage actually writes something.
   */
  getWriteBuffer(): WriteBuffer {
    if (!this.writeBuffer) {
      this.writeBuffer = new WriteBuffer(this.globalStore.getState());
    }
    return this.writeBuffer;
  }

  /**
   * @deprecated Use getWriteBuffer() instead
   */
  getMemoryContext(): WriteBuffer {
    return this.getWriteBuffer();
  }

  /**
   * withNamespace()
   * ------------------------------------------------------------
   * Build an absolute path inside the *shared* GlobalStore.
   *
   *   • Prepends the pipeline namespace   → ['pipelines', id, …]
   *   • Appends the leaf *key* to the caller-supplied path.
   *
   * Example:
   *   path = ['config'] , key = 'tags'
   *   → ['pipelines', 'testFlow', 'config', 'tags']
   */
  private withNamespace(path: string[], key: string): string[] {
    if (!this.pipelineId || this.pipelineId === '') {
      return [...path, key];
    }
    return ['pipelines', this.pipelineId, ...path, key];
  }

  /* ==========================================================================
   * Write helpers
   * ======================================================================= */

  /**
   * patch() - Hard overwrite at the specified path
   * merge() - Deep union merge at the specified path
   *
   * Both calculate the fully-qualified path and forward to
   * WriteBuffer so that all writes are batched.
   */
  patch(path: string[], key: string, value: unknown, shouldRedact = false) {
    this.getWriteBuffer().set(this.withNamespace(path, key), value, shouldRedact);
  }

  set(path: string[], key: string, value: unknown) {
    this.patch(path, key, value);
  }

  merge(path: string[], key: string, value: unknown) {
    this.getWriteBuffer().merge(this.withNamespace(path, key), value);
  }

  /**
   * commit() - Flush staged mutations into the GlobalStore
   * 
   * Atomically applies all staged writes to the global state:
   *   1. writeBuffer.commit() → { overwrite, updates, trace }
   *   2. globalStore.applyPatch() → applies changes
   *   3. Records to execution history for time-travel
   */
  commit(): void {
    const buffer = this.getWriteBuffer();
    const bundle = buffer.commit();

    // 1. Add stage name for the history UI
    const commitBundle = { ...bundle, stage: this.stageName };

    // 2. Apply to global store
    this.globalStore.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);

    // 3. Redact and inject to history
    const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
    const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);
    this.executionHistory?.record({
      ...commitBundle,
      redactedPaths: Array.from(commitBundle.redactedPaths.values()),
      overwrite: redactedOverwrite,
      updates: redactedUpdates,
    });

    // 4. Debug trace
    this.debug.addLog('writeTrace', commitBundle.trace);
  }

  /**
   * @deprecated Use commit() instead
   */
  commitPatch(): void {
    this.commit();
  }

  /* ==========================================================================
   * Stage Tree Navigation
   * ======================================================================= */

  /**
   * createNext() - Create the linear successor stage context
   * 
   * Returns (and caches) the *linear* successor StageContext so a
   * pipeline can keep calling `.next` without duplicating contexts.
   */
  createNext(path: string, stageName: string, isDecider = false): StageContext {
    if (!this.next) {
      this.next = new StageContext(path, stageName, this.globalStore, '', this.executionHistory, isDecider);
      this.next.parent = this;
    }
    return this.next;
  }

  /**
   * @deprecated Use createNext() instead
   */
  createNextContext(path: string, stageName: string, isDecider = false): StageContext {
    return this.createNext(path, stageName, isDecider);
  }

  /**
   * createChild() - Create a branch context for parallel execution
   * 
   * Builds a StageContext for a branch executed in parallel (fan-out).
   * Note: it's linked via `children[]` **but still shares the same
   *       GlobalStore instance** so writes are synchronized.
   */
  createChild(pipelineId: string, branchId: string, stageName: string, isDecider = false): StageContext {
    if (!this.children) {
      this.children = [];
    }
    const childContext = new StageContext(
      pipelineId,
      stageName,
      this.globalStore,
      branchId,
      this.executionHistory,
      isDecider,
    );
    childContext.parent = this;
    this.children.push(childContext);
    return childContext;
  }

  /**
   * @deprecated Use createChild() instead
   */
  createChildContext(pipelineId: string, branchId: string, stageName: string, isDecider = false): StageContext {
    return this.createChild(pipelineId, branchId, stageName, isDecider);
  }

  /**
   * createDecider() - Create a decider stage context
   * 
   * Returns (and caches) the *linear* successor StageContext marked as a decider.
   */
  createDecider(path: string, stageName: string): StageContext {
    return this.createNext(path, stageName, true);
  }

  /**
   * @deprecated Use createDecider() instead
   */
  createDeciderContext(path: string, stageName: string): StageContext {
    return this.createDecider(path, stageName);
  }

  setAsDecider(): StageContext {
    this.isDecider = true;
    return this;
  }

  setAsFork(): StageContext {
    this.isFork = true;
    return this;
  }

  /* ==========================================================================
   * Convenience wrappers used by Stage functions
   * ======================================================================= */

  /** Shorthand for hard-overwrite at root level */
  setRoot(key: string, value: unknown) {
    this.patch([], key, value);
    treeConsole.log(this, this.stageName, [], key, value, true);
  }

  /** Shorthand for deep-merge in the current pipeline namespace */
  updateObject(path: string[], key: string, value: unknown, description?: string) {
    this.merge(path, key, value);
    treeConsole.log(this, this.stageName, path, key, value);
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  updateGlobalContext(key: string, value: unknown) {
    this.getWriteBuffer().set([key], value);
  }

  setGlobal(key: string, value: unknown, description?: string) {
    this.getWriteBuffer().set([key], value);
    treeConsole.log(this, this.stageName, [], key, value, true);
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  /**
   * setObject() - Set a value at the specified path with optional narrative logging
   *
   * @param path - Path segments to the value
   * @param key - Key within the path
   * @param value - Value to set
   * @param shouldRedact - Whether to redact the value in logs
   * @param description - Optional description for auto-narrative logging (auto-prefixed with [WRITE] if no tag)
   *
   * _Requirements: auto-narrative-operations REQ-2_
   */
  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    this.patch(path, key, value, shouldRedact ?? false);
    const logValue = shouldRedact ? 'REDACTED' : value;
    treeConsole.log(this, this.stageName, path, key, logValue, true);
    if (description) {
      // Auto-prefix with [WRITE] if no tag present
      const taggedDescription = description.startsWith('[')
        ? description
        : `[WRITE] ${description}`;
      this.debug.addLog('message', taggedDescription);
    }
  }

  /* ==========================================================================
   * Read helpers
   * ======================================================================= */

  /**
   * getValue() - Read a value with read-after-write semantics
   * 
   * 1. Look in *staged* write buffer first (read-after-write semantics)
   * 2. Fallback to the committed GlobalStore
   * 3. Auto-log [READ] narrative if description provided
   *
   * @param path - Path segments to the value
   * @param key - Optional key within the path
   * @param description - Optional description for auto-narrative logging
   *
   * _Requirements: auto-narrative-operations REQ-1_
   */
  getValue(path: string[], key?: string, description?: string) {
    const buffer = this.getWriteBuffer();
    const fromPatch = buffer.get(this.withNamespace(path, key as string));
    const value = typeof fromPatch !== 'undefined'
      ? fromPatch
      : this.globalStore.getValue(this.pipelineId, path, key);

    // Auto-narrative: log read operation if description provided
    if (description) {
      this.debug.addLog('message', `[READ] ${description}`);
    }

    return value;
  }

  getPipelineId(): string {
    return this.pipelineId;
  }

  get(path: string[], key?: string) {
    return this.getValue(path, key);
  }

  getRoot(key: string) {
    return this.globalStore.getValue(this.pipelineId, [], key);
  }

  getGlobal(key: string) {
    return this.globalStore.getValue('', [], key);
  }

  getFromRoot(key: string) {
    return this.globalStore.getValue(this.pipelineId, [], key);
  }

  getFromGlobalContext(key: string) {
    return this.globalStore.getValue('', [], key);
  }

  /* ==========================================================================
   * Metadata helpers (logs, errors, metrics, evals)
   * ======================================================================= */

  /**
   * addLog() - Add a log entry to stage metadata
   */
  addLog(key: string, value: unknown, path?: string[]) {
    this.debug.addLog(key, value, path);
  }

  /**
   * @deprecated Use addLog() instead
   */
  addDebugInfo(key: string, value: unknown, path?: string[]) {
    this.addLog(key, value, path);
  }

  /**
   * setLog() - Set a log entry in stage metadata
   */
  setLog(key: string, value: unknown, path?: string[]) {
    this.debug.setLog(key, value, path);
  }

  /**
   * @deprecated Use setLog() instead
   */
  setDebugInfo(key: string, value: unknown, path?: string[]) {
    this.setLog(key, value, path);
  }

  addMetric(key: string, value: unknown, path?: string[]) {
    this.debug.addMetric(key, value, path);
  }

  setMetric(key: string, value: unknown, path?: string[]) {
    this.debug.setMetric(key, value, path);
  }

  addEval(key: string, value: unknown, path?: string[]) {
    this.debug.addEval(key, value, path);
  }

  setEval(key: string, value: unknown, path?: string[]) {
    this.debug.setEval(key, value, path);
  }

  /**
   * addError() - Add an error entry to stage metadata
   */
  addError(key: string, value: unknown, path?: string[]) {
    this.debug.addError(key, value, path);
  }

  /**
   * @deprecated Use addError() instead
   */
  addErrorInfo(key: string, value: unknown, path?: string[]) {
    this.addError(key, value, path);
  }

  /**
   * addFlowDebugMessage() - Add a flow control narrative entry
   * 
   * Flow messages capture control flow decisions made by the execution engine.
   * They form the "headings" in the narrative story, complementing the
   * stage-level "bullet points" from addDebugMessage/addLog.
   *
   * @param type - The type of flow control decision (next, branch, children, etc.)
   * @param description - Human-readable description of the decision
   * @param options - Optional metadata (targetStage, rationale, count, iteration)
   *
   * _Requirements: flow-control-narrative REQ-1_
   */
  addFlowDebugMessage(
    type: FlowControlType,
    description: string,
    options?: {
      targetStage?: string | string[];
      rationale?: string;
      count?: number;
      iteration?: number;
    },
  ) {
    const flowMessage: FlowMessage = {
      type,
      description,
      timestamp: Date.now(),
      ...options,
    };
    this.debug.addFlowMessage(flowMessage);
  }

  /**
   * getStageId() - Get a unique identifier for this stage
   * 
   * Combines pipelineId and stageName to create a path-like ID.
   * Used to link subflow results back to their parent stage.
   */
  getStageId(): string {
    if (!this.pipelineId || this.pipelineId === '') {
      return this.stageName;
    }
    return `${this.pipelineId}.${this.stageName}`;
  }

  /**
   * getSnapshot() - Get a serializable snapshot of this stage's state
   * 
   * Returns a lightweight tree representation used by unit tests
   * and the debugging endpoint.
   *
   * _Requirements: flow-control-narrative REQ-5_
   */
  getSnapshot(): StageSnapshot {
    const snapshot: StageSnapshot = {
      id: this.pipelineId,
      name: this.stageName,
      isDecider: this.isDecider,
      isFork: this.isFork,
      logs: this.debug.logContext,
      errors: this.debug.errorContext,
      metrics: this.debug.metricContext,
      evals: this.debug.evalContext,
    };

    // Include flow messages if any exist
    if (this.debug.flowMessages.length > 0) {
      snapshot.flowMessages = this.debug.flowMessages;
    }

    if (this.next) {
      snapshot.next = this.next?.getSnapshot();
    }
    if (this.children) {
      snapshot.children = this.children?.map((child) => {
        return child.getSnapshot();
      });
    }
    return snapshot;
  }

  /**
   * @deprecated Use getSnapshot() instead
   */
  getJson(): StageSnapshot {
    return this.getSnapshot();
  }
}
