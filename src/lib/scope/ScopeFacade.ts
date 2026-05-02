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
import { nativeHas as lodashHas, nativeSet as lodashSet } from '../memory/pathOps.js';
import { StageContext } from '../memory/StageContext.js';
import { hasCircularReference, isDevMode } from './detectCircular.js';
import { assertNotReadonly, createFrozenArgs } from './protection/readonlyInput.js';
import type { CommitEvent, Recorder, RedactionPolicy, RedactionReport } from './types.js';

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

  private _recorders: Recorder[] = [];
  private _redactedKeys: Set<string>;
  private _redactionPolicy: RedactionPolicy | undefined;
  private _redactedFieldsByKey: Map<string, Set<string>> = new Map();

  constructor(context: StageContext, stageName: string, readOnlyValues?: unknown, executionEnv?: ExecutionEnv) {
    this._stageContext = context;
    this._stageName = stageName;
    this._readOnlyValues = readOnlyValues;
    this._frozenArgs = createFrozenArgs(readOnlyValues);
    this._executionEnv = Object.freeze({ ...executionEnv });
    this._redactedKeys = new Set<string>();

    // Register as commit observer so Recorder.onCommit fires when StageContext.commit() is called
    this._stageContext.setCommitObserver((mutations) => {
      this._onCommitFired(mutations);
    });
  }

  /**
   * Share a redacted-keys set across multiple ScopeFacade instances.
   * Call this to make redaction persist across stages in the same pipeline.
   * @internal
   */
  useSharedRedactedKeys(sharedSet: Set<string>): void {
    this._redactedKeys = sharedSet;
  }

  /**
   * Returns the current redacted-keys set (for sharing with other scopes).
   * @internal
   */
  getRedactedKeys(): Set<string> {
    return this._redactedKeys;
  }

  /**
   * Apply a declarative redaction policy. The policy is additive —
   * it works alongside manual `setValue(..., true)` calls.
   * @internal
   */
  useRedactionPolicy(policy: RedactionPolicy): void {
    this._redactionPolicy = policy;
    // Pre-populate field-level redaction map from policy
    if (policy.fields) {
      for (const [key, fields] of Object.entries(policy.fields)) {
        this._redactedFieldsByKey.set(key, new Set(fields));
      }
    }
  }

  /** @internal */
  getRedactionPolicy(): RedactionPolicy | undefined {
    return this._redactionPolicy;
  }

  /**
   * Returns a compliance-friendly report of all redaction activity.
   * Never includes actual values — only key names, field names, and patterns.
   */
  getRedactionReport(): RedactionReport {
    const fieldRedactions: Record<string, string[]> = {};
    for (const [key, fields] of this._redactedFieldsByKey) {
      fieldRedactions[key] = [...fields];
    }
    return {
      redactedKeys: [...this._redactedKeys],
      fieldRedactions,
      patterns: (this._redactionPolicy?.patterns ?? []).map((p) => p.source),
    };
  }

  // ── Recorder Management ──────────────────────────────────────────────────

  attachRecorder(recorder: Recorder): void {
    // Replace existing recorder with same ID (idempotent — prevents double-counting)
    this._recorders = this._recorders.filter((r) => r.id !== recorder.id);
    this._recorders.push(recorder);
  }

  detachRecorder(recorderId: string): void {
    this._recorders = this._recorders.filter((r) => r.id !== recorderId);
  }

  getRecorders(): Recorder[] {
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
      const commitMutations: CommitEvent['mutations'] = Object.entries(mutations).map(([key, entry]) => {
        const isRedacted = this._isKeyRedacted(key) || this._isPolicyRedacted(key);
        const fieldSet = this._redactedFieldsByKey.get(key);

        let recorderValue: unknown;
        if (isRedacted) {
          recorderValue = '[REDACTED]';
        } else if (fieldSet && entry.value && typeof entry.value === 'object') {
          recorderValue = this._scrubFields(entry.value as Record<string, unknown>, fieldSet);
        } else {
          recorderValue = entry.value;
        }

        return {
          key,
          value: recorderValue,
          operation: entry.operation,
        };
      });

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
    const patterns = this._redactionPolicy?.emitPatterns;
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
      const onEmit = recorder.onEmit;
      if (typeof onEmit !== 'function') continue;
      try {
        onEmit.call(recorder, event);
      } catch (error) {
        this._invokeHook('onError', {
          stageName: this._stageName,
          stageId: this._stageContext.stageId,
          runtimeStageId: this._stageContext.runtimeStageId,
          pipelineId: this._stageContext.runId,
          timestamp: Date.now(),
          error: error as Error,
          operation: 'write',
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
   *  the existing getValue() contract where user code always receives raw data. */
  getValueSilent(key?: string): unknown {
    return this._stageContext.getValueDirect([], key);
  }

  // ── State Access ─────────────────────────────────────────────────────────

  getInitialValueFor(key: string) {
    return this._stageContext.getGlobal?.(key);
  }

  getValue(key?: string) {
    const value = this._stageContext.getValue([], key);

    if (this._recorders.length > 0) {
      const isRedacted = key !== undefined && this._isKeyRedacted(key);
      const fieldSet = key !== undefined ? this._redactedFieldsByKey.get(key) : undefined;

      let recorderValue: unknown;
      if (isRedacted) {
        recorderValue = '[REDACTED]';
      } else if (fieldSet && value && typeof value === 'object') {
        recorderValue = this._scrubFields(value as Record<string, unknown>, fieldSet);
      } else {
        recorderValue = value;
      }

      this._invokeHook('onRead', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: recorderValue,
        redacted: isRedacted || fieldSet !== undefined || undefined,
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

    // Auto-redact if key matches policy (exact keys or patterns), or if the key was
    // previously marked redacted (e.g. carried over from a subflow via outputMapper).
    const effectiveRedact = shouldRedact || this._isPolicyRedacted(key) || this._redactedKeys.has(key);

    const result = this._stageContext.setObject([], key, value, effectiveRedact, description);

    if (effectiveRedact) {
      this._redactedKeys.add(key);
    }

    // Check for field-level redaction from policy
    const fieldSet = this._redactedFieldsByKey.get(key);

    if (this._recorders.length > 0) {
      let recorderValue: unknown;
      if (effectiveRedact) {
        recorderValue = '[REDACTED]';
      } else if (fieldSet && value && typeof value === 'object') {
        recorderValue = this._scrubFields(value as Record<string, unknown>, fieldSet);
      } else {
        recorderValue = value;
      }

      this._invokeHook('onWrite', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: recorderValue,
        operation: 'set',
        redacted: effectiveRedact || fieldSet !== undefined || undefined,
      });
    }

    return result;
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

    const isRedacted = this._isKeyRedacted(key) || this._isPolicyRedacted(key);
    const result = this._stageContext.updateObject([], key, value, description, isRedacted);

    if (this._recorders.length > 0) {
      const fieldSet = this._redactedFieldsByKey.get(key);

      let recorderValue: unknown;
      if (isRedacted) {
        recorderValue = '[REDACTED]';
      } else if (fieldSet && value && typeof value === 'object') {
        recorderValue = this._scrubFields(value as Record<string, unknown>, fieldSet);
      } else {
        recorderValue = value;
      }

      this._invokeHook('onWrite', {
        stageName: this._stageName,
        stageId: this._stageContext.stageId,
        runtimeStageId: this._stageContext.runtimeStageId,
        pipelineId: this._stageContext.runId,
        timestamp: Date.now(),
        key,
        value: recorderValue,
        operation: 'update',
        redacted: isRedacted || fieldSet !== undefined || undefined,
      });
    }

    return result;
  }

  deleteValue(key: string, description?: string) {
    assertNotReadonly(this._readOnlyValues, key, 'delete');

    const result = this._stageContext.setObject([], key, undefined, false, description ?? `deleted ${key}`, 'delete');

    // Deleting a redacted key clears its redaction status
    this._redactedKeys.delete(key);

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

    return result;
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
   */
  getArgs<T = Record<string, unknown>>(): T {
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
   */
  getEnv(): Readonly<ExecutionEnv> {
    return this._executionEnv;
  }

  /** @internal */
  getPipelineId() {
    return this._stageContext.runId;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Checks if a key is redacted (explicit _redactedKeys set). */
  private _isKeyRedacted(key: string): boolean {
    return this._redactedKeys.has(key);
  }

  /**
   * Checks if a key should be auto-redacted by the policy (exact keys + patterns).
   *
   * ReDoS guard: pattern testing is capped at MAX_PATTERN_KEY_LEN characters.
   * Scope state keys are always short identifiers; any key exceeding the cap
   * is almost certainly not a legitimate scope key, so skipping pattern matching
   * for it does not risk leaking PII. Exact-key matching (Array.includes) is
   * still applied regardless of length and is not vulnerable to ReDoS.
   */
  private _isPolicyRedacted(key: string): boolean {
    if (!this._redactionPolicy) return false;
    if (this._redactionPolicy.keys?.includes(key)) return true;
    if (this._redactionPolicy.patterns) {
      if (key.length > ScopeFacade._MAX_PATTERN_KEY_LEN) {
        // Dev-mode warning: pattern matching was silently skipped for this key.
        // Use policy.keys for exact matching of long key names.
        if (isDevMode()) {
          // eslint-disable-next-line no-console
          console.warn(
            `[footprint] RedactionPolicy: key '${key.slice(0, 40)}...' (${key.length} chars) exceeds ` +
              'the pattern-matching length cap and was skipped. ' +
              'Use policy.keys for exact matching of long key names.',
          );
        }
      } else {
        for (const p of this._redactionPolicy.patterns) {
          p.lastIndex = 0; // Reset stateful global/sticky regexes
          if (p.test(key)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Maximum key length (characters) that will be tested against regex redaction
   * patterns. Keys longer than this are skipped for pattern matching to prevent
   * ReDoS: a pathological regex tested against an unboundedly long key string
   * can cause catastrophic backtracking.
   *
   * 256 characters comfortably exceeds any realistic scope-state key name.
   */
  private static readonly _MAX_PATTERN_KEY_LEN = 256;

  /**
   * Returns a deep-cloned copy with specified fields replaced by '[REDACTED]'.
   * Supports dot-notation paths (e.g. 'address.zip') for nested objects.
   */
  private _scrubFields(obj: Record<string, unknown>, fields: Set<string>): Record<string, unknown> {
    const copy = structuredClone(obj);
    for (const field of fields) {
      if (field.includes('.') && !Object.prototype.hasOwnProperty.call(copy, field)) {
        // Dot-notation path → deep scrub (only if not a literal flat key)
        if (lodashHas(copy, field)) {
          lodashSet(copy, field, '[REDACTED]');
        }
      } else {
        if (Object.prototype.hasOwnProperty.call(copy, field)) {
          copy[field] = '[REDACTED]';
        }
      }
    }
    return copy;
  }

  private _invokeHook(hook: keyof Omit<Recorder, 'id'>, event: unknown): void {
    for (const recorder of this._recorders) {
      try {
        const hookFn = recorder[hook];
        if (typeof hookFn === 'function') {
          (hookFn as (event: unknown) => void).call(recorder, event);
        }
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
          });
        }
      }
    }
  }
}
