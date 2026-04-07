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
import type { ExecutionEnv } from '../engine/types.js';
import { StageContext } from '../memory/StageContext.js';
import type { CommitEvent, Recorder, RedactionPolicy, RedactionReport } from './types.js';
export declare class ScopeFacade {
    static readonly BRAND: unique symbol;
    protected _stageContext: StageContext;
    protected _stageName: string;
    protected readonly _readOnlyValues?: unknown;
    /** Cached deeply-frozen copy of readOnlyValues for getArgs(). Created once. */
    private readonly _frozenArgs;
    /** Execution environment — read-only, inherited from parent executor. */
    private readonly _executionEnv;
    private _recorders;
    private _redactedKeys;
    private _redactionPolicy;
    private _redactedFieldsByKey;
    constructor(context: StageContext, stageName: string, readOnlyValues?: unknown, executionEnv?: ExecutionEnv);
    /**
     * Share a redacted-keys set across multiple ScopeFacade instances.
     * Call this to make redaction persist across stages in the same pipeline.
     * @internal
     */
    useSharedRedactedKeys(sharedSet: Set<string>): void;
    /**
     * Returns the current redacted-keys set (for sharing with other scopes).
     * @internal
     */
    getRedactedKeys(): Set<string>;
    /**
     * Apply a declarative redaction policy. The policy is additive —
     * it works alongside manual `setValue(..., true)` calls.
     * @internal
     */
    useRedactionPolicy(policy: RedactionPolicy): void;
    /** @internal */
    getRedactionPolicy(): RedactionPolicy | undefined;
    /**
     * Returns a compliance-friendly report of all redaction activity.
     * Never includes actual values — only key names, field names, and patterns.
     */
    getRedactionReport(): RedactionReport;
    attachRecorder(recorder: Recorder): void;
    detachRecorder(recorderId: string): void;
    getRecorders(): Recorder[];
    /** @internal */
    notifyStageStart(): void;
    /** @internal */
    notifyStageEnd(duration?: number): void;
    /** @internal */
    notifyPause(stageId: string, pauseData?: unknown): void;
    /** @internal */
    notifyResume(stageId: string, hasInput: boolean): void;
    /** @internal */
    notifyCommit(mutations: CommitEvent['mutations']): void;
    /** Called by StageContext.commit() observer. Converts tracked writes to CommitEvent format.
     *  Errors are caught to prevent recorder issues from aborting the traversal. */
    private _onCommitFired;
    addDebugInfo(key: string, value: unknown): void;
    addDebugMessage(value: unknown): void;
    addErrorInfo(key: string, value: unknown): void;
    addMetric(metricName: string, value: unknown): void;
    addEval(metricName: string, value: unknown): void;
    /** Returns all state keys without firing onRead. Used by TypedScope ownKeys/has traps. */
    getStateKeys(): string[];
    /** Check key existence without firing onRead. Used by TypedScope has trap.
     *  Contract: returns false for keys never set OR keys set to undefined.
     *  This matches deleteValue() semantics (sets to undefined = deleted). */
    hasKey(key: string): boolean;
    /** Read state without firing onRead. Used by array proxy getCurrent() to avoid
     *  phantom reads on internal array operations (.length, .has, iteration, etc.).
     *  The initial property access fires one tracked onRead via getValue(); subsequent
     *  internal array operations use this method to stay silent.
     *  NOTE: Like getValue(), returns the raw value to the caller. Redaction applies
     *  only to recorder dispatch — it does not filter the returned value. This matches
     *  the existing getValue() contract where user code always receives raw data. */
    getValueSilent(key?: string): unknown;
    getInitialValueFor(key: string): any;
    getValue(key?: string): any;
    setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
    updateValue(key: string, value: unknown, description?: string): void;
    deleteValue(key: string, description?: string): void;
    /** @internal */
    setGlobal(key: string, value: unknown, description?: string): void;
    /** @internal */
    getGlobal(key: string): any;
    /** @internal */
    setObjectInRoot(key: string, value: unknown): void;
    /**
     * Returns the readonly input values passed to this pipeline, cast to `T`.
     * The returned object is deeply frozen — any attempt to mutate it throws.
     * Cached at construction time for zero-allocation repeated access.
     *
     * ```typescript
     * const { applicantName, income } = scope.getArgs<{ applicantName: string; income: number }>();
     * ```
     */
    getArgs<T = Record<string, unknown>>(): T;
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
    getEnv(): Readonly<ExecutionEnv>;
    /** @internal */
    getPipelineId(): string;
    /** Checks if a key is redacted (explicit _redactedKeys set). */
    private _isKeyRedacted;
    /**
     * Checks if a key should be auto-redacted by the policy (exact keys + patterns).
     *
     * ReDoS guard: pattern testing is capped at MAX_PATTERN_KEY_LEN characters.
     * Scope state keys are always short identifiers; any key exceeding the cap
     * is almost certainly not a legitimate scope key, so skipping pattern matching
     * for it does not risk leaking PII. Exact-key matching (Array.includes) is
     * still applied regardless of length and is not vulnerable to ReDoS.
     */
    private _isPolicyRedacted;
    /**
     * Maximum key length (characters) that will be tested against regex redaction
     * patterns. Keys longer than this are skipped for pattern matching to prevent
     * ReDoS: a pathological regex tested against an unboundedly long key string
     * can cause catastrophic backtracking.
     *
     * 256 characters comfortably exceeds any realistic scope-state key name.
     */
    private static readonly _MAX_PATTERN_KEY_LEN;
    /**
     * Returns a deep-cloned copy with specified fields replaced by '[REDACTED]'.
     * Supports dot-notation paths (e.g. 'address.zip') for nested objects.
     */
    private _scrubFields;
    private _invokeHook;
}
