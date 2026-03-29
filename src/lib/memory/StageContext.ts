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
import type { FlowControlType, FlowMessage, StageSnapshot } from './types.js';
import { redactPatch } from './utils.js';

export class StageContext {
  private sharedMemory: SharedMemory;
  private buffer?: TransactionBuffer;
  private eventLog?: EventLog;

  public stageName = '';
  /** Unique stage identifier from the builder (matches spec node id). */
  public stageId: string;
  public runId: string;
  public branchId?: string;
  public isDecider: boolean;
  public isFork: boolean;
  /** Human-readable description from builder (set by traverser before execution). */
  public description?: string;
  /** Subflow identifier (set by traverser when this is a subflow entry point). */
  public subflowId?: string;

  public parent?: StageContext;
  public next?: StageContext;
  public children?: StageContext[];

  public debug: DiagnosticCollector = new DiagnosticCollector();

  /** Tracks user-level writes (pre-namespace) for the memory view. */
  private _stageWrites: Record<string, unknown> = {};

  /** Tracks user-level reads (pre-namespace) for the memory view. */
  private _stageReads: Record<string, unknown> = {};

  constructor(
    runId: string,
    name: string,
    stageId: string,
    sharedMemory: SharedMemory,
    branchId?: string,
    eventLog?: EventLog,
    isDecider?: boolean,
  ) {
    this.runId = runId;
    this.stageName = name;
    this.stageId = stageId;
    this.sharedMemory = sharedMemory;
    this.branchId = branchId;
    this.eventLog = eventLog;
    this.isDecider = !!isDecider;
    this.isFork = false;
  }

  /** Returns the SharedMemory instance (needed by scope layer). */
  getSharedMemory(): SharedMemory {
    return this.sharedMemory;
  }

  /** Lazily creates the transaction buffer (pay clone cost only if stage writes). */
  getTransactionBuffer(): TransactionBuffer {
    if (!this.buffer) {
      this.buffer = new TransactionBuffer(this.sharedMemory.getState());
    }
    return this.buffer;
  }

  /** Builds an absolute path inside the shared memory (run namespace). */
  private withNamespace(path: string[], key: string): string[] {
    if (!this.runId || this.runId === '') {
      return [...path, key];
    }
    return ['runs', this.runId, ...path, key];
  }

  // ── Write operations ───────────────────────────────────────────────────

  patch(path: string[], key: string, value: unknown, shouldRedact = false) {
    this.getTransactionBuffer().set(this.withNamespace(path, key), value, shouldRedact);
  }

  set(path: string[], key: string, value: unknown) {
    this.patch(path, key, value);
  }

  merge(path: string[], key: string, value: unknown) {
    this.getTransactionBuffer().merge(this.withNamespace(path, key), value);
  }

  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    this.patch(path, key, value, shouldRedact ?? false);
    // Track user-level write (pre-namespace) for memory view
    const userKey = path.length > 0 ? [...path, key].join('.') : key;
    this._stageWrites[userKey] = shouldRedact ? '[REDACTED]' : structuredClone(value);
    if (description) {
      const tagged = description.startsWith('[') ? description : `[WRITE] ${description}`;
      this.debug.addLog('message', tagged);
    }
  }

  updateObject(path: string[], key: string, value: unknown, description?: string) {
    this.merge(path, key, value);
    // Track user-level write (pre-namespace) for memory view
    const userKey = path.length > 0 ? [...path, key].join('.') : key;
    this._stageWrites[userKey] = structuredClone(value);
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  setRoot(key: string, value: unknown) {
    this.patch([], key, value);
  }

  setGlobal(key: string, value: unknown, description?: string) {
    this.getTransactionBuffer().set([key], value);
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  updateGlobalContext(key: string, value: unknown) {
    this.getTransactionBuffer().set([key], value);
  }

  appendToArray(path: string[], key: string, items: unknown[], description?: string) {
    const existing = this.getValue(path, key);
    const merged = Array.isArray(existing) ? [...existing, ...items] : [...items];
    this.setObject(path, key, merged, false, description);
  }

  mergeObject(path: string[], key: string, obj: Record<string, unknown>, description?: string) {
    const existing = this.getValue(path, key);
    const merged =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), ...obj }
        : { ...obj };
    this.setObject(path, key, merged, false, description);
  }

  // ── Read operations ────────────────────────────────────────────────────

  getValue(path: string[], key?: string, description?: string) {
    const buf = this.getTransactionBuffer();
    const fromPatch = buf.get(this.withNamespace(path, key as string));
    const value = typeof fromPatch !== 'undefined' ? fromPatch : this.sharedMemory.getValue(this.runId, path, key);
    // Track user-level read (pre-namespace) for memory view
    if (key !== undefined) {
      const userKey = path.length > 0 ? [...path, key].join('.') : key;
      this._stageReads[userKey] = value !== undefined ? structuredClone(value) : undefined;
    }
    if (description) {
      this.debug.addLog('message', `[READ] ${description}`);
    }
    return value;
  }

  getRoot(key: string) {
    return this.sharedMemory.getValue(this.runId, [], key);
  }

  getGlobal(key: string) {
    return this.sharedMemory.getValue('', [], key);
  }

  getScope(): Record<string, unknown> {
    return this.sharedMemory.getState();
  }

  getRunId(): string {
    return this.runId;
  }

  // ── Commit ─────────────────────────────────────────────────────────────

  commit(): void {
    const buf = this.getTransactionBuffer();
    const bundle = buf.commit();
    const commitBundle = { ...bundle, stage: this.stageName };

    this.sharedMemory.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);

    const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
    const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);
    this.eventLog?.record({
      ...commitBundle,
      redactedPaths: Array.from(commitBundle.redactedPaths.values()),
      overwrite: redactedOverwrite,
      updates: redactedUpdates,
    });
  }

  // ── Tree navigation ────────────────────────────────────────────────────

  createNext(path: string, stageName: string, stageId: string, isDecider = false): StageContext {
    if (!this.next) {
      this.next = new StageContext(path, stageName, stageId, this.sharedMemory, '', this.eventLog, isDecider);
      this.next.parent = this;
    }
    return this.next;
  }

  createChild(runId: string, branchId: string, stageName: string, stageId: string, isDecider = false): StageContext {
    if (!this.children) {
      this.children = [];
    }
    const child = new StageContext(runId, stageName, stageId, this.sharedMemory, branchId, this.eventLog, isDecider);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  createDecider(path: string, stageName: string, stageId: string): StageContext {
    return this.createNext(path, stageName, stageId, true);
  }

  setAsDecider(): StageContext {
    this.isDecider = true;
    return this;
  }

  setAsFork(): StageContext {
    this.isFork = true;
    return this;
  }

  // ── Diagnostics delegation ─────────────────────────────────────────────

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
    options?: { targetStage?: string | string[]; rationale?: string; count?: number; iteration?: number },
  ) {
    const flowMessage: FlowMessage = { type, description, timestamp: Date.now(), ...options };
    this.debug.addFlowMessage(flowMessage);
  }

  // ── Snapshot ───────────────────────────────────────────────────────────

  getStageId(): string {
    if (!this.runId || this.runId === '') return this.stageName;
    return `${this.runId}.${this.stageName}`;
  }

  getSnapshot(): StageSnapshot {
    const snapshot: StageSnapshot = {
      id: this.stageId,
      name: this.stageName,
      isDecider: this.isDecider,
      isFork: this.isFork,
      logs: this.debug.logContext,
      errors: this.debug.errorContext,
      metrics: this.debug.metricContext,
      evals: this.debug.evalContext,
    };
    if (Object.keys(this._stageWrites).length > 0) {
      snapshot.stageWrites = this._stageWrites;
    }
    if (Object.keys(this._stageReads).length > 0) {
      snapshot.stageReads = this._stageReads;
    }
    if (this.description) {
      snapshot.description = this.description;
    }
    if (this.subflowId) {
      snapshot.subflowId = this.subflowId;
    }
    if (this.debug.flowMessages.length > 0) {
      snapshot.flowMessages = this.debug.flowMessages;
    }
    if (this.next) {
      snapshot.next = this.next.getSnapshot();
    }
    if (this.children) {
      snapshot.children = this.children.map((c) => c.getSnapshot());
    }
    return snapshot;
  }
}
