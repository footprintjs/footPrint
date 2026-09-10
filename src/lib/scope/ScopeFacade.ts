/**
 * ScopeFacade — Base class that library consumers extend to create custom scope classes
 *
 * Wraps StageContext (from memory/) to provide a consumer-friendly API for
 * state access, debug logging, metrics, and recorder hooks.
 *
 * Consumers extend this class to add domain-specific properties:
 *
 * ```typescript
 * class MyScope extends ScopeFacade {
 *   get userName(): string { return this.getValue('name') as string; }
 *   set userName(value: string) { this.setValue('name', value); }
 * }
 * ```
 */

import {
  detachAndForget as detachAndForgetSpawn,
  detachAndJoinLater as detachAndJoinLaterSpawn,
} from '../detach/spawn.js';
import type { ExecutionEnv } from '../engine/types.js';
import { CLEAR, RedactionRule } from '../memory/redaction.js';
import { StageContext } from '../memory/StageContext.js';
import { invokeRecorderHook } from '../recorder/invokeHook.js';
import { hasCircularReference, isDevMode } from './detectCircular.js';
import { assertNotReadonly, createFrozenArgs } from './protection/readonlyInput.js';
import type { CommitEvent, RedactionPolicy, RedactionReport, ScopeRecorder } from './types.js';

export class ScopeFacade {
  public static readonly BRAND = Symbol.for('ScopeFacade@v1');

  /**
   * Shared sentinel returned by `_getSubflowPath()` for root-level stages
   * (no subflow nesting). Avoids per-call allocation of a fresh
   * `Object.freeze([])` on every `emitEvent` in the common no-subflow case.
   */
  private static readonly _EMPTY_SUBFLOW_PATH: readonly string[] = Object.freeze([]);

  protected _stageContext: StageContext;
  protected _stageName: string;
  protected readonly _readOnlyValues?: unknown;

  /** Cached deeply-frozen copy of readOnlyValues for getArgs(). Created once. */
  private readonly _frozenArgs: Record<string, unknown>;

  /** Execution environment — read-only, inherited from parent executor. */
  private readonly _executionEnv: Readonly<ExecutionEnv>;

  /** RFC-003 D2: true when `getArgs()` can return actual data — an empty
   *  `{}` read carries no information, so it is never flagged. */
  private readonly _hasArgs: boolean;

  /** RFC-003 D2: true when `getEnv()` can return actual data. */
  private readonly _hasEnv: boolean;

  /**
   * RFC-003 D2: keys this stage has TRACKED-read (via `getValue(key)`).
   * A silent read of a key in this set is SHADOWED — its read→write edge is
   * already captured, so it is not flagged as an untracked source. This is
   * what keeps TypedScope array-proxy internals (which always follow a
   * tracked property read) and `$batchArray` honest-but-quiet.
   */
  private readonly _trackedReadKeys = new Set<string>();

  private _recorders: ScopeRecorder[] = [];
  /**
   * A rule of this facade's own — ONLY when its context carries none (bare
   * contexts in unit tests). Under an executor the rule lives on the context
   * tree and this stays unset; see {@link rule}.
   */
  private _localRule?: RedactionRule;

  constructor(context: StageContext, stageName: string, readOnlyValues?: unknown, executionEnv?: ExecutionEnv) {
    this._stageContext = context;
    this._stageName = stageName;
    this._readOnlyValues = readOnlyValues;
    this._frozenArgs = createFrozenArgs(readOnlyValues);
    this._executionEnv = Object.freeze({ ...executionEnv });
    this._hasArgs = Object.keys(this._frozenArgs).length > 0;
    this._hasEnv = Object.keys(this._executionEnv).length > 0;
    // The context must carry the rule BEFORE the first write, since the
    // context's write funnel is what marks a per-call redacted key on it.
    // Under an executor the context already has the run's rule (installed on
    // the root, inherited down) and this re-installs the same object; on a
    // bare context it installs a fresh one.
    this._stageContext.useRedactionRule?.(this.rule);

    // Register as commit observer so ScopeRecorder.onCommit fires when StageContext.commit() is called
    this._stageContext.setCommitObserver((mutations) => {
      this._onCommitFired(mutations);
    });
  }

  /**
   * The redaction rule this facade decides with — the SAME object its
   * `StageContext` retains with (`memory/redaction.ts`, the one owner). Under
   * an executor the rule is installed on the runtime root and inherited by
   * every context, so the facade simply reads it. On a bare context (unit
   * tests, hand-built scopes) the facade creates one and installs it on the
   * context, so the context's retention and the facade's recorder views
   * still share a single verdict.
   */
  private get rule(): RedactionRule {
    const shared = this._stageContext.getRedactionRule?.();
    if (shared) return shared;
    if (!this._localRule) {
      this._localRule = new RedactionRule();
      this._stageContext.useRedactionRule?.(this._localRule);
    }
    return this._localRule;
  }

  /**
   * Share a redacted-keys set across multiple ScopeFacade instances.
   * Call this to make redaction persist across stages in the same pipeline.
   * (Under an executor the run's rule already shares one set; this call is
   * then a no-op.)
   * @internal
   */
  useSharedRedactedKeys(sharedSet: Set<string>): void {
    this.rule.useMarkedKeys(sharedSet);
  }

  /**
   * Returns the current redacted-keys set (for sharing with other scopes).
   * @internal
   */
  getRedactedKeys(): Set<string> {
    return this.rule.markedKeys();
  }

  /**
   * Apply a declarative redaction policy. The policy is additive —
   * it works alongside manual `setValue(..., true)` calls.
   * @internal
   */
  useRedactionPolicy(policy: RedactionPolicy): void {
    this.rule.setPolicy(policy);
  }

  /** @internal */
  getRedactionPolicy(): RedactionPolicy | undefined {
    return this.rule.getPolicy();
  }

  /**
   * Returns a compliance-friendly report of all redaction activity.
   * Never includes actual values — only key names, field names, and patterns.
   */
  getRedactionReport(): RedactionReport {
    return this.rule.report();
  }

  // ── ScopeRecorder Management ──────────────────────────────────────────────────

  attachScopeRecorder(recorder: ScopeRecorder): void {
    // Replace existing recorder with same ID (idempotent — prevents double-counting)
    this._recorders = this._recorders.filter((r) => r.id !== recorder.id);
    this._recorders.push(recorder);
  }

  detachScopeRecorder(recorderId: string): void {
    this._recorders = this._recorders.filter((r) => r.id !== recorderId);
  }

  getScopeRecorders(): ScopeRecorder[] {
    return [...this._recorders];
  }

  /** @internal */
  notifyStageStart(): void {
    this._invokeHook('onStageStart', {
      stageName: this._stageName,
      stageId: this._stageContext.stageId,
      runtimeStageId: this._stageContext.runtimeStageId,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
    });
  }

  /** @internal */
  notifyStageEnd(duration?: number): void {
    this._invokeHook('onStageEnd', {
      stageName: this._stageName,
      stageId: this._stageContext.stageId,
      runtimeStageId: this._stageContext.runtimeStageId,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
      duration,
    });
  }

  /** @internal */
  notifyPause(pauseData?: unknown): void {
    this._invokeHook('onPause', {
      stageName: this._stageName,
      stageId: this._stageContext.stageId,
      runtimeStageId: this._stageContext.runtimeStageId,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
      pauseData,
      channel: 'scope' as const,
    });
  }

  /** @internal */
  notifyResume(hasInput: boolean): void {
    this._invokeHook('onResume', {
      stageName: this._stageName,
      stageId: this._stageContext.stageId,
      runtimeStageId: this._stageContext.runtimeStageId,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
      hasInput,
      channel: 'scope' as const,
    });
  }

  /** @internal */
  notifyCommit(mutations: CommitEvent['mutations']): void {
    this._invokeHook('onCommit', {
      stageName: this._stageName,
      stageId: this._stageContext.stageId,
      runtimeStageId: this._stageContext.runtimeStageId,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
      mutations,
    });
  }

  /** Called by StageContext.commit() observer. Converts tracked writes to CommitEvent format.
   *  Errors are caught to prevent recorder issues from aborting the traversal. */
  private _onCommitFired(mutations: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }>): void {
    if (this._recorders.length === 0) return;

    try {
      // `_stageWrites` already holds the retained form (the context retains
      // under the same rule); applying the verdict again here is idempotent
      // and keeps a key marked AFTER its write scrubbed at commit time.
      const commitMutations: CommitEvent['mutations'] = Object.entries(mutations).map(([key, entry]) => ({
        key,
        value: this.rule.retain([key], entry.value),
        operation: entry.operation,
      }));

      this.notifyCommit(commitMutations);
    } catch {
      // Swallow — recorder errors must not abort the traversal.
      // Individual recorder errors are already isolated by _invokeHook.
    }
  }

  // ── Debug / Diagnostics ──────────────────────────────────────────────────
  //
  // These legacy methods still write to the `StageContext` diagnostic
  // side bags (logContext / errorContext / metricContext / evalContext) for
  // snapshot inclusion. They ALSO fire through the Emit channel so any
  // attached `EmitRecorder` sees them in real time — closing the
  // long-standing gap where `$debug`/`$metric` went to unobserved bags.

  addDebugInfo(key: string, value: unknown) {
    this._stageContext.addLog(key, value);
    this.emitEvent(`log.debug.${key}`, { key, value, level: 'debug' });
  }

  addDebugMessage(value: unknown) {
    this._stageContext.addLog('messages', [value]);
    this.emitEvent('log.debug.messages', { value, level: 'debug' });
  }

  addErrorInfo(key: string, value: unknown) {
    this._stageContext.addError(key, value);
    this.emitEvent(`log.error.${key}`, { key, value, level: 'error' });
  }

  addMetric(metricName: string, value: unknown) {
    this._stageContext.addMetric(metricName, value);
    this.emitEvent(`metric.${metricName}`, { name: metricName, value });
  }

  addEval(metricName: string, value: unknown) {
    this._stageContext.addEval(metricName, value);
    this.emitEvent(`eval.${metricName}`, { name: metricName, value });
  }

  // ── Emit — Phase 3 primary primitive ─────────────────────────────────────

  /**
   * Fire a structured event to every attached recorder implementing
   * `onEmit`. Synchronous, in-order, pass-through — no buffering.
   *
   * - **Fast-path**: zero allocation + zero cost when no recorders are
   *   attached (early return on empty list).
   * - **Enrichment**: library auto-adds `stageName`, `runtimeStageId`,
   *   `subflowPath`, `pipelineId`, `timestamp` to the event.
   * - **Redaction**: `RedactionPolicy.emitPatterns` regexes are matched
   *   against `name` — matched events have their payload replaced with
   *   `'[REDACTED]'` before dispatch.
   * - **Error isolation**: a throwing `onEmit` does not propagate — it is
   *   caught and routed to `onError` on remaining recorders, matching the
   *   pattern used by other scope events.
   *
   * Consumers call this via the `scope.$emit(name, payload)` scope method;
   * the method routes here via `createTypedScope`.
   */
  emitEvent(name: string, payload: unknown): void {
    // Fast-path: zero work when no recorders are attached.
    if (this._recorders.length === 0) return;

    // Redaction: if the event name matches any emitPattern, replace payload
    // with '[REDACTED]' BEFORE constructing the event (no leak through
    // copy-on-write, no way for recorders to see the raw value).
    let finalPayload: unknown = payload;
    const patterns = this.rule.getPolicy()?.emitPatterns;
    if (patterns && patterns.length > 0) {
      for (const pattern of patterns) {
        if (pattern.test(name)) {
          finalPayload = '[REDACTED]';
          break;
        }
      }
    }

    // Build the enriched event once; pass the same reference to all
    // recorders. Since EmitEvent is `readonly`, sharing is safe.
    const event = {
      name,
      payload: finalPayload,
      stageName: this._stageName,
      runtimeStageId: this._stageContext.runtimeStageId,
      subflowPath: this._getSubflowPath(),
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
    } as const;

    // Dispatch with error isolation — same pattern as _invokeHook uses for
    // other scope events. A throwing recorder's error is surfaced via
    // onError on the other recorders; the emit loop continues unaffected.
    for (const recorder of this._recorders) {
      if (typeof recorder.onEmit !== 'function') continue;
      try {
        // Shared invoke helper — the SAME primitive the deferred tier uses
        // at delivery time, so the two delivery paths cannot drift.
        invokeRecorderHook(recorder, 'onEmit', event);
      } catch (error) {
        this._invokeHook('onError', {
          stageName: this._stageName,
          stageId: this._stageContext.stageId,
          runtimeStageId: this._stageContext.runtimeStageId,
          pipelineId: this._stageContext.runId,
          timestamp: Date.now(),
          error: error as Error,
          operation: 'write',
          channel: 'scope' as const,
        });
      }
    }
  }

  // ── Detach — fire-and-forget child flowchart execution ─────────────────
  //
  // Delegates to the shared `detach/spawn` helper, which mints a refId
  // from this stage's `runtimeStageId` and calls `driver.schedule()`.
  // Routed through `createTypedScope` as `scope.$detachAndJoinLater(...)`
  // and `scope.$detachAndForget(...)`.

  /** See `ScopeMethods.$detachAndJoinLater`. */
  detachAndJoinLater(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): import('../detach/types.js').DetachHandle {
    return detachAndJoinLaterSpawn(driver, child, input, this._stageContext.runtimeStageId);
  }

  /** See `ScopeMethods.$detachAndForget`. */
  detachAndForget(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): void {
    detachAndForgetSpawn(driver, child, input, this._stageContext.runtimeStageId);
  }

  /**
   * Build the subflowPath (outer → inner) for event enrichment.
   *
   * Parses from `runtimeStageId` which has the format
   * `[subflowPath/]stageId#executionIndex` (see `lib/engine/runtimeStageId.ts`).
   * Subflow isolation prevents walking the parent-chain across boundaries,
   * so the runtimeStageId — globally unique, includes full path — is the
   * canonical source of truth for the subflow hierarchy at emit time.
   *
   * Examples:
   *   'seed#0'                 → []                    (root)
   *   'sf-inner/inner#5'       → ['sf-inner']
   *   'sf-a/sf-b/stage#3'      → ['sf-a', 'sf-b']      (nested)
   */
  private _getSubflowPath(): readonly string[] {
    const rtid = this._stageContext.runtimeStageId;
    if (!rtid) return ScopeFacade._EMPTY_SUBFLOW_PATH;
    // Strip the trailing `#executionIndex` to isolate the path portion.
    const hashIdx = rtid.lastIndexOf('#');
    const pathPortion = hashIdx >= 0 ? rtid.slice(0, hashIdx) : rtid;
    // pathPortion is now `[subflowPath/]stageId`. Split on '/' and drop the
    // last segment (stageId) — what remains is the subflow path.
    const segments = pathPortion.split('/');
    if (segments.length <= 1) return ScopeFacade._EMPTY_SUBFLOW_PATH;
    return Object.freeze(segments.slice(0, -1));
  }

  // ── Non-Tracking State Inspection (for TypedScope proxy internals) ──────

  /** Returns all state keys without firing onRead. Used by TypedScope ownKeys/has traps. */
  getStateKeys(): string[] {
    const snapshot = this._stageContext.getValue([], undefined);
    if (!snapshot || typeof snapshot !== 'object') return [];
    return Object.keys(snapshot as Record<string, unknown>);
  }

  /** Check key existence without firing onRead. Used by TypedScope has trap.
   *  Contract: returns false for keys never set OR keys set to undefined.
   *  This matches deleteValue() semantics (sets to undefined = deleted). */
  hasKey(key: string): boolean {
    return this._stageContext.getValue([], key) !== undefined;
  }

  /** Read state without firing onRead. Used by array proxy getCurrent() to avoid
   *  phantom reads on internal array operations (.length, .has, iteration, etc.).
   *  The initial property access fires one tracked onRead via getValue(); subsequent
   *  internal array operations use this method to stay silent.
   *  NOTE: Like getValue(), returns the raw value to the caller. Redaction applies
   *  only to recorder dispatch — it does not filter the returned value. This matches
   *  the existing getValue() contract where user code always receives raw data.
   *
   *  RFC-003 D2: a silent read of a key this stage never TRACKED-read marks
   *  the stage's commit with `untrackedSources: ['silent']` — a causal slice
   *  built from onRead events would miss this dependency, and consumers must
   *  be told. Silent reads shadowed by a tracked read of the same key (the
   *  array-proxy pattern above) are not flagged: their edge is captured. A
   *  whole-state silent read (no key) is always flagged. */
  getValueSilent(key?: string): unknown {
    if (key === undefined || !this._trackedReadKeys.has(key)) {
      this._stageContext.markUntrackedSource('silent');
    }
    return this._stageContext.getValueDirect([], key);
  }

  // ── State Access ─────────────────────────────────────────────────────────

  getInitialValueFor(key: string) {
    return this._stageContext.getGlobal?.(key);
  }

  /**
   * Tracked read of shared state.
   *
   * **Read values are BORROWED — do not mutate them.** Since the lazy buffer
   * (#13), reads before the stage's first write return references INTO
   * COMMITTED SHARED STATE, and reads after a write return references into
   * the stage's private transaction-buffer working copy (the eager engine
   * returned references into that working copy for ALL reads). Mutating a
   * returned value in place would corrupt state without a commit record —
   * write changes back via `setValue`/`updateValue` instead. TypedScope
   * consumers are safe automatically: the proxy routes every mutation
   * through `setValue`/`updateValue`/copy-on-write array ops.
   *
   * There is deliberately NO dev-mode freeze guard here: deep-freezing a
   * buffer-served read would freeze the stage's own working copy and make a
   * legitimate read-then-deep-write throw, and freezing a committed-state
   * read mutates an object shared with every other consumer of the live
   * state. See `src/lib/memory/README.md` ("Read values are borrowed").
   *
   * Recorder note: the `onRead` event below passes the SAME live reference
   * (no clone) unless field-level redaction scrubs a copy — recorders must
   * treat event values as read-only too.
   */
  getValue(key?: string) {
    const value = this._stageContext.getValue([], key);

    // RFC-003 D2: remember tracked keys so later SILENT reads of the same
    // key count as shadowed (edge already captured) instead of untracked.
    if (key !== undefined) this._trackedReadKeys.add(key);

    if (this._recorders.length > 0) {
      // A whole-state read (no key) is served with every redacted key inside
      // it scrubbed; a keyed read is served under the key's verdict.
      const verdict = key === undefined ? CLEAR : this.rule.verdict([key]);
      const recorderValue = key === undefined ? this.rule.retainRecord(value) : RedactionRule.apply(verdict, value);

      this._invokeHook('onRead', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: recorderValue,
        redacted: verdict.kind !== 'clear' || undefined,
      });
    }

    return value;
  }

  setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    assertNotReadonly(this._readOnlyValues, key, 'write');

    // Dev-mode: warn if the value contains circular references.
    // Check AFTER assertNotReadonly — don't warn for writes that will be blocked.
    // Circular values work (terminal proxy handles them) but can produce
    // surprising behavior in narrative, JSON serialization, and snapshots.
    if (isDevMode() && value !== null && typeof value === 'object') {
      if (hasCircularReference(value)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[footprint] Circular reference detected in setValue('${key}'). ` +
            'Writes past the cycle depth will use terminal proxy tracking. ' +
            'Consider flattening the data structure.',
        );
      }
    }

    // The context is the ONE funnel: it decides the verdict (explicit flag,
    // policy key/pattern, per-run mark, or field-level scrub), stages the
    // write with the paths the log will scrub, and hands the verdict back so
    // recorders see the same decision the retained record holds.
    const verdict = this._stageContext.setObject([], key, value, shouldRedact, description);

    if (this._recorders.length > 0) {
      this._invokeHook('onWrite', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: RedactionRule.apply(verdict, value),
        operation: 'set',
        redacted: verdict.kind !== 'clear' || undefined,
      });
    }
  }

  updateValue(key: string, value: unknown, description?: string) {
    assertNotReadonly(this._readOnlyValues, key, 'write');

    // Dev-mode: same circular check as setValue (merge targets can be circular too)
    if (isDevMode() && value !== null && typeof value === 'object') {
      if (hasCircularReference(value)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[footprint] Circular reference detected in updateValue('${key}'). ` +
            'Consider flattening the data structure.',
        );
      }
    }

    const verdict = this._stageContext.updateObject([], key, value, description);

    if (this._recorders.length > 0) {
      this._invokeHook('onWrite', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: RedactionRule.apply(verdict, value),
        operation: 'update',
        redacted: verdict.kind !== 'clear' || undefined,
      });
    }
  }

  deleteValue(key: string, description?: string) {
    assertNotReadonly(this._readOnlyValues, key, 'delete');

    // Deleting a key clears its per-call redaction mark (the context's
    // funnel does that); a policy verdict on the key survives.
    this._stageContext.setObject([], key, undefined, false, description ?? `deleted ${key}`, 'delete');

    if (this._recorders.length > 0) {
      this._invokeHook('onWrite', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: undefined,
        operation: 'delete',
      });
    }
  }

  /** @internal */
  setGlobal(key: string, value: unknown, description?: string) {
    return this._stageContext.setGlobal?.(key, value, description);
  }

  /** @internal */
  getGlobal(key: string) {
    return this._stageContext.getGlobal?.(key);
  }

  /** @internal */
  setObjectInRoot(key: string, value: unknown) {
    return this._stageContext.setRoot?.(key, value);
  }

  // ── Read-only + misc ─────────────────────────────────────────────────────

  /**
   * Returns the readonly input values passed to this pipeline, cast to `T`.
   * The returned object is deeply frozen — any attempt to mutate it throws.
   * Cached at construction time for zero-allocation repeated access.
   *
   * ```typescript
   * const { applicantName, income } = scope.getArgs<{ applicantName: string; income: number }>();
   * ```
   *
   * RFC-003 D2: args are untracked BY DESIGN, so calling this (with actual
   * input present) marks the stage's commit with `untrackedSources: ['args']`
   * — telling causal-slice consumers the backward slice may be incomplete
   * here. An empty-args read carries no information and is not flagged.
   */
  getArgs<T = Record<string, unknown>>(): T {
    if (this._hasArgs) this._stageContext.markUntrackedSource('args');
    return this._frozenArgs as T;
  }

  /**
   * Returns the execution environment — read-only infrastructure values
   * that propagate through nested executors (like `process.env` for flowcharts).
   *
   * Contains: signal (abort), timeoutMs, traceId.
   * Frozen at construction time. Inherited by subflows automatically.
   *
   * ```typescript
   * const { signal, traceId } = scope.getEnv();
   * ```
   *
   * RFC-003 D2: env is untracked BY DESIGN, so calling this (with a
   * non-empty environment) marks the stage's commit with
   * `untrackedSources: ['env']` — see {@link getArgs}.
   */
  getEnv(): Readonly<ExecutionEnv> {
    if (this._hasEnv) this._stageContext.markUntrackedSource('env');
    return this._executionEnv;
  }

  /** @internal */
  getPipelineId() {
    return this._stageContext.runId;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _invokeHook(hook: keyof Omit<ScopeRecorder, 'id'>, event: unknown): void {
    for (const recorder of this._recorders) {
      try {
        // Shared invoke helper — the SAME primitive the deferred tier uses
        // at delivery time (RFC-001 §9 mitigation): lookup + `.call(this)`
        // semantics live in exactly one place, so the inline and deferred
        // paths cannot drift.
        invokeRecorderHook(recorder, hook, event);
      } catch (error) {
        if (hook !== 'onError') {
          this._invokeHook('onError', {
            stageName: this._stageName,
            stageId: this._stageContext.stageId,
            runtimeStageId: this._stageContext.runtimeStageId,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            error: error as Error,
            operation: hook === 'onRead' ? 'read' : hook === 'onCommit' ? 'commit' : 'write',
            channel: 'scope' as const,
          });
        }
      }
    }
  }
}
