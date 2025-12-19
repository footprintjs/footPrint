/****************************************************************************************
 * StageContext
 * ----------------------------------------------------------------------------
 *  ➤ Holds *ephemeral* state for a single stage execution.
 *  ➤ Delegates all reads/writes to a PatchedMemoryContext so we can batch
 *    changes and atomically commit them into the shared GlobalContext.
 *  ➤ Creates child / next StageContext objects to model linear and branch
 *    execution inside a pipeline.
 ****************************************************************************************/

import { MemoryHistory } from '../stateManagement/MemoryHistory';
import { PatchedMemoryContext } from '../stateManagement/PatchedMemoryContext';
import { redactPatch } from '../stateManagement/utils';
import { DebugContext } from './DebugContext';
import { GlobalContext } from './GlobalContext';
import { treeConsole } from './scopeLog';

export type StageType = {
  id: string,
  name?: string,
  isDecider?: boolean,
  isFork?: boolean,
  logs: Record<string, unknown>,
  errors: Record<string, unknown>,
  metrics: Record<string, unknown>,
  evals: Record<string, unknown>,
  next?: StageType
  children?: StageType[]
}

export class StageContext {
  /* ------------------------------------------------------------------------
   * Data members
   * ---------------------------------------------------------------------- */
  private globalContext: GlobalContext; // reference to the singleton
  private patchedMemory?: PatchedMemoryContext; // lazily created per stage
  private pipelineHistory?: MemoryHistory; // lazily created per stage
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

  /** Per‑stage log & error helper */

  public debug: DebugContext = new DebugContext();
  constructor(
    pipelineId: string,
    name: string,
    globalContext: GlobalContext,
    branchId?: string,
    pipelineHistory?: MemoryHistory,
    isDecider?: boolean,
  ) {
    this.pipelineId = pipelineId;
    this.stageName = name;
    this.globalContext = globalContext;
    this.branchId = branchId;
    this.pipelineHistory = pipelineHistory as MemoryHistory;
    this.isDecider = !!isDecider;
    this.isFork = false;
  }

  /* ==========================================================================
   * Memory‑layer helpers
   * ======================================================================= */

  /**
   * Lazily instantiate PatchedMemoryContext so we pay the clone cost
   * *only* if the stage actually writes something.
   */

  getMemoryContext(): PatchedMemoryContext {
    if (!this.patchedMemory) {
      this.patchedMemory = new PatchedMemoryContext(this.globalContext.getJson());
    }
    return this.patchedMemory;
  }

  /**
   * withNamespace()
   * ------------------------------------------------------------
   * Build an absolute path inside the *shared* AppContext.
   *
   *   • Prepends the pipeline namespace   → ['pipelines', id, …]
   *   • Appends the leaf *key* to the caller‑supplied path.
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
   * patch()   – hard overwrite (“setObject” in legacy code).
   * merge()   – deep union merge  (“updateObject” in legacy code).
   *
   * They both calculate the fully‑qualified path and forward to
   * PatchedMemoryContext so that all writes are batched.
   */
  patch(path: string[], key: string, value: unknown, shouldRedact = false) {
    this.getMemoryContext().set(this.withNamespace(path, key), value, shouldRedact);
  }

  // Implementing ICoreStageContext
  set(path: string[], key: string, value: unknown) {
    this.patch(path, key, value);
  }

  merge(path: string[], key: string, value: unknown) {
    this.getMemoryContext().merge(this.withNamespace(path, key), value);
  }

  /**
   * commitPatch()
   * ------------------------------------------------------------------
   * Flushes the staged mutations into the *global* AppContext.
   *
   *   1. memory.commit()        → { overwrite, updates, owPaths }
   *   2. global.applyPatch()    → applySmartMerge (updates) + _set (overwrites)
   *
   * Side effect: touched path lists are logged for debugging.
   */

  commitPatch(): void {
    const memory = this.getMemoryContext();
    const bundle = memory.commit(); // { overwrite, updates, trace, stage? }

    // 1. add stage name for the history UI
    const commitBundle = { ...bundle, stage: this.stageName };

    // 2. apply to global context
    this.globalContext.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);

    // 3. Redact and Inject to History
    const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
    const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);
    this.pipelineHistory?.record({
      ...commitBundle,
      redactedPaths: Array.from(commitBundle.redactedPaths.values()),
      overwrite: redactedOverwrite,
      updates: redactedUpdates,
    });

    // 4. debug trace
    this.debug.addDebugInfo('writeTrace', commitBundle.trace);
  }

  /* ==========================================================================
   * Stage‑tree helpers
   * ======================================================================= */

  /**
   * createNextContext()
   * ------------------------------------------------------------
   * Returns (and caches) the *linear* successor StageContext so a
   * pipeline can keep calling `.next` without duplicating contexts.
   */
  createNextContext(path: string, stageName: string, isDecider = false): StageContext {
    if (!this.next) {
      this.next = new StageContext(path, stageName, this.globalContext, '', this.pipelineHistory, isDecider);
      this.next.parent = this;
    }
    return this.next;
  }

  /**
   * createChildContext()
   * ------------------------------------------------------------
   * Build a StageContext for a branch executed in parallel (fan‑out).
   * Note: it’s linked via `children[]` **but still shares the same
   *       GlobalContext instance** so writes are synchronised.
   */
  createChildContext(pipelineId: string, branchId: string, stageName: string, isDecider = false): StageContext {
    if (!this.children) {
      this.children = [];
    }
    const childContext = new StageContext(
      pipelineId,
      stageName,
      this.globalContext,
      branchId,
      this.pipelineHistory,
      isDecider,
    );
    childContext.parent = this;
    this.children.push(childContext);
    return childContext;
  }

  /**
   * createDeciderContext()
   * ------------------------------------------------------------
   * Returns (and caches) the *linear* successor StageContext so a
   * pipeline can keep calling `.next` without duplicating contexts.
   */
  createDeciderContext(path: string, stageName: string): StageContext {
    return this.createNextContext(path, stageName, true);
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

  /** Shorthand for hard‑overwrite at root level */

  setRoot(key: string, value: unknown) {
    this.patch([], key, value);
    treeConsole.log(this, this.stageName, [], key, value, true);
  }

  /** Shorthand for deep‑merge in the current pipeline namespace */
  updateObject(path: string[], key: string, value: unknown) {
    this.merge(path, key, value);
    treeConsole.log(this, this.stageName, path, key, value);
  }

  updateGlobalContext(key: string, value: unknown) {
    this.getMemoryContext().set([key], value);
  }

  setGlobal(key: string, value: unknown) {
    this.getMemoryContext().set([key], value);
    treeConsole.log(this, this.stageName, [], key, value, true);
  }

  setObject(path: string[], key: string, value: unknown, shouldRedact = false) {
    this.patch(path, key, value, shouldRedact);
    const logValue = shouldRedact ? 'REDACTED' : value;
    treeConsole.log(this, this.stageName, path, key, logValue, true);
  }

  /* ==========================================================================
   * Read helpers
   * ======================================================================= */

  /**
   * getValue()
   * ------------------------------------------------------------
   * 1. Look in *staged* memory first (read‑after‑write semantics).
   * 2. Fallback to the committed GlobalContext.
   */

  getValue(path: string[], key?: string) {
    const memory = this.getMemoryContext();
    const fromPatch = memory.get(this.withNamespace(path, key as string));
    if (typeof fromPatch !== 'undefined') {
      return fromPatch;
    }
    return this.globalContext.getValue(this.pipelineId, path, key);
  }

  // Implementing ICoreStageContext
  getPipelineId(): string {
    return this.pipelineId;
  }

  // Implementing ICoreStageContext
  get(path: string[], key?: string) {
    // will deprecate once Separate Pipeline scope creation completed
    return this.getValue(path, key);
  }

  getRoot(key: string) {
    return this.globalContext.getValue(this.pipelineId, [], key);
  }

  getGlobal(key: string) {
    return this.globalContext.getValue('', [], key);
  }

  getFromRoot(key: string) {
    return this.globalContext.getValue(this.pipelineId, [], key);
  }

  getFromGlobalContext(key: string) {
    return this.globalContext.getValue('', [], key);
  }

  /* ==========================================================================
   * helpers for debugging / tests
   * ======================================================================= */
  addDebugInfo(key: string, value: unknown, path?: string[]) {
    this.debug.addDebugInfo(key, value, path);
  }

  setDebugInfo(key: string, value: unknown, path?: string[]) {
    this.debug.setDebugInfo(key, value, path);
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

  addErrorInfo(key: string, value: unknown, path?: string[]) {
    this.debug.addErrorInfo(key, value, path);
  }

  /**
   * getJson() – returns a lightweight tree representation used by
   *             unit tests and the debugging endpoint.
   */
  getJson(): StageType {
    const json: StageType = {
      id: this.pipelineId,
      name: this.stageName,
      isDecider: this.isDecider,
      isFork: this.isFork,
      logs: this.debug.logContext,
      errors: this.debug.errorContext,
      metrics: this.debug.metricContext,
      evals: this.debug.evalContext,
    };

    if (this.next) {
      json.next = this.next?.getJson();
    }
    if (this.children) {
      json.children = this.children?.map((child) => {
        return child.getJson();
      });
    }
    return json;
  }
}
