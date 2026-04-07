"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScopeFacade = void 0;
const pathOps_js_1 = require("../memory/pathOps.js");
const detectCircular_js_1 = require("./detectCircular.js");
const readonlyInput_js_1 = require("./protection/readonlyInput.js");
class ScopeFacade {
    constructor(context, stageName, readOnlyValues, executionEnv) {
        this._recorders = [];
        this._redactedFieldsByKey = new Map();
        this._stageContext = context;
        this._stageName = stageName;
        this._readOnlyValues = readOnlyValues;
        this._frozenArgs = (0, readonlyInput_js_1.createFrozenArgs)(readOnlyValues);
        this._executionEnv = Object.freeze({ ...executionEnv });
        this._redactedKeys = new Set();
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
    useSharedRedactedKeys(sharedSet) {
        this._redactedKeys = sharedSet;
    }
    /**
     * Returns the current redacted-keys set (for sharing with other scopes).
     * @internal
     */
    getRedactedKeys() {
        return this._redactedKeys;
    }
    /**
     * Apply a declarative redaction policy. The policy is additive —
     * it works alongside manual `setValue(..., true)` calls.
     * @internal
     */
    useRedactionPolicy(policy) {
        this._redactionPolicy = policy;
        // Pre-populate field-level redaction map from policy
        if (policy.fields) {
            for (const [key, fields] of Object.entries(policy.fields)) {
                this._redactedFieldsByKey.set(key, new Set(fields));
            }
        }
    }
    /** @internal */
    getRedactionPolicy() {
        return this._redactionPolicy;
    }
    /**
     * Returns a compliance-friendly report of all redaction activity.
     * Never includes actual values — only key names, field names, and patterns.
     */
    getRedactionReport() {
        var _a, _b;
        const fieldRedactions = {};
        for (const [key, fields] of this._redactedFieldsByKey) {
            fieldRedactions[key] = [...fields];
        }
        return {
            redactedKeys: [...this._redactedKeys],
            fieldRedactions,
            patterns: ((_b = (_a = this._redactionPolicy) === null || _a === void 0 ? void 0 : _a.patterns) !== null && _b !== void 0 ? _b : []).map((p) => p.source),
        };
    }
    // ── Recorder Management ──────────────────────────────────────────────────
    attachRecorder(recorder) {
        // Replace existing recorder with same ID (idempotent — prevents double-counting)
        this._recorders = this._recorders.filter((r) => r.id !== recorder.id);
        this._recorders.push(recorder);
    }
    detachRecorder(recorderId) {
        this._recorders = this._recorders.filter((r) => r.id !== recorderId);
    }
    getRecorders() {
        return [...this._recorders];
    }
    /** @internal */
    notifyStageStart() {
        this._invokeHook('onStageStart', {
            stageName: this._stageName,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
        });
    }
    /** @internal */
    notifyStageEnd(duration) {
        this._invokeHook('onStageEnd', {
            stageName: this._stageName,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            duration,
        });
    }
    /** @internal */
    notifyPause(stageId, pauseData) {
        this._invokeHook('onPause', {
            stageName: this._stageName,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            stageId,
            pauseData,
        });
    }
    /** @internal */
    notifyResume(stageId, hasInput) {
        this._invokeHook('onResume', {
            stageName: this._stageName,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            stageId,
            hasInput,
        });
    }
    /** @internal */
    notifyCommit(mutations) {
        this._invokeHook('onCommit', {
            stageName: this._stageName,
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            mutations,
        });
    }
    /** Called by StageContext.commit() observer. Converts tracked writes to CommitEvent format.
     *  Errors are caught to prevent recorder issues from aborting the traversal. */
    _onCommitFired(mutations) {
        if (this._recorders.length === 0)
            return;
        try {
            const commitMutations = Object.entries(mutations).map(([key, entry]) => {
                const isRedacted = this._isKeyRedacted(key) || this._isPolicyRedacted(key);
                const fieldSet = this._redactedFieldsByKey.get(key);
                let recorderValue;
                if (isRedacted) {
                    recorderValue = '[REDACTED]';
                }
                else if (fieldSet && entry.value && typeof entry.value === 'object') {
                    recorderValue = this._scrubFields(entry.value, fieldSet);
                }
                else {
                    recorderValue = entry.value;
                }
                return {
                    key,
                    value: recorderValue,
                    operation: entry.operation,
                };
            });
            this.notifyCommit(commitMutations);
        }
        catch (_a) {
            // Swallow — recorder errors must not abort the traversal.
            // Individual recorder errors are already isolated by _invokeHook.
        }
    }
    // ── Debug / Diagnostics ──────────────────────────────────────────────────
    addDebugInfo(key, value) {
        this._stageContext.addLog(key, value);
    }
    addDebugMessage(value) {
        this._stageContext.addLog('messages', [value]);
    }
    addErrorInfo(key, value) {
        this._stageContext.addError(key, value);
    }
    addMetric(metricName, value) {
        this._stageContext.addMetric(metricName, value);
    }
    addEval(metricName, value) {
        this._stageContext.addEval(metricName, value);
    }
    // ── Non-Tracking State Inspection (for TypedScope proxy internals) ──────
    /** Returns all state keys without firing onRead. Used by TypedScope ownKeys/has traps. */
    getStateKeys() {
        const snapshot = this._stageContext.getValue([], undefined);
        if (!snapshot || typeof snapshot !== 'object')
            return [];
        return Object.keys(snapshot);
    }
    /** Check key existence without firing onRead. Used by TypedScope has trap.
     *  Contract: returns false for keys never set OR keys set to undefined.
     *  This matches deleteValue() semantics (sets to undefined = deleted). */
    hasKey(key) {
        return this._stageContext.getValue([], key) !== undefined;
    }
    /** Read state without firing onRead. Used by array proxy getCurrent() to avoid
     *  phantom reads on internal array operations (.length, .has, iteration, etc.).
     *  The initial property access fires one tracked onRead via getValue(); subsequent
     *  internal array operations use this method to stay silent.
     *  NOTE: Like getValue(), returns the raw value to the caller. Redaction applies
     *  only to recorder dispatch — it does not filter the returned value. This matches
     *  the existing getValue() contract where user code always receives raw data. */
    getValueSilent(key) {
        return this._stageContext.getValueDirect([], key);
    }
    // ── State Access ─────────────────────────────────────────────────────────
    getInitialValueFor(key) {
        var _a, _b;
        return (_b = (_a = this._stageContext).getGlobal) === null || _b === void 0 ? void 0 : _b.call(_a, key);
    }
    getValue(key) {
        const value = this._stageContext.getValue([], key);
        if (this._recorders.length > 0) {
            const isRedacted = key !== undefined && this._isKeyRedacted(key);
            const fieldSet = key !== undefined ? this._redactedFieldsByKey.get(key) : undefined;
            let recorderValue;
            if (isRedacted) {
                recorderValue = '[REDACTED]';
            }
            else if (fieldSet && value && typeof value === 'object') {
                recorderValue = this._scrubFields(value, fieldSet);
            }
            else {
                recorderValue = value;
            }
            this._invokeHook('onRead', {
                stageName: this._stageName,
                pipelineId: this._stageContext.runId,
                timestamp: Date.now(),
                key,
                value: recorderValue,
                redacted: isRedacted || fieldSet !== undefined || undefined,
            });
        }
        return value;
    }
    setValue(key, value, shouldRedact, description) {
        (0, readonlyInput_js_1.assertNotReadonly)(this._readOnlyValues, key, 'write');
        // Dev-mode: warn if the value contains circular references.
        // Check AFTER assertNotReadonly — don't warn for writes that will be blocked.
        // Circular values work (terminal proxy handles them) but can produce
        // surprising behavior in narrative, JSON serialization, and snapshots.
        if ((0, detectCircular_js_1.isDevMode)() && value !== null && typeof value === 'object') {
            if ((0, detectCircular_js_1.hasCircularReference)(value)) {
                // eslint-disable-next-line no-console
                console.warn(`[footprint] Circular reference detected in setValue('${key}'). ` +
                    'Writes past the cycle depth will use terminal proxy tracking. ' +
                    'Consider flattening the data structure.');
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
            let recorderValue;
            if (effectiveRedact) {
                recorderValue = '[REDACTED]';
            }
            else if (fieldSet && value && typeof value === 'object') {
                recorderValue = this._scrubFields(value, fieldSet);
            }
            else {
                recorderValue = value;
            }
            this._invokeHook('onWrite', {
                stageName: this._stageName,
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
    updateValue(key, value, description) {
        (0, readonlyInput_js_1.assertNotReadonly)(this._readOnlyValues, key, 'write');
        // Dev-mode: same circular check as setValue (merge targets can be circular too)
        if ((0, detectCircular_js_1.isDevMode)() && value !== null && typeof value === 'object') {
            if ((0, detectCircular_js_1.hasCircularReference)(value)) {
                // eslint-disable-next-line no-console
                console.warn(`[footprint] Circular reference detected in updateValue('${key}'). ` +
                    'Consider flattening the data structure.');
            }
        }
        const isRedacted = this._isKeyRedacted(key) || this._isPolicyRedacted(key);
        const result = this._stageContext.updateObject([], key, value, description, isRedacted);
        if (this._recorders.length > 0) {
            const fieldSet = this._redactedFieldsByKey.get(key);
            let recorderValue;
            if (isRedacted) {
                recorderValue = '[REDACTED]';
            }
            else if (fieldSet && value && typeof value === 'object') {
                recorderValue = this._scrubFields(value, fieldSet);
            }
            else {
                recorderValue = value;
            }
            this._invokeHook('onWrite', {
                stageName: this._stageName,
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
    deleteValue(key, description) {
        (0, readonlyInput_js_1.assertNotReadonly)(this._readOnlyValues, key, 'delete');
        const result = this._stageContext.setObject([], key, undefined, false, description !== null && description !== void 0 ? description : `deleted ${key}`, 'delete');
        // Deleting a redacted key clears its redaction status
        this._redactedKeys.delete(key);
        if (this._recorders.length > 0) {
            this._invokeHook('onWrite', {
                stageName: this._stageName,
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
    setGlobal(key, value, description) {
        var _a, _b;
        return (_b = (_a = this._stageContext).setGlobal) === null || _b === void 0 ? void 0 : _b.call(_a, key, value, description);
    }
    /** @internal */
    getGlobal(key) {
        var _a, _b;
        return (_b = (_a = this._stageContext).getGlobal) === null || _b === void 0 ? void 0 : _b.call(_a, key);
    }
    /** @internal */
    setObjectInRoot(key, value) {
        var _a, _b;
        return (_b = (_a = this._stageContext).setRoot) === null || _b === void 0 ? void 0 : _b.call(_a, key, value);
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
    getArgs() {
        return this._frozenArgs;
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
    getEnv() {
        return this._executionEnv;
    }
    /** @internal */
    getPipelineId() {
        return this._stageContext.runId;
    }
    // ── Internal ─────────────────────────────────────────────────────────────
    /** Checks if a key is redacted (explicit _redactedKeys set). */
    _isKeyRedacted(key) {
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
    _isPolicyRedacted(key) {
        var _a;
        if (!this._redactionPolicy)
            return false;
        if ((_a = this._redactionPolicy.keys) === null || _a === void 0 ? void 0 : _a.includes(key))
            return true;
        if (this._redactionPolicy.patterns) {
            if (key.length > ScopeFacade._MAX_PATTERN_KEY_LEN) {
                // Dev-mode warning: pattern matching was silently skipped for this key.
                // Use policy.keys for exact matching of long key names.
                if ((0, detectCircular_js_1.isDevMode)()) {
                    // eslint-disable-next-line no-console
                    console.warn(`[footprint] RedactionPolicy: key '${key.slice(0, 40)}...' (${key.length} chars) exceeds ` +
                        'the pattern-matching length cap and was skipped. ' +
                        'Use policy.keys for exact matching of long key names.');
                }
            }
            else {
                for (const p of this._redactionPolicy.patterns) {
                    p.lastIndex = 0; // Reset stateful global/sticky regexes
                    if (p.test(key))
                        return true;
                }
            }
        }
        return false;
    }
    /**
     * Returns a deep-cloned copy with specified fields replaced by '[REDACTED]'.
     * Supports dot-notation paths (e.g. 'address.zip') for nested objects.
     */
    _scrubFields(obj, fields) {
        const copy = structuredClone(obj);
        for (const field of fields) {
            if (field.includes('.') && !Object.prototype.hasOwnProperty.call(copy, field)) {
                // Dot-notation path → deep scrub (only if not a literal flat key)
                if ((0, pathOps_js_1.nativeHas)(copy, field)) {
                    (0, pathOps_js_1.nativeSet)(copy, field, '[REDACTED]');
                }
            }
            else {
                if (Object.prototype.hasOwnProperty.call(copy, field)) {
                    copy[field] = '[REDACTED]';
                }
            }
        }
        return copy;
    }
    _invokeHook(hook, event) {
        for (const recorder of this._recorders) {
            try {
                const hookFn = recorder[hook];
                if (typeof hookFn === 'function') {
                    hookFn.call(recorder, event);
                }
            }
            catch (error) {
                if (hook !== 'onError') {
                    this._invokeHook('onError', {
                        stageName: this._stageName,
                        pipelineId: this._stageContext.runId,
                        timestamp: Date.now(),
                        error: error,
                        operation: hook === 'onRead' ? 'read' : hook === 'onCommit' ? 'commit' : 'write',
                    });
                }
            }
        }
    }
}
exports.ScopeFacade = ScopeFacade;
ScopeFacade.BRAND = Symbol.for('ScopeFacade@v1');
/**
 * Maximum key length (characters) that will be tested against regex redaction
 * patterns. Keys longer than this are skipped for pattern matching to prevent
 * ReDoS: a pathological regex tested against an unboundedly long key string
 * can cause catastrophic backtracking.
 *
 * 256 characters comfortably exceeds any realistic scope-state key name.
 */
ScopeFacade._MAX_PATTERN_KEY_LEN = 256;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2NvcGVGYWNhZGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3Njb3BlL1Njb3BlRmFjYWRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRzs7O0FBR0gscURBQXNGO0FBRXRGLDJEQUFzRTtBQUN0RSxvRUFBb0Y7QUFHcEYsTUFBYSxXQUFXO0lBa0J0QixZQUFZLE9BQXFCLEVBQUUsU0FBaUIsRUFBRSxjQUF3QixFQUFFLFlBQTJCO1FBTG5HLGVBQVUsR0FBZSxFQUFFLENBQUM7UUFHNUIseUJBQW9CLEdBQTZCLElBQUksR0FBRyxFQUFFLENBQUM7UUFHakUsSUFBSSxDQUFDLGFBQWEsR0FBRyxPQUFPLENBQUM7UUFDN0IsSUFBSSxDQUFDLFVBQVUsR0FBRyxTQUFTLENBQUM7UUFDNUIsSUFBSSxDQUFDLGVBQWUsR0FBRyxjQUFjLENBQUM7UUFDdEMsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFBLG1DQUFnQixFQUFDLGNBQWMsQ0FBQyxDQUFDO1FBQ3BELElBQUksQ0FBQyxhQUFhLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLEdBQUcsWUFBWSxFQUFFLENBQUMsQ0FBQztRQUN4RCxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFFdkMsOEZBQThGO1FBQzlGLElBQUksQ0FBQyxhQUFhLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxTQUFTLEVBQUUsRUFBRTtZQUNqRCxJQUFJLENBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ2pDLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7O09BSUc7SUFDSCxxQkFBcUIsQ0FBQyxTQUFzQjtRQUMxQyxJQUFJLENBQUMsYUFBYSxHQUFHLFNBQVMsQ0FBQztJQUNqQyxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsZUFBZTtRQUNiLE9BQU8sSUFBSSxDQUFDLGFBQWEsQ0FBQztJQUM1QixDQUFD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QUFJLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUN2QyxJQUFJLENBQUM7Z0JBQ0gsTUFBTSxNQUFNLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUM5QixJQUFJLE9BQU8sTUFBTSxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUNoQyxNQUFtQyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUM7Z0JBQzdELENBQUM7WUFDSCxDQUFDO1lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztnQkFDZixJQUFJLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztvQkFDdkIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxTQUFTLEVBQUU7d0JBQzFCLFNBQVMsRUFBRSxJQUFJLENBQUMsVUFBVTt3QkFDMUIsVUFBVSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSzt3QkFDcEMsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUU7d0JBQ3JCLEtBQUssRUFBRSxLQUFjO3dCQUNyQixTQUFTLEVBQUUsSUFBSSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLE9BQU87cUJBQ2pGLENBQUMsQ0FBQztnQkFDTCxDQUFDO1lBQ0gsQ0FBQztRQUNILENBQUM7SUFDSCxDQUFDOztBQWxoQkgsa0NBbWhCQztBQWxoQndCLGlCQUFLLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxBQUEvQixDQUFnQztBQStkNUQ7Ozs7Ozs7R0FPRztBQUNxQixnQ0FBb0IsR0FBRyxHQUFHLEFBQU4sQ0FBTyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2NvcGVGYWNhZGUg4oCUIEJhc2UgY2xhc3MgdGhhdCBsaWJyYXJ5IGNvbnN1bWVycyBleHRlbmQgdG8gY3JlYXRlIGN1c3RvbSBzY29wZSBjbGFzc2VzXG4gKlxuICogV3JhcHMgU3RhZ2VDb250ZXh0IChmcm9tIG1lbW9yeS8pIHRvIHByb3ZpZGUgYSBjb25zdW1lci1mcmllbmRseSBBUEkgZm9yXG4gKiBzdGF0ZSBhY2Nlc3MsIGRlYnVnIGxvZ2dpbmcsIG1ldHJpY3MsIGFuZCByZWNvcmRlciBob29rcy5cbiAqXG4gKiBDb25zdW1lcnMgZXh0ZW5kIHRoaXMgY2xhc3MgdG8gYWRkIGRvbWFpbi1zcGVjaWZpYyBwcm9wZXJ0aWVzOlxuICpcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNsYXNzIE15U2NvcGUgZXh0ZW5kcyBTY29wZUZhY2FkZSB7XG4gKiAgIGdldCB1c2VyTmFtZSgpOiBzdHJpbmcgeyByZXR1cm4gdGhpcy5nZXRWYWx1ZSgnbmFtZScpIGFzIHN0cmluZzsgfVxuICogICBzZXQgdXNlck5hbWUodmFsdWU6IHN0cmluZykgeyB0aGlzLnNldFZhbHVlKCduYW1lJywgdmFsdWUpOyB9XG4gKiB9XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4ZWN1dGlvbkVudiB9IGZyb20gJy4uL2VuZ2luZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBuYXRpdmVIYXMgYXMgbG9kYXNoSGFzLCBuYXRpdmVTZXQgYXMgbG9kYXNoU2V0IH0gZnJvbSAnLi4vbWVtb3J5L3BhdGhPcHMuanMnO1xuaW1wb3J0IHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBoYXNDaXJjdWxhclJlZmVyZW5jZSwgaXNEZXZNb2RlIH0gZnJvbSAnLi9kZXRlY3RDaXJjdWxhci5qcyc7XG5pbXBvcnQgeyBhc3NlcnROb3RSZWFkb25seSwgY3JlYXRlRnJvemVuQXJncyB9IGZyb20gJy4vcHJvdGVjdGlvbi9yZWFkb25seUlucHV0LmpzJztcbmltcG9ydCB0eXBlIHsgQ29tbWl0RXZlbnQsIFJlY29yZGVyLCBSZWRhY3Rpb25Qb2xpY3ksIFJlZGFjdGlvblJlcG9ydCB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgU2NvcGVGYWNhZGUge1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEJSQU5EID0gU3ltYm9sLmZvcignU2NvcGVGYWNhZGVAdjEnKTtcblxuICBwcm90ZWN0ZWQgX3N0YWdlQ29udGV4dDogU3RhZ2VDb250ZXh0O1xuICBwcm90ZWN0ZWQgX3N0YWdlTmFtZTogc3RyaW5nO1xuICBwcm90ZWN0ZWQgcmVhZG9ubHkgX3JlYWRPbmx5VmFsdWVzPzogdW5rbm93bjtcblxuICAvKiogQ2FjaGVkIGRlZXBseS1mcm96ZW4gY29weSBvZiByZWFkT25seVZhbHVlcyBmb3IgZ2V0QXJncygpLiBDcmVhdGVkIG9uY2UuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgX2Zyb3plbkFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gIC8qKiBFeGVjdXRpb24gZW52aXJvbm1lbnQg4oCUIHJlYWQtb25seSwgaW5oZXJpdGVkIGZyb20gcGFyZW50IGV4ZWN1dG9yLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IF9leGVjdXRpb25FbnY6IFJlYWRvbmx5PEV4ZWN1dGlvbkVudj47XG5cbiAgcHJpdmF0ZSBfcmVjb3JkZXJzOiBSZWNvcmRlcltdID0gW107XG4gIHByaXZhdGUgX3JlZGFjdGVkS2V5czogU2V0PHN0cmluZz47XG4gIHByaXZhdGUgX3JlZGFjdGlvblBvbGljeTogUmVkYWN0aW9uUG9saWN5IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIF9yZWRhY3RlZEZpZWxkc0J5S2V5OiBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4gPSBuZXcgTWFwKCk7XG5cbiAgY29uc3RydWN0b3IoY29udGV4dDogU3RhZ2VDb250ZXh0LCBzdGFnZU5hbWU6IHN0cmluZywgcmVhZE9ubHlWYWx1ZXM/OiB1bmtub3duLCBleGVjdXRpb25FbnY/OiBFeGVjdXRpb25FbnYpIHtcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQgPSBjb250ZXh0O1xuICAgIHRoaXMuX3N0YWdlTmFtZSA9IHN0YWdlTmFtZTtcbiAgICB0aGlzLl9yZWFkT25seVZhbHVlcyA9IHJlYWRPbmx5VmFsdWVzO1xuICAgIHRoaXMuX2Zyb3plbkFyZ3MgPSBjcmVhdGVGcm96ZW5BcmdzKHJlYWRPbmx5VmFsdWVzKTtcbiAgICB0aGlzLl9leGVjdXRpb25FbnYgPSBPYmplY3QuZnJlZXplKHsgLi4uZXhlY3V0aW9uRW52IH0pO1xuICAgIHRoaXMuX3JlZGFjdGVkS2V5cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgLy8gUmVnaXN0ZXIgYXMgY29tbWl0IG9ic2VydmVyIHNvIFJlY29yZGVyLm9uQ29tbWl0IGZpcmVzIHdoZW4gU3RhZ2VDb250ZXh0LmNvbW1pdCgpIGlzIGNhbGxlZFxuICAgIHRoaXMuX3N0YWdlQ29udGV4dC5zZXRDb21taXRPYnNlcnZlcigobXV0YXRpb25zKSA9PiB7XG4gICAgICB0aGlzLl9vbkNvbW1pdEZpcmVkKG11dGF0aW9ucyk7XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogU2hhcmUgYSByZWRhY3RlZC1rZXlzIHNldCBhY3Jvc3MgbXVsdGlwbGUgU2NvcGVGYWNhZGUgaW5zdGFuY2VzLlxuICAgKiBDYWxsIHRoaXMgdG8gbWFrZSByZWRhY3Rpb24gcGVyc2lzdCBhY3Jvc3Mgc3RhZ2VzIGluIHRoZSBzYW1lIHBpcGVsaW5lLlxuICAgKiBAaW50ZXJuYWxcbiAgICovXG4gIHVzZVNoYXJlZFJlZGFjdGVkS2V5cyhzaGFyZWRTZXQ6IFNldDxzdHJpbmc+KTogdm9pZCB7XG4gICAgdGhpcy5fcmVkYWN0ZWRLZXlzID0gc2hhcmVkU2V0O1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIGN1cnJlbnQgcmVkYWN0ZWQta2V5cyBzZXQgKGZvciBzaGFyaW5nIHdpdGggb3RoZXIgc2NvcGVzKS5cbiAgICogQGludGVybmFsXG4gICAqL1xuICBnZXRSZWRhY3RlZEtleXMoKTogU2V0PHN0cmluZz4ge1xuICAgIHJldHVybiB0aGlzLl9yZWRhY3RlZEtleXM7XG4gIH1cblxuICAvKipcbiAgICogQXBwbHkgYSBkZWNsYXJhdGl2ZSByZWRhY3Rpb24gcG9saWN5LiBUaGUgcG9saWN5IGlzIGFkZGl0aXZlIOKAlFxuICAgKiBpdCB3b3JrcyBhbG9uZ3NpZGUgbWFudWFsIGBzZXRWYWx1ZSguLi4sIHRydWUpYCBjYWxscy5cbiAgICogQGludGVybmFsXG4gICAqL1xuICB1c2VSZWRhY3Rpb25Qb2xpY3kocG9saWN5OiBSZWRhY3Rpb25Qb2xpY3kpOiB2b2lkIHtcbiAgICB0aGlzLl9yZWRhY3Rpb25Qb2xpY3kgPSBwb2xpY3k7XG4gICAgLy8gUHJlLXBvcHVsYXRlIGZpZWxkLWxldmVsIHJlZGFjdGlvbiBtYXAgZnJvbSBwb2xpY3lcbiAgICBpZiAocG9saWN5LmZpZWxkcykge1xuICAgICAgZm9yIChjb25zdCBba2V5LCBmaWVsZHNdIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeS5maWVsZHMpKSB7XG4gICAgICAgIHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuc2V0KGtleSwgbmV3IFNldChmaWVsZHMpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIGdldFJlZGFjdGlvblBvbGljeSgpOiBSZWRhY3Rpb25Qb2xpY3kgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLl9yZWRhY3Rpb25Qb2xpY3k7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyBhIGNvbXBsaWFuY2UtZnJpZW5kbHkgcmVwb3J0IG9mIGFsbCByZWRhY3Rpb24gYWN0aXZpdHkuXG4gICAqIE5ldmVyIGluY2x1ZGVzIGFjdHVhbCB2YWx1ZXMg4oCUIG9ubHkga2V5IG5hbWVzLCBmaWVsZCBuYW1lcywgYW5kIHBhdHRlcm5zLlxuICAgKi9cbiAgZ2V0UmVkYWN0aW9uUmVwb3J0KCk6IFJlZGFjdGlvblJlcG9ydCB7XG4gICAgY29uc3QgZmllbGRSZWRhY3Rpb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGZpZWxkc10gb2YgdGhpcy5fcmVkYWN0ZWRGaWVsZHNCeUtleSkge1xuICAgICAgZmllbGRSZWRhY3Rpb25zW2tleV0gPSBbLi4uZmllbGRzXTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlZGFjdGVkS2V5czogWy4uLnRoaXMuX3JlZGFjdGVkS2V5c10sXG4gICAgICBmaWVsZFJlZGFjdGlvbnMsXG4gICAgICBwYXR0ZXJuczogKHRoaXMuX3JlZGFjdGlvblBvbGljeT8ucGF0dGVybnMgPz8gW10pLm1hcCgocCkgPT4gcC5zb3VyY2UpLFxuICAgIH07XG4gIH1cblxuICAvLyDilIDilIAgUmVjb3JkZXIgTWFuYWdlbWVudCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBhdHRhY2hSZWNvcmRlcihyZWNvcmRlcjogUmVjb3JkZXIpOiB2b2lkIHtcbiAgICAvLyBSZXBsYWNlIGV4aXN0aW5nIHJlY29yZGVyIHdpdGggc2FtZSBJRCAoaWRlbXBvdGVudCDigJQgcHJldmVudHMgZG91YmxlLWNvdW50aW5nKVxuICAgIHRoaXMuX3JlY29yZGVycyA9IHRoaXMuX3JlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlY29yZGVyLmlkKTtcbiAgICB0aGlzLl9yZWNvcmRlcnMucHVzaChyZWNvcmRlcik7XG4gIH1cblxuICBkZXRhY2hSZWNvcmRlcihyZWNvcmRlcklkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9yZWNvcmRlcnMgPSB0aGlzLl9yZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSByZWNvcmRlcklkKTtcbiAgfVxuXG4gIGdldFJlY29yZGVycygpOiBSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuX3JlY29yZGVyc107XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIG5vdGlmeVN0YWdlU3RhcnQoKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25TdGFnZVN0YXJ0Jywge1xuICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgfSk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIG5vdGlmeVN0YWdlRW5kKGR1cmF0aW9uPzogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25TdGFnZUVuZCcsIHtcbiAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgZHVyYXRpb24sXG4gICAgfSk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIG5vdGlmeVBhdXNlKHN0YWdlSWQ6IHN0cmluZywgcGF1c2VEYXRhPzogdW5rbm93bik6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uUGF1c2UnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIHN0YWdlSWQsXG4gICAgICBwYXVzZURhdGEsXG4gICAgfSk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIG5vdGlmeVJlc3VtZShzdGFnZUlkOiBzdHJpbmcsIGhhc0lucHV0OiBib29sZWFuKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25SZXN1bWUnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIHN0YWdlSWQsXG4gICAgICBoYXNJbnB1dCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgbm90aWZ5Q29tbWl0KG11dGF0aW9uczogQ29tbWl0RXZlbnRbJ211dGF0aW9ucyddKTogdm9pZCB7XG4gICAgdGhpcy5faW52b2tlSG9vaygnb25Db21taXQnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIG11dGF0aW9ucyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBDYWxsZWQgYnkgU3RhZ2VDb250ZXh0LmNvbW1pdCgpIG9ic2VydmVyLiBDb252ZXJ0cyB0cmFja2VkIHdyaXRlcyB0byBDb21taXRFdmVudCBmb3JtYXQuXG4gICAqICBFcnJvcnMgYXJlIGNhdWdodCB0byBwcmV2ZW50IHJlY29yZGVyIGlzc3VlcyBmcm9tIGFib3J0aW5nIHRoZSB0cmF2ZXJzYWwuICovXG4gIHByaXZhdGUgX29uQ29tbWl0RmlyZWQobXV0YXRpb25zOiBSZWNvcmQ8c3RyaW5nLCB7IHZhbHVlOiB1bmtub3duOyBvcGVyYXRpb246ICdzZXQnIHwgJ3VwZGF0ZScgfCAnZGVsZXRlJyB9Pik6IHZvaWQge1xuICAgIGlmICh0aGlzLl9yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY29tbWl0TXV0YXRpb25zOiBDb21taXRFdmVudFsnbXV0YXRpb25zJ10gPSBPYmplY3QuZW50cmllcyhtdXRhdGlvbnMpLm1hcCgoW2tleSwgZW50cnldKSA9PiB7XG4gICAgICAgIGNvbnN0IGlzUmVkYWN0ZWQgPSB0aGlzLl9pc0tleVJlZGFjdGVkKGtleSkgfHwgdGhpcy5faXNQb2xpY3lSZWRhY3RlZChrZXkpO1xuICAgICAgICBjb25zdCBmaWVsZFNldCA9IHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuZ2V0KGtleSk7XG5cbiAgICAgICAgbGV0IHJlY29yZGVyVmFsdWU6IHVua25vd247XG4gICAgICAgIGlmIChpc1JlZGFjdGVkKSB7XG4gICAgICAgICAgcmVjb3JkZXJWYWx1ZSA9ICdbUkVEQUNURURdJztcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZFNldCAmJiBlbnRyeS52YWx1ZSAmJiB0eXBlb2YgZW50cnkudmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHRoaXMuX3NjcnViRmllbGRzKGVudHJ5LnZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZFNldCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IGVudHJ5LnZhbHVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBrZXksXG4gICAgICAgICAgdmFsdWU6IHJlY29yZGVyVmFsdWUsXG4gICAgICAgICAgb3BlcmF0aW9uOiBlbnRyeS5vcGVyYXRpb24sXG4gICAgICAgIH07XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5ub3RpZnlDb21taXQoY29tbWl0TXV0YXRpb25zKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFN3YWxsb3cg4oCUIHJlY29yZGVyIGVycm9ycyBtdXN0IG5vdCBhYm9ydCB0aGUgdHJhdmVyc2FsLlxuICAgICAgLy8gSW5kaXZpZHVhbCByZWNvcmRlciBlcnJvcnMgYXJlIGFscmVhZHkgaXNvbGF0ZWQgYnkgX2ludm9rZUhvb2suXG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIERlYnVnIC8gRGlhZ25vc3RpY3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYWRkRGVidWdJbmZvKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMuX3N0YWdlQ29udGV4dC5hZGRMb2coa2V5LCB2YWx1ZSk7XG4gIH1cblxuICBhZGREZWJ1Z01lc3NhZ2UodmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQuYWRkTG9nKCdtZXNzYWdlcycsIFt2YWx1ZV0pO1xuICB9XG5cbiAgYWRkRXJyb3JJbmZvKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMuX3N0YWdlQ29udGV4dC5hZGRFcnJvcihrZXksIHZhbHVlKTtcbiAgfVxuXG4gIGFkZE1ldHJpYyhtZXRyaWNOYW1lOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0LmFkZE1ldHJpYyhtZXRyaWNOYW1lLCB2YWx1ZSk7XG4gIH1cblxuICBhZGRFdmFsKG1ldHJpY05hbWU6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQuYWRkRXZhbChtZXRyaWNOYW1lLCB2YWx1ZSk7XG4gIH1cblxuICAvLyDilIDilIAgTm9uLVRyYWNraW5nIFN0YXRlIEluc3BlY3Rpb24gKGZvciBUeXBlZFNjb3BlIHByb3h5IGludGVybmFscykg4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIFJldHVybnMgYWxsIHN0YXRlIGtleXMgd2l0aG91dCBmaXJpbmcgb25SZWFkLiBVc2VkIGJ5IFR5cGVkU2NvcGUgb3duS2V5cy9oYXMgdHJhcHMuICovXG4gIGdldFN0YXRlS2V5cygpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgc25hcHNob3QgPSB0aGlzLl9zdGFnZUNvbnRleHQuZ2V0VmFsdWUoW10sIHVuZGVmaW5lZCk7XG4gICAgaWYgKCFzbmFwc2hvdCB8fCB0eXBlb2Ygc25hcHNob3QgIT09ICdvYmplY3QnKSByZXR1cm4gW107XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHNuYXBzaG90IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgfVxuXG4gIC8qKiBDaGVjayBrZXkgZXhpc3RlbmNlIHdpdGhvdXQgZmlyaW5nIG9uUmVhZC4gVXNlZCBieSBUeXBlZFNjb3BlIGhhcyB0cmFwLlxuICAgKiAgQ29udHJhY3Q6IHJldHVybnMgZmFsc2UgZm9yIGtleXMgbmV2ZXIgc2V0IE9SIGtleXMgc2V0IHRvIHVuZGVmaW5lZC5cbiAgICogIFRoaXMgbWF0Y2hlcyBkZWxldGVWYWx1ZSgpIHNlbWFudGljcyAoc2V0cyB0byB1bmRlZmluZWQgPSBkZWxldGVkKS4gKi9cbiAgaGFzS2V5KGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRWYWx1ZShbXSwga2V5KSAhPT0gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqIFJlYWQgc3RhdGUgd2l0aG91dCBmaXJpbmcgb25SZWFkLiBVc2VkIGJ5IGFycmF5IHByb3h5IGdldEN1cnJlbnQoKSB0byBhdm9pZFxuICAgKiAgcGhhbnRvbSByZWFkcyBvbiBpbnRlcm5hbCBhcnJheSBvcGVyYXRpb25zICgubGVuZ3RoLCAuaGFzLCBpdGVyYXRpb24sIGV0Yy4pLlxuICAgKiAgVGhlIGluaXRpYWwgcHJvcGVydHkgYWNjZXNzIGZpcmVzIG9uZSB0cmFja2VkIG9uUmVhZCB2aWEgZ2V0VmFsdWUoKTsgc3Vic2VxdWVudFxuICAgKiAgaW50ZXJuYWwgYXJyYXkgb3BlcmF0aW9ucyB1c2UgdGhpcyBtZXRob2QgdG8gc3RheSBzaWxlbnQuXG4gICAqICBOT1RFOiBMaWtlIGdldFZhbHVlKCksIHJldHVybnMgdGhlIHJhdyB2YWx1ZSB0byB0aGUgY2FsbGVyLiBSZWRhY3Rpb24gYXBwbGllc1xuICAgKiAgb25seSB0byByZWNvcmRlciBkaXNwYXRjaCDigJQgaXQgZG9lcyBub3QgZmlsdGVyIHRoZSByZXR1cm5lZCB2YWx1ZS4gVGhpcyBtYXRjaGVzXG4gICAqICB0aGUgZXhpc3RpbmcgZ2V0VmFsdWUoKSBjb250cmFjdCB3aGVyZSB1c2VyIGNvZGUgYWx3YXlzIHJlY2VpdmVzIHJhdyBkYXRhLiAqL1xuICBnZXRWYWx1ZVNpbGVudChrZXk/OiBzdHJpbmcpOiB1bmtub3duIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LmdldFZhbHVlRGlyZWN0KFtdLCBrZXkpO1xuICB9XG5cbiAgLy8g4pSA4pSAIFN0YXRlIEFjY2VzcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBnZXRJbml0aWFsVmFsdWVGb3Ioa2V5OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LmdldEdsb2JhbD8uKGtleSk7XG4gIH1cblxuICBnZXRWYWx1ZShrZXk/OiBzdHJpbmcpIHtcbiAgICBjb25zdCB2YWx1ZSA9IHRoaXMuX3N0YWdlQ29udGV4dC5nZXRWYWx1ZShbXSwga2V5KTtcblxuICAgIGlmICh0aGlzLl9yZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgaXNSZWRhY3RlZCA9IGtleSAhPT0gdW5kZWZpbmVkICYmIHRoaXMuX2lzS2V5UmVkYWN0ZWQoa2V5KTtcbiAgICAgIGNvbnN0IGZpZWxkU2V0ID0ga2V5ICE9PSB1bmRlZmluZWQgPyB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LmdldChrZXkpIDogdW5kZWZpbmVkO1xuXG4gICAgICBsZXQgcmVjb3JkZXJWYWx1ZTogdW5rbm93bjtcbiAgICAgIGlmIChpc1JlZGFjdGVkKSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSAnW1JFREFDVEVEXSc7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkU2V0ICYmIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHRoaXMuX3NjcnViRmllbGRzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZFNldCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2ludm9rZUhvb2soJ29uUmVhZCcsIHtcbiAgICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiByZWNvcmRlclZhbHVlLFxuICAgICAgICByZWRhY3RlZDogaXNSZWRhY3RlZCB8fCBmaWVsZFNldCAhPT0gdW5kZWZpbmVkIHx8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuXG4gIHNldFZhbHVlKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgc2hvdWxkUmVkYWN0PzogYm9vbGVhbiwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBhc3NlcnROb3RSZWFkb25seSh0aGlzLl9yZWFkT25seVZhbHVlcywga2V5LCAnd3JpdGUnKTtcblxuICAgIC8vIERldi1tb2RlOiB3YXJuIGlmIHRoZSB2YWx1ZSBjb250YWlucyBjaXJjdWxhciByZWZlcmVuY2VzLlxuICAgIC8vIENoZWNrIEFGVEVSIGFzc2VydE5vdFJlYWRvbmx5IOKAlCBkb24ndCB3YXJuIGZvciB3cml0ZXMgdGhhdCB3aWxsIGJlIGJsb2NrZWQuXG4gICAgLy8gQ2lyY3VsYXIgdmFsdWVzIHdvcmsgKHRlcm1pbmFsIHByb3h5IGhhbmRsZXMgdGhlbSkgYnV0IGNhbiBwcm9kdWNlXG4gICAgLy8gc3VycHJpc2luZyBiZWhhdmlvciBpbiBuYXJyYXRpdmUsIEpTT04gc2VyaWFsaXphdGlvbiwgYW5kIHNuYXBzaG90cy5cbiAgICBpZiAoaXNEZXZNb2RlKCkgJiYgdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgaWYgKGhhc0NpcmN1bGFyUmVmZXJlbmNlKHZhbHVlKSkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFtmb290cHJpbnRdIENpcmN1bGFyIHJlZmVyZW5jZSBkZXRlY3RlZCBpbiBzZXRWYWx1ZSgnJHtrZXl9JykuIGAgK1xuICAgICAgICAgICAgJ1dyaXRlcyBwYXN0IHRoZSBjeWNsZSBkZXB0aCB3aWxsIHVzZSB0ZXJtaW5hbCBwcm94eSB0cmFja2luZy4gJyArXG4gICAgICAgICAgICAnQ29uc2lkZXIgZmxhdHRlbmluZyB0aGUgZGF0YSBzdHJ1Y3R1cmUuJyxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBBdXRvLXJlZGFjdCBpZiBrZXkgbWF0Y2hlcyBwb2xpY3kgKGV4YWN0IGtleXMgb3IgcGF0dGVybnMpLCBvciBpZiB0aGUga2V5IHdhc1xuICAgIC8vIHByZXZpb3VzbHkgbWFya2VkIHJlZGFjdGVkIChlLmcuIGNhcnJpZWQgb3ZlciBmcm9tIGEgc3ViZmxvdyB2aWEgb3V0cHV0TWFwcGVyKS5cbiAgICBjb25zdCBlZmZlY3RpdmVSZWRhY3QgPSBzaG91bGRSZWRhY3QgfHwgdGhpcy5faXNQb2xpY3lSZWRhY3RlZChrZXkpIHx8IHRoaXMuX3JlZGFjdGVkS2V5cy5oYXMoa2V5KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX3N0YWdlQ29udGV4dC5zZXRPYmplY3QoW10sIGtleSwgdmFsdWUsIGVmZmVjdGl2ZVJlZGFjdCwgZGVzY3JpcHRpb24pO1xuXG4gICAgaWYgKGVmZmVjdGl2ZVJlZGFjdCkge1xuICAgICAgdGhpcy5fcmVkYWN0ZWRLZXlzLmFkZChrZXkpO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBmaWVsZC1sZXZlbCByZWRhY3Rpb24gZnJvbSBwb2xpY3lcbiAgICBjb25zdCBmaWVsZFNldCA9IHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuZ2V0KGtleSk7XG5cbiAgICBpZiAodGhpcy5fcmVjb3JkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxldCByZWNvcmRlclZhbHVlOiB1bmtub3duO1xuICAgICAgaWYgKGVmZmVjdGl2ZVJlZGFjdCkge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gJ1tSRURBQ1RFRF0nO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFNldCAmJiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSB0aGlzLl9zY3J1YkZpZWxkcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZmllbGRTZXQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHZhbHVlO1xuICAgICAgfVxuXG4gICAgICB0aGlzLl9pbnZva2VIb29rKCdvbldyaXRlJywge1xuICAgICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgIGtleSxcbiAgICAgICAgdmFsdWU6IHJlY29yZGVyVmFsdWUsXG4gICAgICAgIG9wZXJhdGlvbjogJ3NldCcsXG4gICAgICAgIHJlZGFjdGVkOiBlZmZlY3RpdmVSZWRhY3QgfHwgZmllbGRTZXQgIT09IHVuZGVmaW5lZCB8fCB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgdXBkYXRlVmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBkZXNjcmlwdGlvbj86IHN0cmluZykge1xuICAgIGFzc2VydE5vdFJlYWRvbmx5KHRoaXMuX3JlYWRPbmx5VmFsdWVzLCBrZXksICd3cml0ZScpO1xuXG4gICAgLy8gRGV2LW1vZGU6IHNhbWUgY2lyY3VsYXIgY2hlY2sgYXMgc2V0VmFsdWUgKG1lcmdlIHRhcmdldHMgY2FuIGJlIGNpcmN1bGFyIHRvbylcbiAgICBpZiAoaXNEZXZNb2RlKCkgJiYgdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgaWYgKGhhc0NpcmN1bGFyUmVmZXJlbmNlKHZhbHVlKSkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFtmb290cHJpbnRdIENpcmN1bGFyIHJlZmVyZW5jZSBkZXRlY3RlZCBpbiB1cGRhdGVWYWx1ZSgnJHtrZXl9JykuIGAgK1xuICAgICAgICAgICAgJ0NvbnNpZGVyIGZsYXR0ZW5pbmcgdGhlIGRhdGEgc3RydWN0dXJlLicsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaXNSZWRhY3RlZCA9IHRoaXMuX2lzS2V5UmVkYWN0ZWQoa2V5KSB8fCB0aGlzLl9pc1BvbGljeVJlZGFjdGVkKGtleSk7XG4gICAgY29uc3QgcmVzdWx0ID0gdGhpcy5fc3RhZ2VDb250ZXh0LnVwZGF0ZU9iamVjdChbXSwga2V5LCB2YWx1ZSwgZGVzY3JpcHRpb24sIGlzUmVkYWN0ZWQpO1xuXG4gICAgaWYgKHRoaXMuX3JlY29yZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBmaWVsZFNldCA9IHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkuZ2V0KGtleSk7XG5cbiAgICAgIGxldCByZWNvcmRlclZhbHVlOiB1bmtub3duO1xuICAgICAgaWYgKGlzUmVkYWN0ZWQpIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9ICdbUkVEQUNURURdJztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRTZXQgJiYgdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gdGhpcy5fc2NydWJGaWVsZHModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGZpZWxkU2V0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5faW52b2tlSG9vaygnb25Xcml0ZScsIHtcbiAgICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiByZWNvcmRlclZhbHVlLFxuICAgICAgICBvcGVyYXRpb246ICd1cGRhdGUnLFxuICAgICAgICByZWRhY3RlZDogaXNSZWRhY3RlZCB8fCBmaWVsZFNldCAhPT0gdW5kZWZpbmVkIHx8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBkZWxldGVWYWx1ZShrZXk6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBhc3NlcnROb3RSZWFkb25seSh0aGlzLl9yZWFkT25seVZhbHVlcywga2V5LCAnZGVsZXRlJyk7XG5cbiAgICBjb25zdCByZXN1bHQgPSB0aGlzLl9zdGFnZUNvbnRleHQuc2V0T2JqZWN0KFtdLCBrZXksIHVuZGVmaW5lZCwgZmFsc2UsIGRlc2NyaXB0aW9uID8/IGBkZWxldGVkICR7a2V5fWAsICdkZWxldGUnKTtcblxuICAgIC8vIERlbGV0aW5nIGEgcmVkYWN0ZWQga2V5IGNsZWFycyBpdHMgcmVkYWN0aW9uIHN0YXR1c1xuICAgIHRoaXMuX3JlZGFjdGVkS2V5cy5kZWxldGUoa2V5KTtcblxuICAgIGlmICh0aGlzLl9yZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5faW52b2tlSG9vaygnb25Xcml0ZScsIHtcbiAgICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiB1bmRlZmluZWQsXG4gICAgICAgIG9wZXJhdGlvbjogJ2RlbGV0ZScsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBzZXRHbG9iYWwoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBkZXNjcmlwdGlvbj86IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9zdGFnZUNvbnRleHQuc2V0R2xvYmFsPy4oa2V5LCB2YWx1ZSwgZGVzY3JpcHRpb24pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRHbG9iYWwoa2V5OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LmdldEdsb2JhbD8uKGtleSk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIHNldE9iamVjdEluUm9vdChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LnNldFJvb3Q/LihrZXksIHZhbHVlKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBSZWFkLW9ubHkgKyBtaXNjIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSByZWFkb25seSBpbnB1dCB2YWx1ZXMgcGFzc2VkIHRvIHRoaXMgcGlwZWxpbmUsIGNhc3QgdG8gYFRgLlxuICAgKiBUaGUgcmV0dXJuZWQgb2JqZWN0IGlzIGRlZXBseSBmcm96ZW4g4oCUIGFueSBhdHRlbXB0IHRvIG11dGF0ZSBpdCB0aHJvd3MuXG4gICAqIENhY2hlZCBhdCBjb25zdHJ1Y3Rpb24gdGltZSBmb3IgemVyby1hbGxvY2F0aW9uIHJlcGVhdGVkIGFjY2Vzcy5cbiAgICpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBjb25zdCB7IGFwcGxpY2FudE5hbWUsIGluY29tZSB9ID0gc2NvcGUuZ2V0QXJnczx7IGFwcGxpY2FudE5hbWU6IHN0cmluZzsgaW5jb21lOiBudW1iZXIgfT4oKTtcbiAgICogYGBgXG4gICAqL1xuICBnZXRBcmdzPFQgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oKTogVCB7XG4gICAgcmV0dXJuIHRoaXMuX2Zyb3plbkFyZ3MgYXMgVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBleGVjdXRpb24gZW52aXJvbm1lbnQg4oCUIHJlYWQtb25seSBpbmZyYXN0cnVjdHVyZSB2YWx1ZXNcbiAgICogdGhhdCBwcm9wYWdhdGUgdGhyb3VnaCBuZXN0ZWQgZXhlY3V0b3JzIChsaWtlIGBwcm9jZXNzLmVudmAgZm9yIGZsb3djaGFydHMpLlxuICAgKlxuICAgKiBDb250YWluczogc2lnbmFsIChhYm9ydCksIHRpbWVvdXRNcywgdHJhY2VJZC5cbiAgICogRnJvemVuIGF0IGNvbnN0cnVjdGlvbiB0aW1lLiBJbmhlcml0ZWQgYnkgc3ViZmxvd3MgYXV0b21hdGljYWxseS5cbiAgICpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBjb25zdCB7IHNpZ25hbCwgdHJhY2VJZCB9ID0gc2NvcGUuZ2V0RW52KCk7XG4gICAqIGBgYFxuICAgKi9cbiAgZ2V0RW52KCk6IFJlYWRvbmx5PEV4ZWN1dGlvbkVudj4ge1xuICAgIHJldHVybiB0aGlzLl9leGVjdXRpb25FbnY7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIGdldFBpcGVsaW5lSWQoKSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBJbnRlcm5hbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQ2hlY2tzIGlmIGEga2V5IGlzIHJlZGFjdGVkIChleHBsaWNpdCBfcmVkYWN0ZWRLZXlzIHNldCkuICovXG4gIHByaXZhdGUgX2lzS2V5UmVkYWN0ZWQoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5fcmVkYWN0ZWRLZXlzLmhhcyhrZXkpO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrcyBpZiBhIGtleSBzaG91bGQgYmUgYXV0by1yZWRhY3RlZCBieSB0aGUgcG9saWN5IChleGFjdCBrZXlzICsgcGF0dGVybnMpLlxuICAgKlxuICAgKiBSZURvUyBndWFyZDogcGF0dGVybiB0ZXN0aW5nIGlzIGNhcHBlZCBhdCBNQVhfUEFUVEVSTl9LRVlfTEVOIGNoYXJhY3RlcnMuXG4gICAqIFNjb3BlIHN0YXRlIGtleXMgYXJlIGFsd2F5cyBzaG9ydCBpZGVudGlmaWVyczsgYW55IGtleSBleGNlZWRpbmcgdGhlIGNhcFxuICAgKiBpcyBhbG1vc3QgY2VydGFpbmx5IG5vdCBhIGxlZ2l0aW1hdGUgc2NvcGUga2V5LCBzbyBza2lwcGluZyBwYXR0ZXJuIG1hdGNoaW5nXG4gICAqIGZvciBpdCBkb2VzIG5vdCByaXNrIGxlYWtpbmcgUElJLiBFeGFjdC1rZXkgbWF0Y2hpbmcgKEFycmF5LmluY2x1ZGVzKSBpc1xuICAgKiBzdGlsbCBhcHBsaWVkIHJlZ2FyZGxlc3Mgb2YgbGVuZ3RoIGFuZCBpcyBub3QgdnVsbmVyYWJsZSB0byBSZURvUy5cbiAgICovXG4gIHByaXZhdGUgX2lzUG9saWN5UmVkYWN0ZWQoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAoIXRoaXMuX3JlZGFjdGlvblBvbGljeSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0aGlzLl9yZWRhY3Rpb25Qb2xpY3kua2V5cz8uaW5jbHVkZXMoa2V5KSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHRoaXMuX3JlZGFjdGlvblBvbGljeS5wYXR0ZXJucykge1xuICAgICAgaWYgKGtleS5sZW5ndGggPiBTY29wZUZhY2FkZS5fTUFYX1BBVFRFUk5fS0VZX0xFTikge1xuICAgICAgICAvLyBEZXYtbW9kZSB3YXJuaW5nOiBwYXR0ZXJuIG1hdGNoaW5nIHdhcyBzaWxlbnRseSBza2lwcGVkIGZvciB0aGlzIGtleS5cbiAgICAgICAgLy8gVXNlIHBvbGljeS5rZXlzIGZvciBleGFjdCBtYXRjaGluZyBvZiBsb25nIGtleSBuYW1lcy5cbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgICBgW2Zvb3RwcmludF0gUmVkYWN0aW9uUG9saWN5OiBrZXkgJyR7a2V5LnNsaWNlKDAsIDQwKX0uLi4nICgke2tleS5sZW5ndGh9IGNoYXJzKSBleGNlZWRzIGAgK1xuICAgICAgICAgICAgICAndGhlIHBhdHRlcm4tbWF0Y2hpbmcgbGVuZ3RoIGNhcCBhbmQgd2FzIHNraXBwZWQuICcgK1xuICAgICAgICAgICAgICAnVXNlIHBvbGljeS5rZXlzIGZvciBleGFjdCBtYXRjaGluZyBvZiBsb25nIGtleSBuYW1lcy4nLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvciAoY29uc3QgcCBvZiB0aGlzLl9yZWRhY3Rpb25Qb2xpY3kucGF0dGVybnMpIHtcbiAgICAgICAgICBwLmxhc3RJbmRleCA9IDA7IC8vIFJlc2V0IHN0YXRlZnVsIGdsb2JhbC9zdGlja3kgcmVnZXhlc1xuICAgICAgICAgIGlmIChwLnRlc3Qoa2V5KSkgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLyoqXG4gICAqIE1heGltdW0ga2V5IGxlbmd0aCAoY2hhcmFjdGVycykgdGhhdCB3aWxsIGJlIHRlc3RlZCBhZ2FpbnN0IHJlZ2V4IHJlZGFjdGlvblxuICAgKiBwYXR0ZXJucy4gS2V5cyBsb25nZXIgdGhhbiB0aGlzIGFyZSBza2lwcGVkIGZvciBwYXR0ZXJuIG1hdGNoaW5nIHRvIHByZXZlbnRcbiAgICogUmVEb1M6IGEgcGF0aG9sb2dpY2FsIHJlZ2V4IHRlc3RlZCBhZ2FpbnN0IGFuIHVuYm91bmRlZGx5IGxvbmcga2V5IHN0cmluZ1xuICAgKiBjYW4gY2F1c2UgY2F0YXN0cm9waGljIGJhY2t0cmFja2luZy5cbiAgICpcbiAgICogMjU2IGNoYXJhY3RlcnMgY29tZm9ydGFibHkgZXhjZWVkcyBhbnkgcmVhbGlzdGljIHNjb3BlLXN0YXRlIGtleSBuYW1lLlxuICAgKi9cbiAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgX01BWF9QQVRURVJOX0tFWV9MRU4gPSAyNTY7XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBkZWVwLWNsb25lZCBjb3B5IHdpdGggc3BlY2lmaWVkIGZpZWxkcyByZXBsYWNlZCBieSAnW1JFREFDVEVEXScuXG4gICAqIFN1cHBvcnRzIGRvdC1ub3RhdGlvbiBwYXRocyAoZS5nLiAnYWRkcmVzcy56aXAnKSBmb3IgbmVzdGVkIG9iamVjdHMuXG4gICAqL1xuICBwcml2YXRlIF9zY3J1YkZpZWxkcyhvYmo6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZHM6IFNldDxzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IGNvcHkgPSBzdHJ1Y3R1cmVkQ2xvbmUob2JqKTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGZpZWxkcykge1xuICAgICAgaWYgKGZpZWxkLmluY2x1ZGVzKCcuJykgJiYgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChjb3B5LCBmaWVsZCkpIHtcbiAgICAgICAgLy8gRG90LW5vdGF0aW9uIHBhdGgg4oaSIGRlZXAgc2NydWIgKG9ubHkgaWYgbm90IGEgbGl0ZXJhbCBmbGF0IGtleSlcbiAgICAgICAgaWYgKGxvZGFzaEhhcyhjb3B5LCBmaWVsZCkpIHtcbiAgICAgICAgICBsb2Rhc2hTZXQoY29weSwgZmllbGQsICdbUkVEQUNURURdJyk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY29weSwgZmllbGQpKSB7XG4gICAgICAgICAgY29weVtmaWVsZF0gPSAnW1JFREFDVEVEXSc7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGNvcHk7XG4gIH1cblxuICBwcml2YXRlIF9pbnZva2VIb29rKGhvb2s6IGtleW9mIE9taXQ8UmVjb3JkZXIsICdpZCc+LCBldmVudDogdW5rbm93bik6IHZvaWQge1xuICAgIGZvciAoY29uc3QgcmVjb3JkZXIgb2YgdGhpcy5fcmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBob29rRm4gPSByZWNvcmRlcltob29rXTtcbiAgICAgICAgaWYgKHR5cGVvZiBob29rRm4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAoaG9va0ZuIGFzIChldmVudDogdW5rbm93bikgPT4gdm9pZCkuY2FsbChyZWNvcmRlciwgZXZlbnQpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoaG9vayAhPT0gJ29uRXJyb3InKSB7XG4gICAgICAgICAgdGhpcy5faW52b2tlSG9vaygnb25FcnJvcicsIHtcbiAgICAgICAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgZXJyb3I6IGVycm9yIGFzIEVycm9yLFxuICAgICAgICAgICAgb3BlcmF0aW9uOiBob29rID09PSAnb25SZWFkJyA/ICdyZWFkJyA6IGhvb2sgPT09ICdvbkNvbW1pdCcgPyAnY29tbWl0JyA6ICd3cml0ZScsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==