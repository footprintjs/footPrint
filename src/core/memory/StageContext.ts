/**
 * StageContext - Execution context for a single pipeline stage
 * 
 * WHY: Each stage needs isolated access to shared state with atomic commit
 * semantics. StageContext provides this by wrapping GlobalStore with a
 * WriteBuffer for staged mutations.
 * 
 * DESIGN: Like a stack frame in a compiler/runtime:
 * - Reference to GlobalStore (like accessing heap memory)
 * - WriteBuffer for staging mutations (like a transaction buffer)
 * - Links to parent/child/next contexts (like call stack frames)
 * - Metadata collector for logs, errors, metrics
 * 
 * RESPONSIBILITIES:
 * - Hold ephemeral state for a single stage execution
 * - Delegate reads/writes to WriteBuffer for batching
 * - Atomically commit changes to GlobalStore
 * - Create child/next contexts for tree traversal
 * 
 * RELATED:
 * - {@link GlobalStore} - The shared state container
 * - {@link WriteBuffer} - Transaction buffer for mutations
 * - {@link StageMetadata} - Logs, errors, metrics collector
 * 
 * @example
 * ```typescript
 * const ctx = new StageContext('pipeline-1', 'validate', globalStore);
 * ctx.setObject([], 'name', 'Alice');
 * ctx.commit(); // Atomically applies to GlobalStore
 * ```
 */

import { ExecutionHistory } from '../../internal/history/ExecutionHistory';
import { WriteBuffer } from '../../internal/memory/WriteBuffer';
import { redactPatch } from '../../internal/memory/utils';
import { StageMetadata } from './StageMetadata';
import { GlobalStore } from './GlobalStore';
import { treeConsole } from '../../utils/scopeLog';
import type { FlowControlType, FlowMessage } from '../executor/types';

/**
 * Serializable representation of a stage's state.
 * WHY: Used for debugging, visualization, and time-travel features.
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

export class StageContext {
  private globalStore: GlobalStore;
  private writeBuffer?: WriteBuffer; // Lazily created per stage
  private executionHistory?: ExecutionHistory;

  public stageName = '';
  public pipelineId: string;
  public branchId?: string;
  public isDecider: boolean;
  public isFork: boolean;

  // Links for walking the stage tree
  public parent?: StageContext;
  public next?: StageContext;
  public children?: StageContext[];

  // Per-stage metadata collector
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

  /**
   * Gets the write buffer for staging mutations.
   * WHY: Lazily instantiates so we pay clone cost only if stage writes.
   */
  getWriteBuffer(): WriteBuffer {
    if (!this.writeBuffer) {
      this.writeBuffer = new WriteBuffer(this.globalStore.getState());
    }
    return this.writeBuffer;
  }

  /**
   * Builds an absolute path inside the shared GlobalStore.
   * WHY: Pipelines are namespaced under 'pipelines/{id}/' to prevent collisions.
   */
  private withNamespace(path: string[], key: string): string[] {
    if (!this.pipelineId || this.pipelineId === '') {
      return [...path, key];
    }
    return ['pipelines', this.pipelineId, ...path, key];
  }

  /**
   * Hard overwrite at the specified path.
   */
  patch(path: string[], key: string, value: unknown, shouldRedact = false) {
    this.getWriteBuffer().set(this.withNamespace(path, key), value, shouldRedact);
  }

  set(path: string[], key: string, value: unknown) {
    this.patch(path, key, value);
  }

  /**
   * Deep union merge at the specified path.
   */
  merge(path: string[], key: string, value: unknown) {
    this.getWriteBuffer().merge(this.withNamespace(path, key), value);
  }

  /**
   * Flushes staged mutations into the GlobalStore.
   * WHY: Atomic commit ensures all-or-nothing semantics.
   */
  commit(): void {
    const buffer = this.getWriteBuffer();
    const bundle = buffer.commit();

    const commitBundle = { ...bundle, stage: this.stageName };

    // Apply to global store
    this.globalStore.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);

    // Redact and record to history
    const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
    const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);
    this.executionHistory?.record({
      ...commitBundle,
      redactedPaths: Array.from(commitBundle.redactedPaths.values()),
      overwrite: redactedOverwrite,
      updates: redactedUpdates,
    });

    this.debug.addLog('writeTrace', commitBundle.trace);
  }

  /**
   * Creates the linear successor stage context.
   * WHY: Enables pipeline traversal without duplicating contexts.
   */
  createNext(path: string, stageName: string, isDecider = false): StageContext {
    if (!this.next) {
      this.next = new StageContext(path, stageName, this.globalStore, '', this.executionHistory, isDecider);
      this.next.parent = this;
    }
    return this.next;
  }

  /**
   * Creates a branch context for parallel execution.
   * WHY: Fan-out stages need separate contexts but share GlobalStore.
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

  createDecider(path: string, stageName: string): StageContext {
    return this.createNext(path, stageName, true);
  }

  setAsDecider(): StageContext {
    this.isDecider = true;
    return this;
  }

  setAsFork(): StageContext {
    this.isFork = true;
    return this;
  }

  // Convenience wrappers for common operations
  setRoot(key: string, value: unknown) {
    this.patch([], key, value);
    treeConsole.log(this, this.stageName, [], key, value, true);
  }

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

  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    this.patch(path, key, value, shouldRedact ?? false);
    const logValue = shouldRedact ? 'REDACTED' : value;
    treeConsole.log(this, this.stageName, path, key, logValue, true);
    if (description) {
      const taggedDescription = description.startsWith('[')
        ? description
        : `[WRITE] ${description}`;
      this.debug.addLog('message', taggedDescription);
    }
  }

  /**
   * Append items to an existing array at the given scope path.
   *
   * WHY: Stages and subflow output mappers frequently need to add items to
   * collections (e.g., appending a message to conversation history). Without
   * this primitive, consumers must do a manual read-append-write:
   *   const arr = scope.getValue(key);
   *   arr.push(newItem);
   *   scope.setValue(key, arr);
   *
   * This method encapsulates that pattern as a first-class operation.
   *
   * DESIGN: Reads the existing value, appends new items, writes back the
   * full merged array via setObject. If no existing array is found, the
   * items become the new array. The full array is written to the WriteBuffer,
   * so commit history captures the complete state (not just the delta).
   *
   * FUTURE: For granular "item was appended" tracking in the time traveler,
   * this would need WriteBuffer-level CRDT support. See:
   * docs/future/CRDT-array-operations.md
   *
   * @param path - Scope path (e.g., ['agent'])
   * @param key - Key within the path (e.g., 'messages')
   * @param items - Array of items to append
   * @param description - Optional debug description
   */
  appendToArray(path: string[], key: string, items: unknown[], description?: string) {
    const existing = this.getValue(path, key);
    const merged = Array.isArray(existing) ? [...existing, ...items] : [...items];
    this.setObject(path, key, merged, false, description);
  }

  /**
   * Shallow merge an object into an existing object at the given scope path.
   *
   * WHY: Stages and subflow output mappers frequently need to add keys to
   * existing objects without replacing the entire object. Without this
   * primitive, consumers must do a manual read-merge-write.
   *
   * DESIGN: Reads the existing value, shallow merges new keys (new keys
   * win on conflict), writes back via setObject. If no existing object
   * is found, the new object becomes the value.
   *
   * FUTURE: For granular "key was merged" tracking in the time traveler,
   * this would need WriteBuffer-level CRDT support. See:
   * docs/future/CRDT-array-operations.md
   *
   * @param path - Scope path (e.g., ['agent'])
   * @param key - Key within the path (e.g., 'config')
   * @param obj - Object with keys to merge
   * @param description - Optional debug description
   */
  mergeObject(path: string[], key: string, obj: Record<string, unknown>, description?: string) {
    const existing = this.getValue(path, key);
    const merged = (existing && typeof existing === 'object' && !Array.isArray(existing))
      ? { ...(existing as Record<string, unknown>), ...obj }
      : { ...obj };
    this.setObject(path, key, merged, false, description);
  }

  /**
   * Reads a value with read-after-write semantics.
   * WHY: Staged writes should be visible before commit.
   */
  getValue(path: string[], key?: string, description?: string) {
    const buffer = this.getWriteBuffer();
    const fromPatch = buffer.get(this.withNamespace(path, key as string));
    const value = typeof fromPatch !== 'undefined'
      ? fromPatch
      : this.globalStore.getValue(this.pipelineId, path, key);

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

  getScope(): Record<string, unknown> {
    return this.globalStore.getState();
  }

  // Metadata helpers
  addLog(key: string, value: unknown, path?: string[]) {
    this.debug.addLog(key, value, path);
  }

  setLog(key: string, value: unknown, path?: string[]) {
    this.debug.setLog(key, value, path);
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

  addError(key: string, value: unknown, path?: string[]) {
    this.debug.addError(key, value, path);
  }

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

  getStageId(): string {
    if (!this.pipelineId || this.pipelineId === '') {
      return this.stageName;
    }
    return `${this.pipelineId}.${this.stageName}`;
  }

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
}
