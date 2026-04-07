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
import { nativeHas as lodashHas, nativeSet as lodashSet } from '../memory/pathOps.js';
import { hasCircularReference, isDevMode } from './detectCircular.js';
import { assertNotReadonly, createFrozenArgs } from './protection/readonlyInput.js';
export class ScopeFacade {
    constructor(context, stageName, readOnlyValues, executionEnv) {
        this._recorders = [];
        this._redactedFieldsByKey = new Map();
        this._stageContext = context;
        this._stageName = stageName;
        this._readOnlyValues = readOnlyValues;
        this._frozenArgs = createFrozenArgs(readOnlyValues);
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
        assertNotReadonly(this._readOnlyValues, key, 'write');
        // Dev-mode: warn if the value contains circular references.
        // Check AFTER assertNotReadonly — don't warn for writes that will be blocked.
        // Circular values work (terminal proxy handles them) but can produce
        // surprising behavior in narrative, JSON serialization, and snapshots.
        if (isDevMode() && value !== null && typeof value === 'object') {
            if (hasCircularReference(value)) {
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
        assertNotReadonly(this._readOnlyValues, key, 'write');
        // Dev-mode: same circular check as setValue (merge targets can be circular too)
        if (isDevMode() && value !== null && typeof value === 'object') {
            if (hasCircularReference(value)) {
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
        assertNotReadonly(this._readOnlyValues, key, 'delete');
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
                if (isDevMode()) {
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
                if (lodashHas(copy, field)) {
                    lodashSet(copy, field, '[REDACTED]');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2NvcGVGYWNhZGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL1Njb3BlRmFjYWRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBR0gsT0FBTyxFQUFFLFNBQVMsSUFBSSxTQUFTLEVBQUUsU0FBUyxJQUFJLFNBQVMsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRXRGLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxTQUFTLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUN0RSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSwrQkFBK0IsQ0FBQztBQUdwRixNQUFNLE9BQU8sV0FBVztJQWtCdEIsWUFBWSxPQUFxQixFQUFFLFNBQWlCLEVBQUUsY0FBd0IsRUFBRSxZQUEyQjtRQUxuRyxlQUFVLEdBQWUsRUFBRSxDQUFDO1FBRzVCLHlCQUFvQixHQUE2QixJQUFJLEdBQUcsRUFBRSxDQUFDO1FBR2pFLElBQUksQ0FBQyxhQUFhLEdBQUcsT0FBTyxDQUFDO1FBQzdCLElBQUksQ0FBQyxVQUFVLEdBQUcsU0FBUyxDQUFDO1FBQzVCLElBQUksQ0FBQyxlQUFlLEdBQUcsY0FBYyxDQUFDO1FBQ3RDLElBQUksQ0FBQyxXQUFXLEdBQUcsZ0JBQWdCLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDcEQsSUFBSSxDQUFDLGFBQWEsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsR0FBRyxZQUFZLEVBQUUsQ0FBQyxDQUFDO1FBQ3hELElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUV2Qyw4RkFBOEY7UUFDOUYsSUFBSSxDQUFDLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLFNBQVMsRUFBRSxFQUFFO1lBQ2pELElBQUksQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDakMsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFD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Q0gsQ0FBQztRQUNELE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVPLFdBQVcsQ0FBQyxJQUFnQyxFQUFFLEtBQWM7UUFDbEUsS0FBSyxNQUFNLFFBQVEsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDdkMsSUFBSSxDQUFDO2dCQUNILE1BQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDOUIsSUFBSSxPQUFPLE1BQU0sS0FBSyxVQUFVLEVBQUUsQ0FBQztvQkFDaEMsTUFBbUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLEtBQUssQ0FBQyxDQUFDO2dCQUM3RCxDQUFDO1lBQ0gsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2YsSUFBSSxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7b0JBQ3ZCLElBQUksQ0FBQyxXQUFXLENBQUMsU0FBUyxFQUFFO3dCQUMxQixTQUFTLEVBQUUsSUFBSSxDQUFDLFVBQVU7d0JBQzFCLFVBQVUsRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLEtBQUs7d0JBQ3BDLFNBQVMsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFO3dCQUNyQixLQUFLLEVBQUUsS0FBYzt3QkFDckIsU0FBUyxFQUFFLElBQUksS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLFVBQVUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPO3FCQUNqRixDQUFDLENBQUM7Z0JBQ0wsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQzs7QUFqaEJzQixpQkFBSyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQUFBL0IsQ0FBZ0M7QUErZDVEOzs7Ozs7O0dBT0c7QUFDcUIsZ0NBQW9CLEdBQUcsR0FBRyxBQUFOLENBQU8iLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNjb3BlRmFjYWRlIOKAlCBCYXNlIGNsYXNzIHRoYXQgbGlicmFyeSBjb25zdW1lcnMgZXh0ZW5kIHRvIGNyZWF0ZSBjdXN0b20gc2NvcGUgY2xhc3Nlc1xuICpcbiAqIFdyYXBzIFN0YWdlQ29udGV4dCAoZnJvbSBtZW1vcnkvKSB0byBwcm92aWRlIGEgY29uc3VtZXItZnJpZW5kbHkgQVBJIGZvclxuICogc3RhdGUgYWNjZXNzLCBkZWJ1ZyBsb2dnaW5nLCBtZXRyaWNzLCBhbmQgcmVjb3JkZXIgaG9va3MuXG4gKlxuICogQ29uc3VtZXJzIGV4dGVuZCB0aGlzIGNsYXNzIHRvIGFkZCBkb21haW4tc3BlY2lmaWMgcHJvcGVydGllczpcbiAqXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBjbGFzcyBNeVNjb3BlIGV4dGVuZHMgU2NvcGVGYWNhZGUge1xuICogICBnZXQgdXNlck5hbWUoKTogc3RyaW5nIHsgcmV0dXJuIHRoaXMuZ2V0VmFsdWUoJ25hbWUnKSBhcyBzdHJpbmc7IH1cbiAqICAgc2V0IHVzZXJOYW1lKHZhbHVlOiBzdHJpbmcpIHsgdGhpcy5zZXRWYWx1ZSgnbmFtZScsIHZhbHVlKTsgfVxuICogfVxuICogYGBgXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeGVjdXRpb25FbnYgfSBmcm9tICcuLi9lbmdpbmUvdHlwZXMuanMnO1xuaW1wb3J0IHsgbmF0aXZlSGFzIGFzIGxvZGFzaEhhcywgbmF0aXZlU2V0IGFzIGxvZGFzaFNldCB9IGZyb20gJy4uL21lbW9yeS9wYXRoT3BzLmpzJztcbmltcG9ydCB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHsgaGFzQ2lyY3VsYXJSZWZlcmVuY2UsIGlzRGV2TW9kZSB9IGZyb20gJy4vZGV0ZWN0Q2lyY3VsYXIuanMnO1xuaW1wb3J0IHsgYXNzZXJ0Tm90UmVhZG9ubHksIGNyZWF0ZUZyb3plbkFyZ3MgfSBmcm9tICcuL3Byb3RlY3Rpb24vcmVhZG9ubHlJbnB1dC5qcyc7XG5pbXBvcnQgdHlwZSB7IENvbW1pdEV2ZW50LCBSZWNvcmRlciwgUmVkYWN0aW9uUG9saWN5LCBSZWRhY3Rpb25SZXBvcnQgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIFNjb3BlRmFjYWRlIHtcbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBCUkFORCA9IFN5bWJvbC5mb3IoJ1Njb3BlRmFjYWRlQHYxJyk7XG5cbiAgcHJvdGVjdGVkIF9zdGFnZUNvbnRleHQ6IFN0YWdlQ29udGV4dDtcbiAgcHJvdGVjdGVkIF9zdGFnZU5hbWU6IHN0cmluZztcbiAgcHJvdGVjdGVkIHJlYWRvbmx5IF9yZWFkT25seVZhbHVlcz86IHVua25vd247XG5cbiAgLyoqIENhY2hlZCBkZWVwbHktZnJvemVuIGNvcHkgb2YgcmVhZE9ubHlWYWx1ZXMgZm9yIGdldEFyZ3MoKS4gQ3JlYXRlZCBvbmNlLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IF9mcm96ZW5BcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblxuICAvKiogRXhlY3V0aW9uIGVudmlyb25tZW50IOKAlCByZWFkLW9ubHksIGluaGVyaXRlZCBmcm9tIHBhcmVudCBleGVjdXRvci4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBfZXhlY3V0aW9uRW52OiBSZWFkb25seTxFeGVjdXRpb25FbnY+O1xuXG4gIHByaXZhdGUgX3JlY29yZGVyczogUmVjb3JkZXJbXSA9IFtdO1xuICBwcml2YXRlIF9yZWRhY3RlZEtleXM6IFNldDxzdHJpbmc+O1xuICBwcml2YXRlIF9yZWRhY3Rpb25Qb2xpY3k6IFJlZGFjdGlvblBvbGljeSB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfcmVkYWN0ZWRGaWVsZHNCeUtleTogTWFwPHN0cmluZywgU2V0PHN0cmluZz4+ID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0cnVjdG9yKGNvbnRleHQ6IFN0YWdlQ29udGV4dCwgc3RhZ2VOYW1lOiBzdHJpbmcsIHJlYWRPbmx5VmFsdWVzPzogdW5rbm93biwgZXhlY3V0aW9uRW52PzogRXhlY3V0aW9uRW52KSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0ID0gY29udGV4dDtcbiAgICB0aGlzLl9zdGFnZU5hbWUgPSBzdGFnZU5hbWU7XG4gICAgdGhpcy5fcmVhZE9ubHlWYWx1ZXMgPSByZWFkT25seVZhbHVlcztcbiAgICB0aGlzLl9mcm96ZW5BcmdzID0gY3JlYXRlRnJvemVuQXJncyhyZWFkT25seVZhbHVlcyk7XG4gICAgdGhpcy5fZXhlY3V0aW9uRW52ID0gT2JqZWN0LmZyZWV6ZSh7IC4uLmV4ZWN1dGlvbkVudiB9KTtcbiAgICB0aGlzLl9yZWRhY3RlZEtleXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAgIC8vIFJlZ2lzdGVyIGFzIGNvbW1pdCBvYnNlcnZlciBzbyBSZWNvcmRlci5vbkNvbW1pdCBmaXJlcyB3aGVuIFN0YWdlQ29udGV4dC5jb21taXQoKSBpcyBjYWxsZWRcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQuc2V0Q29tbWl0T2JzZXJ2ZXIoKG11dGF0aW9ucykgPT4ge1xuICAgICAgdGhpcy5fb25Db21taXRGaXJlZChtdXRhdGlvbnMpO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFNoYXJlIGEgcmVkYWN0ZWQta2V5cyBzZXQgYWNyb3NzIG11bHRpcGxlIFNjb3BlRmFjYWRlIGluc3RhbmNlcy5cbiAgICogQ2FsbCB0aGlzIHRvIG1ha2UgcmVkYWN0aW9uIHBlcnNpc3QgYWNyb3NzIHN0YWdlcyBpbiB0aGUgc2FtZSBwaXBlbGluZS5cbiAgICogQGludGVybmFsXG4gICAqL1xuICB1c2VTaGFyZWRSZWRhY3RlZEtleXMoc2hhcmVkU2V0OiBTZXQ8c3RyaW5nPik6IHZvaWQge1xuICAgIHRoaXMuX3JlZGFjdGVkS2V5cyA9IHNoYXJlZFNldDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBjdXJyZW50IHJlZGFjdGVkLWtleXMgc2V0IChmb3Igc2hhcmluZyB3aXRoIG90aGVyIHNjb3BlcykuXG4gICAqIEBpbnRlcm5hbFxuICAgKi9cbiAgZ2V0UmVkYWN0ZWRLZXlzKCk6IFNldDxzdHJpbmc+IHtcbiAgICByZXR1cm4gdGhpcy5fcmVkYWN0ZWRLZXlzO1xuICB9XG5cbiAgLyoqXG4gICAqIEFwcGx5IGEgZGVjbGFyYXRpdmUgcmVkYWN0aW9uIHBvbGljeS4gVGhlIHBvbGljeSBpcyBhZGRpdGl2ZSDigJRcbiAgICogaXQgd29ya3MgYWxvbmdzaWRlIG1hbnVhbCBgc2V0VmFsdWUoLi4uLCB0cnVlKWAgY2FsbHMuXG4gICAqIEBpbnRlcm5hbFxuICAgKi9cbiAgdXNlUmVkYWN0aW9uUG9saWN5KHBvbGljeTogUmVkYWN0aW9uUG9saWN5KTogdm9pZCB7XG4gICAgdGhpcy5fcmVkYWN0aW9uUG9saWN5ID0gcG9saWN5O1xuICAgIC8vIFByZS1wb3B1bGF0ZSBmaWVsZC1sZXZlbCByZWRhY3Rpb24gbWFwIGZyb20gcG9saWN5XG4gICAgaWYgKHBvbGljeS5maWVsZHMpIHtcbiAgICAgIGZvciAoY29uc3QgW2tleSwgZmllbGRzXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3kuZmllbGRzKSkge1xuICAgICAgICB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LnNldChrZXksIG5ldyBTZXQoZmllbGRzKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRSZWRhY3Rpb25Qb2xpY3koKTogUmVkYWN0aW9uUG9saWN5IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5fcmVkYWN0aW9uUG9saWN5O1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBjb21wbGlhbmNlLWZyaWVuZGx5IHJlcG9ydCBvZiBhbGwgcmVkYWN0aW9uIGFjdGl2aXR5LlxuICAgKiBOZXZlciBpbmNsdWRlcyBhY3R1YWwgdmFsdWVzIOKAlCBvbmx5IGtleSBuYW1lcywgZmllbGQgbmFtZXMsIGFuZCBwYXR0ZXJucy5cbiAgICovXG4gIGdldFJlZGFjdGlvblJlcG9ydCgpOiBSZWRhY3Rpb25SZXBvcnQge1xuICAgIGNvbnN0IGZpZWxkUmVkYWN0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG4gICAgZm9yIChjb25zdCBba2V5LCBmaWVsZHNdIG9mIHRoaXMuX3JlZGFjdGVkRmllbGRzQnlLZXkpIHtcbiAgICAgIGZpZWxkUmVkYWN0aW9uc1trZXldID0gWy4uLmZpZWxkc107XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICByZWRhY3RlZEtleXM6IFsuLi50aGlzLl9yZWRhY3RlZEtleXNdLFxuICAgICAgZmllbGRSZWRhY3Rpb25zLFxuICAgICAgcGF0dGVybnM6ICh0aGlzLl9yZWRhY3Rpb25Qb2xpY3k/LnBhdHRlcm5zID8/IFtdKS5tYXAoKHApID0+IHAuc291cmNlKSxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSAIFJlY29yZGVyIE1hbmFnZW1lbnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYXR0YWNoUmVjb3JkZXIocmVjb3JkZXI6IFJlY29yZGVyKTogdm9pZCB7XG4gICAgLy8gUmVwbGFjZSBleGlzdGluZyByZWNvcmRlciB3aXRoIHNhbWUgSUQgKGlkZW1wb3RlbnQg4oCUIHByZXZlbnRzIGRvdWJsZS1jb3VudGluZylcbiAgICB0aGlzLl9yZWNvcmRlcnMgPSB0aGlzLl9yZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSByZWNvcmRlci5pZCk7XG4gICAgdGhpcy5fcmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICB9XG5cbiAgZGV0YWNoUmVjb3JkZXIocmVjb3JkZXJJZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fcmVjb3JkZXJzID0gdGhpcy5fcmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gcmVjb3JkZXJJZCk7XG4gIH1cblxuICBnZXRSZWNvcmRlcnMoKTogUmVjb3JkZXJbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLl9yZWNvcmRlcnNdO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlTdGFnZVN0YXJ0KCk6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uU3RhZ2VTdGFydCcsIHtcbiAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgcGlwZWxpbmVJZDogdGhpcy5fc3RhZ2VDb250ZXh0LnJ1bklkLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlTdGFnZUVuZChkdXJhdGlvbj86IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uU3RhZ2VFbmQnLCB7XG4gICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgIGR1cmF0aW9uLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlQYXVzZShzdGFnZUlkOiBzdHJpbmcsIHBhdXNlRGF0YT86IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLl9pbnZva2VIb29rKCdvblBhdXNlJywge1xuICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICBzdGFnZUlkLFxuICAgICAgcGF1c2VEYXRhLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBub3RpZnlSZXN1bWUoc3RhZ2VJZDogc3RyaW5nLCBoYXNJbnB1dDogYm9vbGVhbik6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uUmVzdW1lJywge1xuICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICBzdGFnZUlkLFxuICAgICAgaGFzSW5wdXQsXG4gICAgfSk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIG5vdGlmeUNvbW1pdChtdXRhdGlvbnM6IENvbW1pdEV2ZW50WydtdXRhdGlvbnMnXSk6IHZvaWQge1xuICAgIHRoaXMuX2ludm9rZUhvb2soJ29uQ29tbWl0Jywge1xuICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICBtdXRhdGlvbnMsXG4gICAgfSk7XG4gIH1cblxuICAvKiogQ2FsbGVkIGJ5IFN0YWdlQ29udGV4dC5jb21taXQoKSBvYnNlcnZlci4gQ29udmVydHMgdHJhY2tlZCB3cml0ZXMgdG8gQ29tbWl0RXZlbnQgZm9ybWF0LlxuICAgKiAgRXJyb3JzIGFyZSBjYXVnaHQgdG8gcHJldmVudCByZWNvcmRlciBpc3N1ZXMgZnJvbSBhYm9ydGluZyB0aGUgdHJhdmVyc2FsLiAqL1xuICBwcml2YXRlIF9vbkNvbW1pdEZpcmVkKG11dGF0aW9uczogUmVjb3JkPHN0cmluZywgeyB2YWx1ZTogdW5rbm93bjsgb3BlcmF0aW9uOiAnc2V0JyB8ICd1cGRhdGUnIHwgJ2RlbGV0ZScgfT4pOiB2b2lkIHtcbiAgICBpZiAodGhpcy5fcmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbW1pdE11dGF0aW9uczogQ29tbWl0RXZlbnRbJ211dGF0aW9ucyddID0gT2JqZWN0LmVudHJpZXMobXV0YXRpb25zKS5tYXAoKFtrZXksIGVudHJ5XSkgPT4ge1xuICAgICAgICBjb25zdCBpc1JlZGFjdGVkID0gdGhpcy5faXNLZXlSZWRhY3RlZChrZXkpIHx8IHRoaXMuX2lzUG9saWN5UmVkYWN0ZWQoa2V5KTtcbiAgICAgICAgY29uc3QgZmllbGRTZXQgPSB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LmdldChrZXkpO1xuXG4gICAgICAgIGxldCByZWNvcmRlclZhbHVlOiB1bmtub3duO1xuICAgICAgICBpZiAoaXNSZWRhY3RlZCkge1xuICAgICAgICAgIHJlY29yZGVyVmFsdWUgPSAnW1JFREFDVEVEXSc7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGRTZXQgJiYgZW50cnkudmFsdWUgJiYgdHlwZW9mIGVudHJ5LnZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHJlY29yZGVyVmFsdWUgPSB0aGlzLl9zY3J1YkZpZWxkcyhlbnRyeS52YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZmllbGRTZXQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlY29yZGVyVmFsdWUgPSBlbnRyeS52YWx1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2V5LFxuICAgICAgICAgIHZhbHVlOiByZWNvcmRlclZhbHVlLFxuICAgICAgICAgIG9wZXJhdGlvbjogZW50cnkub3BlcmF0aW9uLFxuICAgICAgICB9O1xuICAgICAgfSk7XG5cbiAgICAgIHRoaXMubm90aWZ5Q29tbWl0KGNvbW1pdE11dGF0aW9ucyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBTd2FsbG93IOKAlCByZWNvcmRlciBlcnJvcnMgbXVzdCBub3QgYWJvcnQgdGhlIHRyYXZlcnNhbC5cbiAgICAgIC8vIEluZGl2aWR1YWwgcmVjb3JkZXIgZXJyb3JzIGFyZSBhbHJlYWR5IGlzb2xhdGVkIGJ5IF9pbnZva2VIb29rLlxuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBEZWJ1ZyAvIERpYWdub3N0aWNzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFkZERlYnVnSW5mbyhrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQuYWRkTG9nKGtleSwgdmFsdWUpO1xuICB9XG5cbiAgYWRkRGVidWdNZXNzYWdlKHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0LmFkZExvZygnbWVzc2FnZXMnLCBbdmFsdWVdKTtcbiAgfVxuXG4gIGFkZEVycm9ySW5mbyhrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcbiAgICB0aGlzLl9zdGFnZUNvbnRleHQuYWRkRXJyb3Ioa2V5LCB2YWx1ZSk7XG4gIH1cblxuICBhZGRNZXRyaWMobWV0cmljTmFtZTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMuX3N0YWdlQ29udGV4dC5hZGRNZXRyaWMobWV0cmljTmFtZSwgdmFsdWUpO1xuICB9XG5cbiAgYWRkRXZhbChtZXRyaWNOYW1lOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5fc3RhZ2VDb250ZXh0LmFkZEV2YWwobWV0cmljTmFtZSwgdmFsdWUpO1xuICB9XG5cbiAgLy8g4pSA4pSAIE5vbi1UcmFja2luZyBTdGF0ZSBJbnNwZWN0aW9uIChmb3IgVHlwZWRTY29wZSBwcm94eSBpbnRlcm5hbHMpIOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBSZXR1cm5zIGFsbCBzdGF0ZSBrZXlzIHdpdGhvdXQgZmlyaW5nIG9uUmVhZC4gVXNlZCBieSBUeXBlZFNjb3BlIG93bktleXMvaGFzIHRyYXBzLiAqL1xuICBnZXRTdGF0ZUtleXMoKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHNuYXBzaG90ID0gdGhpcy5fc3RhZ2VDb250ZXh0LmdldFZhbHVlKFtdLCB1bmRlZmluZWQpO1xuICAgIGlmICghc25hcHNob3QgfHwgdHlwZW9mIHNuYXBzaG90ICE9PSAnb2JqZWN0JykgcmV0dXJuIFtdO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyhzbmFwc2hvdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIH1cblxuICAvKiogQ2hlY2sga2V5IGV4aXN0ZW5jZSB3aXRob3V0IGZpcmluZyBvblJlYWQuIFVzZWQgYnkgVHlwZWRTY29wZSBoYXMgdHJhcC5cbiAgICogIENvbnRyYWN0OiByZXR1cm5zIGZhbHNlIGZvciBrZXlzIG5ldmVyIHNldCBPUiBrZXlzIHNldCB0byB1bmRlZmluZWQuXG4gICAqICBUaGlzIG1hdGNoZXMgZGVsZXRlVmFsdWUoKSBzZW1hbnRpY3MgKHNldHMgdG8gdW5kZWZpbmVkID0gZGVsZXRlZCkuICovXG4gIGhhc0tleShrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLl9zdGFnZUNvbnRleHQuZ2V0VmFsdWUoW10sIGtleSkgIT09IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKiBSZWFkIHN0YXRlIHdpdGhvdXQgZmlyaW5nIG9uUmVhZC4gVXNlZCBieSBhcnJheSBwcm94eSBnZXRDdXJyZW50KCkgdG8gYXZvaWRcbiAgICogIHBoYW50b20gcmVhZHMgb24gaW50ZXJuYWwgYXJyYXkgb3BlcmF0aW9ucyAoLmxlbmd0aCwgLmhhcywgaXRlcmF0aW9uLCBldGMuKS5cbiAgICogIFRoZSBpbml0aWFsIHByb3BlcnR5IGFjY2VzcyBmaXJlcyBvbmUgdHJhY2tlZCBvblJlYWQgdmlhIGdldFZhbHVlKCk7IHN1YnNlcXVlbnRcbiAgICogIGludGVybmFsIGFycmF5IG9wZXJhdGlvbnMgdXNlIHRoaXMgbWV0aG9kIHRvIHN0YXkgc2lsZW50LlxuICAgKiAgTk9URTogTGlrZSBnZXRWYWx1ZSgpLCByZXR1cm5zIHRoZSByYXcgdmFsdWUgdG8gdGhlIGNhbGxlci4gUmVkYWN0aW9uIGFwcGxpZXNcbiAgICogIG9ubHkgdG8gcmVjb3JkZXIgZGlzcGF0Y2gg4oCUIGl0IGRvZXMgbm90IGZpbHRlciB0aGUgcmV0dXJuZWQgdmFsdWUuIFRoaXMgbWF0Y2hlc1xuICAgKiAgdGhlIGV4aXN0aW5nIGdldFZhbHVlKCkgY29udHJhY3Qgd2hlcmUgdXNlciBjb2RlIGFsd2F5cyByZWNlaXZlcyByYXcgZGF0YS4gKi9cbiAgZ2V0VmFsdWVTaWxlbnQoa2V5Pzogc3RyaW5nKTogdW5rbm93biB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRWYWx1ZURpcmVjdChbXSwga2V5KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBTdGF0ZSBBY2Nlc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgZ2V0SW5pdGlhbFZhbHVlRm9yKGtleTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRHbG9iYWw/LihrZXkpO1xuICB9XG5cbiAgZ2V0VmFsdWUoa2V5Pzogc3RyaW5nKSB7XG4gICAgY29uc3QgdmFsdWUgPSB0aGlzLl9zdGFnZUNvbnRleHQuZ2V0VmFsdWUoW10sIGtleSk7XG5cbiAgICBpZiAodGhpcy5fcmVjb3JkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGlzUmVkYWN0ZWQgPSBrZXkgIT09IHVuZGVmaW5lZCAmJiB0aGlzLl9pc0tleVJlZGFjdGVkKGtleSk7XG4gICAgICBjb25zdCBmaWVsZFNldCA9IGtleSAhPT0gdW5kZWZpbmVkID8gdGhpcy5fcmVkYWN0ZWRGaWVsZHNCeUtleS5nZXQoa2V5KSA6IHVuZGVmaW5lZDtcblxuICAgICAgbGV0IHJlY29yZGVyVmFsdWU6IHVua25vd247XG4gICAgICBpZiAoaXNSZWRhY3RlZCkge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gJ1tSRURBQ1RFRF0nO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFNldCAmJiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSB0aGlzLl9zY3J1YkZpZWxkcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZmllbGRTZXQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHZhbHVlO1xuICAgICAgfVxuXG4gICAgICB0aGlzLl9pbnZva2VIb29rKCdvblJlYWQnLCB7XG4gICAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAga2V5LFxuICAgICAgICB2YWx1ZTogcmVjb3JkZXJWYWx1ZSxcbiAgICAgICAgcmVkYWN0ZWQ6IGlzUmVkYWN0ZWQgfHwgZmllbGRTZXQgIT09IHVuZGVmaW5lZCB8fCB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cblxuICBzZXRWYWx1ZShrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIHNob3VsZFJlZGFjdD86IGJvb2xlYW4sIGRlc2NyaXB0aW9uPzogc3RyaW5nKSB7XG4gICAgYXNzZXJ0Tm90UmVhZG9ubHkodGhpcy5fcmVhZE9ubHlWYWx1ZXMsIGtleSwgJ3dyaXRlJyk7XG5cbiAgICAvLyBEZXYtbW9kZTogd2FybiBpZiB0aGUgdmFsdWUgY29udGFpbnMgY2lyY3VsYXIgcmVmZXJlbmNlcy5cbiAgICAvLyBDaGVjayBBRlRFUiBhc3NlcnROb3RSZWFkb25seSDigJQgZG9uJ3Qgd2FybiBmb3Igd3JpdGVzIHRoYXQgd2lsbCBiZSBibG9ja2VkLlxuICAgIC8vIENpcmN1bGFyIHZhbHVlcyB3b3JrICh0ZXJtaW5hbCBwcm94eSBoYW5kbGVzIHRoZW0pIGJ1dCBjYW4gcHJvZHVjZVxuICAgIC8vIHN1cnByaXNpbmcgYmVoYXZpb3IgaW4gbmFycmF0aXZlLCBKU09OIHNlcmlhbGl6YXRpb24sIGFuZCBzbmFwc2hvdHMuXG4gICAgaWYgKGlzRGV2TW9kZSgpICYmIHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGlmIChoYXNDaXJjdWxhclJlZmVyZW5jZSh2YWx1ZSkpIHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBbZm9vdHByaW50XSBDaXJjdWxhciByZWZlcmVuY2UgZGV0ZWN0ZWQgaW4gc2V0VmFsdWUoJyR7a2V5fScpLiBgICtcbiAgICAgICAgICAgICdXcml0ZXMgcGFzdCB0aGUgY3ljbGUgZGVwdGggd2lsbCB1c2UgdGVybWluYWwgcHJveHkgdHJhY2tpbmcuICcgK1xuICAgICAgICAgICAgJ0NvbnNpZGVyIGZsYXR0ZW5pbmcgdGhlIGRhdGEgc3RydWN0dXJlLicsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQXV0by1yZWRhY3QgaWYga2V5IG1hdGNoZXMgcG9saWN5IChleGFjdCBrZXlzIG9yIHBhdHRlcm5zKSwgb3IgaWYgdGhlIGtleSB3YXNcbiAgICAvLyBwcmV2aW91c2x5IG1hcmtlZCByZWRhY3RlZCAoZS5nLiBjYXJyaWVkIG92ZXIgZnJvbSBhIHN1YmZsb3cgdmlhIG91dHB1dE1hcHBlcikuXG4gICAgY29uc3QgZWZmZWN0aXZlUmVkYWN0ID0gc2hvdWxkUmVkYWN0IHx8IHRoaXMuX2lzUG9saWN5UmVkYWN0ZWQoa2V5KSB8fCB0aGlzLl9yZWRhY3RlZEtleXMuaGFzKGtleSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSB0aGlzLl9zdGFnZUNvbnRleHQuc2V0T2JqZWN0KFtdLCBrZXksIHZhbHVlLCBlZmZlY3RpdmVSZWRhY3QsIGRlc2NyaXB0aW9uKTtcblxuICAgIGlmIChlZmZlY3RpdmVSZWRhY3QpIHtcbiAgICAgIHRoaXMuX3JlZGFjdGVkS2V5cy5hZGQoa2V5KTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgZmllbGQtbGV2ZWwgcmVkYWN0aW9uIGZyb20gcG9saWN5XG4gICAgY29uc3QgZmllbGRTZXQgPSB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LmdldChrZXkpO1xuXG4gICAgaWYgKHRoaXMuX3JlY29yZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICBsZXQgcmVjb3JkZXJWYWx1ZTogdW5rbm93bjtcbiAgICAgIGlmIChlZmZlY3RpdmVSZWRhY3QpIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9ICdbUkVEQUNURURdJztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRTZXQgJiYgdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gdGhpcy5fc2NydWJGaWVsZHModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGZpZWxkU2V0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5faW52b2tlSG9vaygnb25Xcml0ZScsIHtcbiAgICAgICAgc3RhZ2VOYW1lOiB0aGlzLl9zdGFnZU5hbWUsXG4gICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICBrZXksXG4gICAgICAgIHZhbHVlOiByZWNvcmRlclZhbHVlLFxuICAgICAgICBvcGVyYXRpb246ICdzZXQnLFxuICAgICAgICByZWRhY3RlZDogZWZmZWN0aXZlUmVkYWN0IHx8IGZpZWxkU2V0ICE9PSB1bmRlZmluZWQgfHwgdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIHVwZGF0ZVZhbHVlKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICBhc3NlcnROb3RSZWFkb25seSh0aGlzLl9yZWFkT25seVZhbHVlcywga2V5LCAnd3JpdGUnKTtcblxuICAgIC8vIERldi1tb2RlOiBzYW1lIGNpcmN1bGFyIGNoZWNrIGFzIHNldFZhbHVlIChtZXJnZSB0YXJnZXRzIGNhbiBiZSBjaXJjdWxhciB0b28pXG4gICAgaWYgKGlzRGV2TW9kZSgpICYmIHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGlmIChoYXNDaXJjdWxhclJlZmVyZW5jZSh2YWx1ZSkpIHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBbZm9vdHByaW50XSBDaXJjdWxhciByZWZlcmVuY2UgZGV0ZWN0ZWQgaW4gdXBkYXRlVmFsdWUoJyR7a2V5fScpLiBgICtcbiAgICAgICAgICAgICdDb25zaWRlciBmbGF0dGVuaW5nIHRoZSBkYXRhIHN0cnVjdHVyZS4nLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGlzUmVkYWN0ZWQgPSB0aGlzLl9pc0tleVJlZGFjdGVkKGtleSkgfHwgdGhpcy5faXNQb2xpY3lSZWRhY3RlZChrZXkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX3N0YWdlQ29udGV4dC51cGRhdGVPYmplY3QoW10sIGtleSwgdmFsdWUsIGRlc2NyaXB0aW9uLCBpc1JlZGFjdGVkKTtcblxuICAgIGlmICh0aGlzLl9yZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgZmllbGRTZXQgPSB0aGlzLl9yZWRhY3RlZEZpZWxkc0J5S2V5LmdldChrZXkpO1xuXG4gICAgICBsZXQgcmVjb3JkZXJWYWx1ZTogdW5rbm93bjtcbiAgICAgIGlmIChpc1JlZGFjdGVkKSB7XG4gICAgICAgIHJlY29yZGVyVmFsdWUgPSAnW1JFREFDVEVEXSc7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkU2V0ICYmIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmVjb3JkZXJWYWx1ZSA9IHRoaXMuX3NjcnViRmllbGRzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBmaWVsZFNldCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWNvcmRlclZhbHVlID0gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2ludm9rZUhvb2soJ29uV3JpdGUnLCB7XG4gICAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAga2V5LFxuICAgICAgICB2YWx1ZTogcmVjb3JkZXJWYWx1ZSxcbiAgICAgICAgb3BlcmF0aW9uOiAndXBkYXRlJyxcbiAgICAgICAgcmVkYWN0ZWQ6IGlzUmVkYWN0ZWQgfHwgZmllbGRTZXQgIT09IHVuZGVmaW5lZCB8fCB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgZGVsZXRlVmFsdWUoa2V5OiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nKSB7XG4gICAgYXNzZXJ0Tm90UmVhZG9ubHkodGhpcy5fcmVhZE9ubHlWYWx1ZXMsIGtleSwgJ2RlbGV0ZScpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdGhpcy5fc3RhZ2VDb250ZXh0LnNldE9iamVjdChbXSwga2V5LCB1bmRlZmluZWQsIGZhbHNlLCBkZXNjcmlwdGlvbiA/PyBgZGVsZXRlZCAke2tleX1gLCAnZGVsZXRlJyk7XG5cbiAgICAvLyBEZWxldGluZyBhIHJlZGFjdGVkIGtleSBjbGVhcnMgaXRzIHJlZGFjdGlvbiBzdGF0dXNcbiAgICB0aGlzLl9yZWRhY3RlZEtleXMuZGVsZXRlKGtleSk7XG5cbiAgICBpZiAodGhpcy5fcmVjb3JkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRoaXMuX2ludm9rZUhvb2soJ29uV3JpdGUnLCB7XG4gICAgICAgIHN0YWdlTmFtZTogdGhpcy5fc3RhZ2VOYW1lLFxuICAgICAgICBwaXBlbGluZUlkOiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQsXG4gICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAga2V5LFxuICAgICAgICB2YWx1ZTogdW5kZWZpbmVkLFxuICAgICAgICBvcGVyYXRpb246ICdkZWxldGUnLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgc2V0R2xvYmFsKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgZGVzY3JpcHRpb24/OiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VDb250ZXh0LnNldEdsb2JhbD8uKGtleSwgdmFsdWUsIGRlc2NyaXB0aW9uKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0R2xvYmFsKGtleTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5nZXRHbG9iYWw/LihrZXkpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBzZXRPYmplY3RJblJvb3Qoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlQ29udGV4dC5zZXRSb290Py4oa2V5LCB2YWx1ZSk7XG4gIH1cblxuICAvLyDilIDilIAgUmVhZC1vbmx5ICsgbWlzYyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgcmVhZG9ubHkgaW5wdXQgdmFsdWVzIHBhc3NlZCB0byB0aGlzIHBpcGVsaW5lLCBjYXN0IHRvIGBUYC5cbiAgICogVGhlIHJldHVybmVkIG9iamVjdCBpcyBkZWVwbHkgZnJvemVuIOKAlCBhbnkgYXR0ZW1wdCB0byBtdXRhdGUgaXQgdGhyb3dzLlxuICAgKiBDYWNoZWQgYXQgY29uc3RydWN0aW9uIHRpbWUgZm9yIHplcm8tYWxsb2NhdGlvbiByZXBlYXRlZCBhY2Nlc3MuXG4gICAqXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogY29uc3QgeyBhcHBsaWNhbnROYW1lLCBpbmNvbWUgfSA9IHNjb3BlLmdldEFyZ3M8eyBhcHBsaWNhbnROYW1lOiBzdHJpbmc7IGluY29tZTogbnVtYmVyIH0+KCk7XG4gICAqIGBgYFxuICAgKi9cbiAgZ2V0QXJnczxUID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCk6IFQge1xuICAgIHJldHVybiB0aGlzLl9mcm96ZW5BcmdzIGFzIFQ7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgZXhlY3V0aW9uIGVudmlyb25tZW50IOKAlCByZWFkLW9ubHkgaW5mcmFzdHJ1Y3R1cmUgdmFsdWVzXG4gICAqIHRoYXQgcHJvcGFnYXRlIHRocm91Z2ggbmVzdGVkIGV4ZWN1dG9ycyAobGlrZSBgcHJvY2Vzcy5lbnZgIGZvciBmbG93Y2hhcnRzKS5cbiAgICpcbiAgICogQ29udGFpbnM6IHNpZ25hbCAoYWJvcnQpLCB0aW1lb3V0TXMsIHRyYWNlSWQuXG4gICAqIEZyb3plbiBhdCBjb25zdHJ1Y3Rpb24gdGltZS4gSW5oZXJpdGVkIGJ5IHN1YmZsb3dzIGF1dG9tYXRpY2FsbHkuXG4gICAqXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogY29uc3QgeyBzaWduYWwsIHRyYWNlSWQgfSA9IHNjb3BlLmdldEVudigpO1xuICAgKiBgYGBcbiAgICovXG4gIGdldEVudigpOiBSZWFkb25seTxFeGVjdXRpb25FbnY+IHtcbiAgICByZXR1cm4gdGhpcy5fZXhlY3V0aW9uRW52O1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRQaXBlbGluZUlkKCkge1xuICAgIHJldHVybiB0aGlzLl9zdGFnZUNvbnRleHQucnVuSWQ7XG4gIH1cblxuICAvLyDilIDilIAgSW50ZXJuYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIENoZWNrcyBpZiBhIGtleSBpcyByZWRhY3RlZCAoZXhwbGljaXQgX3JlZGFjdGVkS2V5cyBzZXQpLiAqL1xuICBwcml2YXRlIF9pc0tleVJlZGFjdGVkKGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3JlZGFjdGVkS2V5cy5oYXMoa2V5KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDaGVja3MgaWYgYSBrZXkgc2hvdWxkIGJlIGF1dG8tcmVkYWN0ZWQgYnkgdGhlIHBvbGljeSAoZXhhY3Qga2V5cyArIHBhdHRlcm5zKS5cbiAgICpcbiAgICogUmVEb1MgZ3VhcmQ6IHBhdHRlcm4gdGVzdGluZyBpcyBjYXBwZWQgYXQgTUFYX1BBVFRFUk5fS0VZX0xFTiBjaGFyYWN0ZXJzLlxuICAgKiBTY29wZSBzdGF0ZSBrZXlzIGFyZSBhbHdheXMgc2hvcnQgaWRlbnRpZmllcnM7IGFueSBrZXkgZXhjZWVkaW5nIHRoZSBjYXBcbiAgICogaXMgYWxtb3N0IGNlcnRhaW5seSBub3QgYSBsZWdpdGltYXRlIHNjb3BlIGtleSwgc28gc2tpcHBpbmcgcGF0dGVybiBtYXRjaGluZ1xuICAgKiBmb3IgaXQgZG9lcyBub3QgcmlzayBsZWFraW5nIFBJSS4gRXhhY3Qta2V5IG1hdGNoaW5nIChBcnJheS5pbmNsdWRlcykgaXNcbiAgICogc3RpbGwgYXBwbGllZCByZWdhcmRsZXNzIG9mIGxlbmd0aCBhbmQgaXMgbm90IHZ1bG5lcmFibGUgdG8gUmVEb1MuXG4gICAqL1xuICBwcml2YXRlIF9pc1BvbGljeVJlZGFjdGVkKGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLl9yZWRhY3Rpb25Qb2xpY3kpIHJldHVybiBmYWxzZTtcbiAgICBpZiAodGhpcy5fcmVkYWN0aW9uUG9saWN5LmtleXM/LmluY2x1ZGVzKGtleSkpIHJldHVybiB0cnVlO1xuICAgIGlmICh0aGlzLl9yZWRhY3Rpb25Qb2xpY3kucGF0dGVybnMpIHtcbiAgICAgIGlmIChrZXkubGVuZ3RoID4gU2NvcGVGYWNhZGUuX01BWF9QQVRURVJOX0tFWV9MRU4pIHtcbiAgICAgICAgLy8gRGV2LW1vZGUgd2FybmluZzogcGF0dGVybiBtYXRjaGluZyB3YXMgc2lsZW50bHkgc2tpcHBlZCBmb3IgdGhpcyBrZXkuXG4gICAgICAgIC8vIFVzZSBwb2xpY3kua2V5cyBmb3IgZXhhY3QgbWF0Y2hpbmcgb2YgbG9uZyBrZXkgbmFtZXMuXG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSkge1xuICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgICAgYFtmb290cHJpbnRdIFJlZGFjdGlvblBvbGljeToga2V5ICcke2tleS5zbGljZSgwLCA0MCl9Li4uJyAoJHtrZXkubGVuZ3RofSBjaGFycykgZXhjZWVkcyBgICtcbiAgICAgICAgICAgICAgJ3RoZSBwYXR0ZXJuLW1hdGNoaW5nIGxlbmd0aCBjYXAgYW5kIHdhcyBza2lwcGVkLiAnICtcbiAgICAgICAgICAgICAgJ1VzZSBwb2xpY3kua2V5cyBmb3IgZXhhY3QgbWF0Y2hpbmcgb2YgbG9uZyBrZXkgbmFtZXMuJyxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKGNvbnN0IHAgb2YgdGhpcy5fcmVkYWN0aW9uUG9saWN5LnBhdHRlcm5zKSB7XG4gICAgICAgICAgcC5sYXN0SW5kZXggPSAwOyAvLyBSZXNldCBzdGF0ZWZ1bCBnbG9iYWwvc3RpY2t5IHJlZ2V4ZXNcbiAgICAgICAgICBpZiAocC50ZXN0KGtleSkpIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBNYXhpbXVtIGtleSBsZW5ndGggKGNoYXJhY3RlcnMpIHRoYXQgd2lsbCBiZSB0ZXN0ZWQgYWdhaW5zdCByZWdleCByZWRhY3Rpb25cbiAgICogcGF0dGVybnMuIEtleXMgbG9uZ2VyIHRoYW4gdGhpcyBhcmUgc2tpcHBlZCBmb3IgcGF0dGVybiBtYXRjaGluZyB0byBwcmV2ZW50XG4gICAqIFJlRG9TOiBhIHBhdGhvbG9naWNhbCByZWdleCB0ZXN0ZWQgYWdhaW5zdCBhbiB1bmJvdW5kZWRseSBsb25nIGtleSBzdHJpbmdcbiAgICogY2FuIGNhdXNlIGNhdGFzdHJvcGhpYyBiYWNrdHJhY2tpbmcuXG4gICAqXG4gICAqIDI1NiBjaGFyYWN0ZXJzIGNvbWZvcnRhYmx5IGV4Y2VlZHMgYW55IHJlYWxpc3RpYyBzY29wZS1zdGF0ZSBrZXkgbmFtZS5cbiAgICovXG4gIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IF9NQVhfUEFUVEVSTl9LRVlfTEVOID0gMjU2O1xuXG4gIC8qKlxuICAgKiBSZXR1cm5zIGEgZGVlcC1jbG9uZWQgY29weSB3aXRoIHNwZWNpZmllZCBmaWVsZHMgcmVwbGFjZWQgYnkgJ1tSRURBQ1RFRF0nLlxuICAgKiBTdXBwb3J0cyBkb3Qtbm90YXRpb24gcGF0aHMgKGUuZy4gJ2FkZHJlc3MuemlwJykgZm9yIG5lc3RlZCBvYmplY3RzLlxuICAgKi9cbiAgcHJpdmF0ZSBfc2NydWJGaWVsZHMob2JqOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZmllbGRzOiBTZXQ8c3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCBjb3B5ID0gc3RydWN0dXJlZENsb25lKG9iaik7XG4gICAgZm9yIChjb25zdCBmaWVsZCBvZiBmaWVsZHMpIHtcbiAgICAgIGlmIChmaWVsZC5pbmNsdWRlcygnLicpICYmICFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY29weSwgZmllbGQpKSB7XG4gICAgICAgIC8vIERvdC1ub3RhdGlvbiBwYXRoIOKGkiBkZWVwIHNjcnViIChvbmx5IGlmIG5vdCBhIGxpdGVyYWwgZmxhdCBrZXkpXG4gICAgICAgIGlmIChsb2Rhc2hIYXMoY29weSwgZmllbGQpKSB7XG4gICAgICAgICAgbG9kYXNoU2V0KGNvcHksIGZpZWxkLCAnW1JFREFDVEVEXScpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGNvcHksIGZpZWxkKSkge1xuICAgICAgICAgIGNvcHlbZmllbGRdID0gJ1tSRURBQ1RFRF0nO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBjb3B5O1xuICB9XG5cbiAgcHJpdmF0ZSBfaW52b2tlSG9vayhob29rOiBrZXlvZiBPbWl0PFJlY29yZGVyLCAnaWQnPiwgZXZlbnQ6IHVua25vd24pOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHJlY29yZGVyIG9mIHRoaXMuX3JlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgaG9va0ZuID0gcmVjb3JkZXJbaG9va107XG4gICAgICAgIGlmICh0eXBlb2YgaG9va0ZuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgKGhvb2tGbiBhcyAoZXZlbnQ6IHVua25vd24pID0+IHZvaWQpLmNhbGwocmVjb3JkZXIsIGV2ZW50KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKGhvb2sgIT09ICdvbkVycm9yJykge1xuICAgICAgICAgIHRoaXMuX2ludm9rZUhvb2soJ29uRXJyb3InLCB7XG4gICAgICAgICAgICBzdGFnZU5hbWU6IHRoaXMuX3N0YWdlTmFtZSxcbiAgICAgICAgICAgIHBpcGVsaW5lSWQ6IHRoaXMuX3N0YWdlQ29udGV4dC5ydW5JZCxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGVycm9yOiBlcnJvciBhcyBFcnJvcixcbiAgICAgICAgICAgIG9wZXJhdGlvbjogaG9vayA9PT0gJ29uUmVhZCcgPyAncmVhZCcgOiBob29rID09PSAnb25Db21taXQnID8gJ2NvbW1pdCcgOiAnd3JpdGUnLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iXX0=