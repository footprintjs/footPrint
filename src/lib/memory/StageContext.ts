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
  /**
   * Parallel redacted mirror of `sharedMemory`. Populated in `commit()` with
   * the already-computed redacted patches (the same ones fed to `eventLog`).
   * Present **only** when the executor has been told to maintain a redacted
   * view — i.e. when a `RedactionPolicy` is configured. Otherwise undefined,
   * zero extra work per commit.
   *
   * The mirror is read via `FlowChartExecutor.getSnapshot({ redact: true })`
   * and is the foundation for the "export trace" / paste-into-viewer feature
   * — consumers share the redacted view externally without leaking raw PII
   * through `sharedState`.
   */
  private redactedSharedMemory?: SharedMemory;
  private buffer?: TransactionBuffer;
  private eventLog?: EventLog;

  public stageName = '';
  /** Unique stage identifier from the builder (matches spec node id). */
  public stageId: string;
  /** Unique per-execution-step identifier. Set by traverser before stage execution. */
  public runtimeStageId = '';
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

  /** Tracks user-level writes (pre-namespace) for the memory view and onCommit. */
  private _stageWrites: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }> = {};

  /** Tracks user-level reads (pre-namespace) for the memory view. */
  private _stageReads: Record<string, unknown> = {};

  /** Observer called after commit() — used by ScopeFacade to fire ScopeRecorder.onCommit. */
  private _commitObserver?: (
    mutations: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }>,
  ) => void;

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

  /**
   * Install a parallel redacted mirror. Subsequent `commit()` calls will
   * apply the already-computed redacted patches to this mirror in addition
   * to the raw `sharedMemory` + `eventLog`. Child / next contexts inherit
   * the mirror via `createNext` / `createChild`.
   *
   * Called once at the root context by `ExecutionRuntime.enableRedactedMirror()`.
   */
  useRedactedMirror(mirror: SharedMemory): void {
    this.redactedSharedMemory = mirror;
  }

  /** Returns the redacted mirror if installed, else undefined. */
  getRedactedSharedMemory(): SharedMemory | undefined {
    return this.redactedSharedMemory;
  }

  /** Lazily creates the transaction buffer on the stage's FIRST WRITE (#13).
   *
   *  Reads NEVER construct it: read-your-writes only matters once a staged
   *  write exists, so before that {@link getValue}/{@link getValueDirect} read
   *  straight from SharedMemory and {@link commit} records an empty bundle —
   *  all with ZERO `structuredClone`s of the shared state. The `baseSnapshot`
   *  captured here is identical to one captured at stage entry, because stage
   *  writes only reach SharedMemory at commit time — the state cannot have
   *  changed under this stage between its entry and its first write. */
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

  setObject(
    path: string[],
    key: string,
    value: unknown,
    shouldRedact?: boolean,
    description?: string,
    operationOverride?: 'set' | 'delete',
  ) {
    this.patch(path, key, value, shouldRedact ?? false);
    // Track user-level write (pre-namespace) for memory view + onCommit
    const userKey = path.length > 0 ? [...path, key].join('.') : key;
    this._stageWrites[userKey] = {
      value: shouldRedact ? '[REDACTED]' : structuredClone(value),
      operation: operationOverride ?? 'set',
    };
    if (description) {
      const tagged = description.startsWith('[') ? description : `[WRITE] ${description}`;
      this.debug.addLog('message', tagged);
    }
  }

  updateObject(path: string[], key: string, value: unknown, description?: string, shouldRedact?: boolean) {
    this.merge(path, key, value);
    // Track user-level write (pre-namespace) for memory view + onCommit
    const userKey = path.length > 0 ? [...path, key].join('.') : key;
    this._stageWrites[userKey] = {
      value: shouldRedact ? '[REDACTED]' : structuredClone(value),
      operation: 'update',
    };
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

  /** Buffer-aware read. Consults staged writes when the buffer exists
   *  (read-your-writes), otherwise reads straight from SharedMemory — reads
   *  never construct the buffer (#13), so a stage that never writes performs
   *  zero clones of the shared state. */
  private readState(path: string[], key?: string): unknown {
    if (this.buffer) {
      const fromPatch = this.buffer.get(this.withNamespace(path, key as string));
      if (typeof fromPatch !== 'undefined') return fromPatch;
    }
    return this.sharedMemory.getValue(this.runId, path, key);
  }

  getValue(path: string[], key?: string, description?: string) {
    const value = this.readState(path, key);
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

  /** Read state without tracking in _stageReads or paying structuredClone cost.
   *  Used by ScopeFacade.getValueSilent() for array proxy internal operations. */
  getValueDirect(path: string[], key?: string): unknown {
    return this.readState(path, key);
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

  /** Register an observer that fires after commit() applies patches.
   *  Used by ScopeFacade to dispatch ScopeRecorder.onCommit events. */
  setCommitObserver(
    observer: (mutations: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }>) => void,
  ): void {
    this._commitObserver = observer;
  }

  commit(): void {
    if (!this.buffer) {
      // Truly-lazy fast path (#13): no write ever constructed the buffer, so
      // the stage's net change is empty BY CONSTRUCTION. Same observable
      // outcome as an empty commit — the (empty) bundle is still recorded so
      // every executed stage remains a time-travel cursor stop — but with
      // ZERO clones: no buffer construction, no applyPatch replay.
      this.eventLog?.record({
        overwrite: {},
        updates: {},
        redactedPaths: [],
        trace: [],
        stage: this.stageName,
        stageId: this.stageId,
        runtimeStageId: this.runtimeStageId,
      });
      if (this._commitObserver) {
        this._commitObserver({ ...this._stageWrites });
      }
      return;
    }

    const bundle = this.buffer.commit();
    const commitBundle = {
      ...bundle,
      stage: this.stageName,
      stageId: this.stageId,
      runtimeStageId: this.runtimeStageId,
    };

    this.sharedMemory.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);

    // Already-computed redacted patches feed three consumers:
    //   1. the parallel redacted mirror (if enabled)
    //   2. the event log (persisted trace)
    //   3. (future) anything else that wants a scrubbed view at commit time
    // Computing once keeps cost linear in the commit size; no post-pass walk.
    const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
    const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);

    this.redactedSharedMemory?.applyPatch(redactedOverwrite, redactedUpdates, commitBundle.trace);

    this.eventLog?.record({
      ...commitBundle,
      redactedPaths: Array.from(commitBundle.redactedPaths.values()),
      overwrite: redactedOverwrite,
      updates: redactedUpdates,
    });

    // Notify observer (ScopeFacade) with tracked mutations
    if (this._commitObserver) {
      this._commitObserver({ ...this._stageWrites });
    }
  }

  // ── Tree navigation ────────────────────────────────────────────────────

  createNext(path: string, stageName: string, stageId: string, isDecider = false): StageContext {
    if (!this.next) {
      this.next = new StageContext(path, stageName, stageId, this.sharedMemory, '', this.eventLog, isDecider);
      this.next.parent = this;
      // Propagate the redacted mirror down the context tree so every commit
      // in the run writes to both views.
      if (this.redactedSharedMemory) this.next.redactedSharedMemory = this.redactedSharedMemory;
    }
    return this.next;
  }

  createChild(runId: string, branchId: string, stageName: string, stageId: string, isDecider = false): StageContext {
    if (!this.children) {
      this.children = [];
    }
    const child = new StageContext(runId, stageName, stageId, this.sharedMemory, branchId, this.eventLog, isDecider);
    child.parent = this;
    if (this.redactedSharedMemory) child.redactedSharedMemory = this.redactedSharedMemory;
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
    // Iterative walk (explicit work stack), NOT recursion: the execution
    // tree deepens by one level per executed stage along `next` chains, and
    // the trampolined traverser allows chains/loops of tens of thousands of
    // stages — far deeper than a recursive serializer can walk before
    // "Maximum call stack size exceeded".
    const root = this.snapshotSelf();
    const work: Array<{ ctx: StageContext; snap: StageSnapshot }> = [{ ctx: this, snap: root }];
    while (work.length > 0) {
      const { ctx, snap } = work.pop()!;
      if (ctx.next) {
        const nextSnap = ctx.next.snapshotSelf();
        snap.next = nextSnap;
        work.push({ ctx: ctx.next, snap: nextSnap });
      }
      if (ctx.children) {
        snap.children = ctx.children.map((child) => {
          const childSnap = child.snapshotSelf();
          work.push({ ctx: child, snap: childSnap });
          return childSnap;
        });
      }
    }
    return root;
  }

  /** Snapshot of THIS context's own fields — `next`/`children` are filled
   *  in by the iterative walk in `getSnapshot`. */
  private snapshotSelf(): StageSnapshot {
    const snapshot: StageSnapshot = {
      id: this.stageId,
      runtimeStageId: this.runtimeStageId || undefined,
      name: this.stageName,
      isDecider: this.isDecider,
      isFork: this.isFork,
      logs: this.debug.logContext,
      errors: this.debug.errorContext,
      metrics: this.debug.metricContext,
      evals: this.debug.evalContext,
    };
    if (Object.keys(this._stageWrites).length > 0) {
      // Extract values only for the snapshot (strip operation metadata)
      const writes: Record<string, unknown> = {};
      for (const [k, entry] of Object.entries(this._stageWrites)) {
        writes[k] = entry.value;
      }
      snapshot.stageWrites = writes;
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
    return snapshot;
  }
}
