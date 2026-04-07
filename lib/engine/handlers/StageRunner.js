"use strict";
/**
 * StageRunner — Executes individual stage functions.
 *
 * Responsibilities:
 * - Create scope via ScopeFactory for each stage
 * - Apply scope protection (createProtectedScope) to intercept direct assignments
 * - Handle streaming stages (onStart, onToken, onEnd lifecycle)
 * - Sync+async safety: only await real Promises (instanceof check)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StageRunner = void 0;
const types_js_1 = require("../../pause/types.js");
const types_js_2 = require("../../reactive/types.js");
const createProtectedScope_js_1 = require("../../scope/protection/createProtectedScope.js");
class StageRunner {
    constructor(deps) {
        this.deps = deps;
    }
    async run(node, stageFunc, context, breakFn) {
        var _a, _b, _c, _d, _e, _f;
        // Create scope via ScopeFactory — each stage gets its own scope instance
        const rawScope = this.deps.scopeFactory(context, node.name, this.deps.readOnlyContext, this.deps.executionEnv);
        // Wrap scope with protection to intercept direct property assignments.
        // Skip for TypedScope — it already has its own Proxy with proper set traps
        // that delegate to setValue().
        const isTypedScope = rawScope && rawScope[types_js_2.IS_TYPED_SCOPE] === true;
        const scope = isTypedScope
            ? rawScope
            : (0, createProtectedScope_js_1.createProtectedScope)(rawScope, {
                mode: this.deps.scopeProtectionMode,
                stageName: node.name,
            });
        // Set up streaming callback if this is a streaming stage
        let streamCallback;
        let accumulatedText = '';
        if (node.isStreaming) {
            const streamId = (_a = node.streamId) !== null && _a !== void 0 ? _a : node.name;
            streamCallback = (token) => {
                var _a, _b;
                accumulatedText += token;
                (_b = (_a = this.deps.streamHandlers) === null || _a === void 0 ? void 0 : _a.onToken) === null || _b === void 0 ? void 0 : _b.call(_a, streamId, token);
            };
            (_c = (_b = this.deps.streamHandlers) === null || _b === void 0 ? void 0 : _b.onStart) === null || _c === void 0 ? void 0 : _c.call(_b, streamId);
        }
        // Inject breakPipeline into TypedScope via BREAK_SETTER (if the scope supports it)
        if (rawScope && typeof rawScope[types_js_2.BREAK_SETTER] === 'function') {
            rawScope[types_js_2.BREAK_SETTER](breakFn);
        }
        // Notify recorders of stage start (if scope supports it)
        if (rawScope && typeof rawScope.notifyStageStart === 'function') {
            rawScope.notifyStageStart();
        }
        // Execute the stage function
        const output = stageFunc(scope, breakFn, streamCallback);
        // Sync+async safety: only await real Promises to avoid thenable assimilation
        let result;
        if (output instanceof Promise) {
            // Race against AbortSignal if provided
            if (this.deps.signal) {
                result = (await raceAbort(output, this.deps.signal));
            }
            else {
                result = (await output);
            }
        }
        else {
            result = output;
        }
        // Notify recorders of stage end (if scope supports it)
        if (rawScope && typeof rawScope.notifyStageEnd === 'function') {
            rawScope.notifyStageEnd();
        }
        // Call onEnd lifecycle hook for streaming stages
        if (node.isStreaming) {
            const streamId = (_d = node.streamId) !== null && _d !== void 0 ? _d : node.name;
            (_f = (_e = this.deps.streamHandlers) === null || _e === void 0 ? void 0 : _e.onEnd) === null || _f === void 0 ? void 0 : _f.call(_e, streamId, accumulatedText);
        }
        // ── Pause detection ──
        // Pausable stages: any non-void return = pause with that data.
        // Also supports explicit pause({ ... }) for backward compat.
        if (node.isPausable && result !== undefined) {
            const pauseData = (0, types_js_1.isPauseResult)(result) ? result.data : result;
            // Notify scope recorders before throwing
            if (rawScope && typeof rawScope.notifyPause === 'function') {
                rawScope.notifyPause(node.id, pauseData);
            }
            throw new types_js_1.PauseSignal(pauseData, node.id);
        }
        return result;
    }
}
exports.StageRunner = StageRunner;
/** Race a promise against an AbortSignal. Rejects with the signal's reason on abort. */
function raceAbort(promise, signal) {
    var _a;
    if (signal.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error((_a = signal.reason) !== null && _a !== void 0 ? _a : 'Aborted'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => { var _a; return reject(signal.reason instanceof Error ? signal.reason : new Error((_a = signal.reason) !== null && _a !== void 0 ? _a : 'Aborted')); };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((val) => {
            signal.removeEventListener('abort', onAbort);
            resolve(val);
        }, (err) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
        });
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3RhZ2VSdW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9TdGFnZVJ1bm5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7O0dBUUc7OztBQUdILG1EQUFrRTtBQUNsRSxzREFBdUU7QUFDdkUsNEZBQXNGO0FBSXRGLE1BQWEsV0FBVztJQUN0QixZQUE2QixJQUErQjtRQUEvQixTQUFJLEdBQUosSUFBSSxDQUEyQjtJQUFHLENBQUM7SUFFaEUsS0FBSyxDQUFDLEdBQUcsQ0FDUCxJQUE2QixFQUM3QixTQUFzQyxFQUN0QyxPQUFxQixFQUNyQixPQUFtQjs7UUFFbkIseUVBQXlFO1FBQ3pFLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFL0csdUVBQXVFO1FBQ3ZFLDJFQUEyRTtRQUMzRSwrQkFBK0I7UUFDL0IsTUFBTSxZQUFZLEdBQUcsUUFBUSxJQUFLLFFBQWdCLENBQUMseUJBQWMsQ0FBQyxLQUFLLElBQUksQ0FBQztRQUM1RSxNQUFNLEtBQUssR0FBRyxZQUFZO1lBQ3hCLENBQUMsQ0FBQyxRQUFRO1lBQ1YsQ0FBQyxDQUFFLElBQUEsOENBQW9CLEVBQUMsUUFBa0IsRUFBRTtnQkFDeEMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CO2dCQUNuQyxTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUk7YUFDckIsQ0FBWSxDQUFDO1FBRWxCLHlEQUF5RDtRQUN6RCxJQUFJLGNBQTBDLENBQUM7UUFDL0MsSUFBSSxlQUFlLEdBQUcsRUFBRSxDQUFDO1FBRXpCLElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3JCLE1BQU0s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UnVubmVyIOKAlCBFeGVjdXRlcyBpbmRpdmlkdWFsIHN0YWdlIGZ1bmN0aW9ucy5cbiAqXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogLSBDcmVhdGUgc2NvcGUgdmlhIFNjb3BlRmFjdG9yeSBmb3IgZWFjaCBzdGFnZVxuICogLSBBcHBseSBzY29wZSBwcm90ZWN0aW9uIChjcmVhdGVQcm90ZWN0ZWRTY29wZSkgdG8gaW50ZXJjZXB0IGRpcmVjdCBhc3NpZ25tZW50c1xuICogLSBIYW5kbGUgc3RyZWFtaW5nIHN0YWdlcyAob25TdGFydCwgb25Ub2tlbiwgb25FbmQgbGlmZWN5Y2xlKVxuICogLSBTeW5jK2FzeW5jIHNhZmV0eTogb25seSBhd2FpdCByZWFsIFByb21pc2VzIChpbnN0YW5jZW9mIGNoZWNrKVxuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlUmVzdWx0LCBQYXVzZVNpZ25hbCB9IGZyb20gJy4uLy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB7IEJSRUFLX1NFVFRFUiwgSVNfVFlQRURfU0NPUEUgfSBmcm9tICcuLi8uLi9yZWFjdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBjcmVhdGVQcm90ZWN0ZWRTY29wZSB9IGZyb20gJy4uLy4uL3Njb3BlL3Byb3RlY3Rpb24vY3JlYXRlUHJvdGVjdGVkU2NvcGUuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcywgU3RhZ2VGdW5jdGlvbiwgU3RyZWFtQ2FsbGJhY2sgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBTdGFnZVJ1bm5lcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBkZXBzOiBIYW5kbGVyRGVwczxUT3V0LCBUU2NvcGU+KSB7fVxuXG4gIGFzeW5jIHJ1bihcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBzdGFnZUZ1bmM6IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPixcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJlYWtGbjogKCkgPT4gdm9pZCxcbiAgKTogUHJvbWlzZTxUT3V0PiB7XG4gICAgLy8gQ3JlYXRlIHNjb3BlIHZpYSBTY29wZUZhY3Rvcnkg4oCUIGVhY2ggc3RhZ2UgZ2V0cyBpdHMgb3duIHNjb3BlIGluc3RhbmNlXG4gICAgY29uc3QgcmF3U2NvcGUgPSB0aGlzLmRlcHMuc2NvcGVGYWN0b3J5KGNvbnRleHQsIG5vZGUubmFtZSwgdGhpcy5kZXBzLnJlYWRPbmx5Q29udGV4dCwgdGhpcy5kZXBzLmV4ZWN1dGlvbkVudik7XG5cbiAgICAvLyBXcmFwIHNjb3BlIHdpdGggcHJvdGVjdGlvbiB0byBpbnRlcmNlcHQgZGlyZWN0IHByb3BlcnR5IGFzc2lnbm1lbnRzLlxuICAgIC8vIFNraXAgZm9yIFR5cGVkU2NvcGUg4oCUIGl0IGFscmVhZHkgaGFzIGl0cyBvd24gUHJveHkgd2l0aCBwcm9wZXIgc2V0IHRyYXBzXG4gICAgLy8gdGhhdCBkZWxlZ2F0ZSB0byBzZXRWYWx1ZSgpLlxuICAgIGNvbnN0IGlzVHlwZWRTY29wZSA9IHJhd1Njb3BlICYmIChyYXdTY29wZSBhcyBhbnkpW0lTX1RZUEVEX1NDT1BFXSA9PT0gdHJ1ZTtcbiAgICBjb25zdCBzY29wZSA9IGlzVHlwZWRTY29wZVxuICAgICAgPyByYXdTY29wZVxuICAgICAgOiAoY3JlYXRlUHJvdGVjdGVkU2NvcGUocmF3U2NvcGUgYXMgb2JqZWN0LCB7XG4gICAgICAgICAgbW9kZTogdGhpcy5kZXBzLnNjb3BlUHJvdGVjdGlvbk1vZGUsXG4gICAgICAgICAgc3RhZ2VOYW1lOiBub2RlLm5hbWUsXG4gICAgICAgIH0pIGFzIFRTY29wZSk7XG5cbiAgICAvLyBTZXQgdXAgc3RyZWFtaW5nIGNhbGxiYWNrIGlmIHRoaXMgaXMgYSBzdHJlYW1pbmcgc3RhZ2VcbiAgICBsZXQgc3RyZWFtQ2FsbGJhY2s6IFN0cmVhbUNhbGxiYWNrIHwgdW5kZWZpbmVkO1xuICAgIGxldCBhY2N1bXVsYXRlZFRleHQgPSAnJztcblxuICAgIGlmIChub2RlLmlzU3RyZWFtaW5nKSB7XG4gICAgICBjb25zdCBzdHJlYW1JZCA9IG5vZGUuc3RyZWFtSWQgPz8gbm9kZS5uYW1lO1xuICAgICAgc3RyZWFtQ2FsbGJhY2sgPSAodG9rZW46IHN0cmluZykgPT4ge1xuICAgICAgICBhY2N1bXVsYXRlZFRleHQgKz0gdG9rZW47XG4gICAgICAgIHRoaXMuZGVwcy5zdHJlYW1IYW5kbGVycz8ub25Ub2tlbj8uKHN0cmVhbUlkLCB0b2tlbik7XG4gICAgICB9O1xuICAgICAgdGhpcy5kZXBzLnN0cmVhbUhhbmRsZXJzPy5vblN0YXJ0Py4oc3RyZWFtSWQpO1xuICAgIH1cblxuICAgIC8vIEluamVjdCBicmVha1BpcGVsaW5lIGludG8gVHlwZWRTY29wZSB2aWEgQlJFQUtfU0VUVEVSIChpZiB0aGUgc2NvcGUgc3VwcG9ydHMgaXQpXG4gICAgaWYgKHJhd1Njb3BlICYmIHR5cGVvZiAocmF3U2NvcGUgYXMgYW55KVtCUkVBS19TRVRURVJdID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAocmF3U2NvcGUgYXMgYW55KVtCUkVBS19TRVRURVJdKGJyZWFrRm4pO1xuICAgIH1cblxuICAgIC8vIE5vdGlmeSByZWNvcmRlcnMgb2Ygc3RhZ2Ugc3RhcnQgKGlmIHNjb3BlIHN1cHBvcnRzIGl0KVxuICAgIGlmIChyYXdTY29wZSAmJiB0eXBlb2YgKHJhd1Njb3BlIGFzIGFueSkubm90aWZ5U3RhZ2VTdGFydCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgKHJhd1Njb3BlIGFzIGFueSkubm90aWZ5U3RhZ2VTdGFydCgpO1xuICAgIH1cblxuICAgIC8vIEV4ZWN1dGUgdGhlIHN0YWdlIGZ1bmN0aW9uXG4gICAgY29uc3Qgb3V0cHV0ID0gc3RhZ2VGdW5jKHNjb3BlLCBicmVha0ZuLCBzdHJlYW1DYWxsYmFjayk7XG5cbiAgICAvLyBTeW5jK2FzeW5jIHNhZmV0eTogb25seSBhd2FpdCByZWFsIFByb21pc2VzIHRvIGF2b2lkIHRoZW5hYmxlIGFzc2ltaWxhdGlvblxuICAgIGxldCByZXN1bHQ6IFRPdXQ7XG4gICAgaWYgKG91dHB1dCBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgIC8vIFJhY2UgYWdhaW5zdCBBYm9ydFNpZ25hbCBpZiBwcm92aWRlZFxuICAgICAgaWYgKHRoaXMuZGVwcy5zaWduYWwpIHtcbiAgICAgICAgcmVzdWx0ID0gKGF3YWl0IHJhY2VBYm9ydChvdXRwdXQsIHRoaXMuZGVwcy5zaWduYWwpKSBhcyBUT3V0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzdWx0ID0gKGF3YWl0IG91dHB1dCkgYXMgVE91dDtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0ID0gb3V0cHV0IGFzIFRPdXQ7XG4gICAgfVxuXG4gICAgLy8gTm90aWZ5IHJlY29yZGVycyBvZiBzdGFnZSBlbmQgKGlmIHNjb3BlIHN1cHBvcnRzIGl0KVxuICAgIGlmIChyYXdTY29wZSAmJiB0eXBlb2YgKHJhd1Njb3BlIGFzIGFueSkubm90aWZ5U3RhZ2VFbmQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIChyYXdTY29wZSBhcyBhbnkpLm5vdGlmeVN0YWdlRW5kKCk7XG4gICAgfVxuXG4gICAgLy8gQ2FsbCBvbkVuZCBsaWZlY3ljbGUgaG9vayBmb3Igc3RyZWFtaW5nIHN0YWdlc1xuICAgIGlmIChub2RlLmlzU3RyZWFtaW5nKSB7XG4gICAgICBjb25zdCBzdHJlYW1JZCA9IG5vZGUuc3RyZWFtSWQgPz8gbm9kZS5uYW1lO1xuICAgICAgdGhpcy5kZXBzLnN0cmVhbUhhbmRsZXJzPy5vbkVuZD8uKHN0cmVhbUlkLCBhY2N1bXVsYXRlZFRleHQpO1xuICAgIH1cblxuICAgIC8vIOKUgOKUgCBQYXVzZSBkZXRlY3Rpb24g4pSA4pSAXG4gICAgLy8gUGF1c2FibGUgc3RhZ2VzOiBhbnkgbm9uLXZvaWQgcmV0dXJuID0gcGF1c2Ugd2l0aCB0aGF0IGRhdGEuXG4gICAgLy8gQWxzbyBzdXBwb3J0cyBleHBsaWNpdCBwYXVzZSh7IC4uLiB9KSBmb3IgYmFja3dhcmQgY29tcGF0LlxuICAgIGlmIChub2RlLmlzUGF1c2FibGUgJiYgcmVzdWx0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHBhdXNlRGF0YSA9IGlzUGF1c2VSZXN1bHQocmVzdWx0KSA/IChyZXN1bHQgYXMgYW55KS5kYXRhIDogcmVzdWx0O1xuICAgICAgLy8gTm90aWZ5IHNjb3BlIHJlY29yZGVycyBiZWZvcmUgdGhyb3dpbmdcbiAgICAgIGlmIChyYXdTY29wZSAmJiB0eXBlb2YgKHJhd1Njb3BlIGFzIGFueSkubm90aWZ5UGF1c2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgKHJhd1Njb3BlIGFzIGFueSkubm90aWZ5UGF1c2Uobm9kZS5pZCwgcGF1c2VEYXRhKTtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBQYXVzZVNpZ25hbChwYXVzZURhdGEsIG5vZGUuaWQpO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbn1cblxuLyoqIFJhY2UgYSBwcm9taXNlIGFnYWluc3QgYW4gQWJvcnRTaWduYWwuIFJlamVjdHMgd2l0aCB0aGUgc2lnbmFsJ3MgcmVhc29uIG9uIGFib3J0LiAqL1xuZnVuY3Rpb24gcmFjZUFib3J0PFQ+KHByb21pc2U6IFByb21pc2U8VD4sIHNpZ25hbDogQWJvcnRTaWduYWwpOiBQcm9taXNlPFQ+IHtcbiAgaWYgKHNpZ25hbC5hYm9ydGVkKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KHNpZ25hbC5yZWFzb24gaW5zdGFuY2VvZiBFcnJvciA/IHNpZ25hbC5yZWFzb24gOiBuZXcgRXJyb3Ioc2lnbmFsLnJlYXNvbiA/PyAnQWJvcnRlZCcpKTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2U8VD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IG9uQWJvcnQgPSAoKSA9PlxuICAgICAgcmVqZWN0KHNpZ25hbC5yZWFzb24gaW5zdGFuY2VvZiBFcnJvciA/IHNpZ25hbC5yZWFzb24gOiBuZXcgRXJyb3Ioc2lnbmFsLnJlYXNvbiA/PyAnQWJvcnRlZCcpKTtcbiAgICBzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgcHJvbWlzZS50aGVuKFxuICAgICAgKHZhbCkgPT4ge1xuICAgICAgICBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbkFib3J0KTtcbiAgICAgICAgcmVzb2x2ZSh2YWwpO1xuICAgICAgfSxcbiAgICAgIChlcnIpID0+IHtcbiAgICAgICAgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0Jywgb25BYm9ydCk7XG4gICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcbn1cbiJdfQ==