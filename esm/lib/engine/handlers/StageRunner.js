/**
 * StageRunner — Executes individual stage functions.
 *
 * Responsibilities:
 * - Create scope via ScopeFactory for each stage
 * - Apply scope protection (createProtectedScope) to intercept direct assignments
 * - Handle streaming stages (onStart, onToken, onEnd lifecycle)
 * - Sync+async safety: only await real Promises (instanceof check)
 */
import { isPauseResult, PauseSignal } from '../../pause/types.js';
import { BREAK_SETTER, IS_TYPED_SCOPE } from '../../reactive/types.js';
import { createProtectedScope } from '../../scope/protection/createProtectedScope.js';
export class StageRunner {
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
        const isTypedScope = rawScope && rawScope[IS_TYPED_SCOPE] === true;
        const scope = isTypedScope
            ? rawScope
            : createProtectedScope(rawScope, {
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
        if (rawScope && typeof rawScope[BREAK_SETTER] === 'function') {
            rawScope[BREAK_SETTER](breakFn);
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
            const pauseData = isPauseResult(result) ? result.data : result;
            // Notify scope recorders before throwing
            if (rawScope && typeof rawScope.notifyPause === 'function') {
                rawScope.notifyPause(node.id, pauseData);
            }
            throw new PauseSignal(pauseData, node.id);
        }
        return result;
    }
}
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3RhZ2VSdW5uZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9TdGFnZVJ1bm5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7R0FRRztBQUdILE9BQU8sRUFBRSxhQUFhLEVBQUUsV0FBVyxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDbEUsT0FBTyxFQUFFLFlBQVksRUFBRSxjQUFjLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUN2RSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxnREFBZ0QsQ0FBQztBQUl0RixNQUFNLE9BQU8sV0FBVztJQUN0QixZQUE2QixJQUErQjtRQUEvQixTQUFJLEdBQUosSUFBSSxDQUEyQjtJQUFHLENBQUM7SUFFaEUsS0FBSyxDQUFDLEdBQUcsQ0FDUCxJQUE2QixFQUM3QixTQUFzQyxFQUN0QyxPQUFxQixFQUNyQixPQUFtQjs7UUFFbkIseUVBQXlFO1FBQ3pFLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFL0csdUVBQXVFO1FBQ3ZFLDJFQUEyRTtRQUMzRSwrQkFBK0I7UUFDL0IsTUFBTSxZQUFZLEdBQUcsUUFBUSxJQUFLLFFBQWdCLENBQUMsY0FBYyxDQUFDLEtBQUssSUFBSSxDQUFDO1FBQzVFLE1BQU0sS0FBSyxHQUFHLFlBQVk7WUFDeEIsQ0FBQyxDQUFDLFFBQVE7WUFDVixDQUFDLENBQUUsb0JBQW9CLENBQUMsUUFBa0IsRUFBRTtnQkFDeEMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CO2dCQUNuQyxTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUk7YUFDckIsQ0FBWSxDQUFDO1FB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LENBQUM7UUFDZCxDQUFDLENBQ0YsQ0FBQztJQUNKLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RhZ2VSdW5uZXIg4oCUIEV4ZWN1dGVzIGluZGl2aWR1YWwgc3RhZ2UgZnVuY3Rpb25zLlxuICpcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAtIENyZWF0ZSBzY29wZSB2aWEgU2NvcGVGYWN0b3J5IGZvciBlYWNoIHN0YWdlXG4gKiAtIEFwcGx5IHNjb3BlIHByb3RlY3Rpb24gKGNyZWF0ZVByb3RlY3RlZFNjb3BlKSB0byBpbnRlcmNlcHQgZGlyZWN0IGFzc2lnbm1lbnRzXG4gKiAtIEhhbmRsZSBzdHJlYW1pbmcgc3RhZ2VzIChvblN0YXJ0LCBvblRva2VuLCBvbkVuZCBsaWZlY3ljbGUpXG4gKiAtIFN5bmMrYXN5bmMgc2FmZXR5OiBvbmx5IGF3YWl0IHJlYWwgUHJvbWlzZXMgKGluc3RhbmNlb2YgY2hlY2spXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB7IGlzUGF1c2VSZXN1bHQsIFBhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHsgQlJFQUtfU0VUVEVSLCBJU19UWVBFRF9TQ09QRSB9IGZyb20gJy4uLy4uL3JlYWN0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB7IGNyZWF0ZVByb3RlY3RlZFNjb3BlIH0gZnJvbSAnLi4vLi4vc2NvcGUvcHJvdGVjdGlvbi9jcmVhdGVQcm90ZWN0ZWRTY29wZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IEhhbmRsZXJEZXBzLCBTdGFnZUZ1bmN0aW9uLCBTdHJlYW1DYWxsYmFjayB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIFN0YWdlUnVubmVyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4pIHt9XG5cbiAgYXN5bmMgcnVuKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHN0YWdlRnVuYzogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBicmVha0ZuOiAoKSA9PiB2b2lkLFxuICApOiBQcm9taXNlPFRPdXQ+IHtcbiAgICAvLyBDcmVhdGUgc2NvcGUgdmlhIFNjb3BlRmFjdG9yeSDigJQgZWFjaCBzdGFnZSBnZXRzIGl0cyBvd24gc2NvcGUgaW5zdGFuY2VcbiAgICBjb25zdCByYXdTY29wZSA9IHRoaXMuZGVwcy5zY29wZUZhY3RvcnkoY29udGV4dCwgbm9kZS5uYW1lLCB0aGlzLmRlcHMucmVhZE9ubHlDb250ZXh0LCB0aGlzLmRlcHMuZXhlY3V0aW9uRW52KTtcblxuICAgIC8vIFdyYXAgc2NvcGUgd2l0aCBwcm90ZWN0aW9uIHRvIGludGVyY2VwdCBkaXJlY3QgcHJvcGVydHkgYXNzaWdubWVudHMuXG4gICAgLy8gU2tpcCBmb3IgVHlwZWRTY29wZSDigJQgaXQgYWxyZWFkeSBoYXMgaXRzIG93biBQcm94eSB3aXRoIHByb3BlciBzZXQgdHJhcHNcbiAgICAvLyB0aGF0IGRlbGVnYXRlIHRvIHNldFZhbHVlKCkuXG4gICAgY29uc3QgaXNUeXBlZFNjb3BlID0gcmF3U2NvcGUgJiYgKHJhd1Njb3BlIGFzIGFueSlbSVNfVFlQRURfU0NPUEVdID09PSB0cnVlO1xuICAgIGNvbnN0IHNjb3BlID0gaXNUeXBlZFNjb3BlXG4gICAgICA/IHJhd1Njb3BlXG4gICAgICA6IChjcmVhdGVQcm90ZWN0ZWRTY29wZShyYXdTY29wZSBhcyBvYmplY3QsIHtcbiAgICAgICAgICBtb2RlOiB0aGlzLmRlcHMuc2NvcGVQcm90ZWN0aW9uTW9kZSxcbiAgICAgICAgICBzdGFnZU5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgfSkgYXMgVFNjb3BlKTtcblxuICAgIC8vIFNldCB1cCBzdHJlYW1pbmcgY2FsbGJhY2sgaWYgdGhpcyBpcyBhIHN0cmVhbWluZyBzdGFnZVxuICAgIGxldCBzdHJlYW1DYWxsYmFjazogU3RyZWFtQ2FsbGJhY2sgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGFjY3VtdWxhdGVkVGV4dCA9ICcnO1xuXG4gICAgaWYgKG5vZGUuaXNTdHJlYW1pbmcpIHtcbiAgICAgIGNvbnN0IHN0cmVhbUlkID0gbm9kZS5zdHJlYW1JZCA/PyBub2RlLm5hbWU7XG4gICAgICBzdHJlYW1DYWxsYmFjayA9ICh0b2tlbjogc3RyaW5nKSA9PiB7XG4gICAgICAgIGFjY3VtdWxhdGVkVGV4dCArPSB0b2tlbjtcbiAgICAgICAgdGhpcy5kZXBzLnN0cmVhbUhhbmRsZXJzPy5vblRva2VuPy4oc3RyZWFtSWQsIHRva2VuKTtcbiAgICAgIH07XG4gICAgICB0aGlzLmRlcHMuc3RyZWFtSGFuZGxlcnM/Lm9uU3RhcnQ/LihzdHJlYW1JZCk7XG4gICAgfVxuXG4gICAgLy8gSW5qZWN0IGJyZWFrUGlwZWxpbmUgaW50byBUeXBlZFNjb3BlIHZpYSBCUkVBS19TRVRURVIgKGlmIHRoZSBzY29wZSBzdXBwb3J0cyBpdClcbiAgICBpZiAocmF3U2NvcGUgJiYgdHlwZW9mIChyYXdTY29wZSBhcyBhbnkpW0JSRUFLX1NFVFRFUl0gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIChyYXdTY29wZSBhcyBhbnkpW0JSRUFLX1NFVFRFUl0oYnJlYWtGbik7XG4gICAgfVxuXG4gICAgLy8gTm90aWZ5IHJlY29yZGVycyBvZiBzdGFnZSBzdGFydCAoaWYgc2NvcGUgc3VwcG9ydHMgaXQpXG4gICAgaWYgKHJhd1Njb3BlICYmIHR5cGVvZiAocmF3U2NvcGUgYXMgYW55KS5ub3RpZnlTdGFnZVN0YXJ0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAocmF3U2NvcGUgYXMgYW55KS5ub3RpZnlTdGFnZVN0YXJ0KCk7XG4gICAgfVxuXG4gICAgLy8gRXhlY3V0ZSB0aGUgc3RhZ2UgZnVuY3Rpb25cbiAgICBjb25zdCBvdXRwdXQgPSBzdGFnZUZ1bmMoc2NvcGUsIGJyZWFrRm4sIHN0cmVhbUNhbGxiYWNrKTtcblxuICAgIC8vIFN5bmMrYXN5bmMgc2FmZXR5OiBvbmx5IGF3YWl0IHJlYWwgUHJvbWlzZXMgdG8gYXZvaWQgdGhlbmFibGUgYXNzaW1pbGF0aW9uXG4gICAgbGV0IHJlc3VsdDogVE91dDtcbiAgICBpZiAob3V0cHV0IGluc3RhbmNlb2YgUHJvbWlzZSkge1xuICAgICAgLy8gUmFjZSBhZ2FpbnN0IEFib3J0U2lnbmFsIGlmIHByb3ZpZGVkXG4gICAgICBpZiAodGhpcy5kZXBzLnNpZ25hbCkge1xuICAgICAgICByZXN1bHQgPSAoYXdhaXQgcmFjZUFib3J0KG91dHB1dCwgdGhpcy5kZXBzLnNpZ25hbCkpIGFzIFRPdXQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN1bHQgPSAoYXdhaXQgb3V0cHV0KSBhcyBUT3V0O1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHQgPSBvdXRwdXQgYXMgVE91dDtcbiAgICB9XG5cbiAgICAvLyBOb3RpZnkgcmVjb3JkZXJzIG9mIHN0YWdlIGVuZCAoaWYgc2NvcGUgc3VwcG9ydHMgaXQpXG4gICAgaWYgKHJhd1Njb3BlICYmIHR5cGVvZiAocmF3U2NvcGUgYXMgYW55KS5ub3RpZnlTdGFnZUVuZCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgKHJhd1Njb3BlIGFzIGFueSkubm90aWZ5U3RhZ2VFbmQoKTtcbiAgICB9XG5cbiAgICAvLyBDYWxsIG9uRW5kIGxpZmVjeWNsZSBob29rIGZvciBzdHJlYW1pbmcgc3RhZ2VzXG4gICAgaWYgKG5vZGUuaXNTdHJlYW1pbmcpIHtcbiAgICAgIGNvbnN0IHN0cmVhbUlkID0gbm9kZS5zdHJlYW1JZCA/PyBub2RlLm5hbWU7XG4gICAgICB0aGlzLmRlcHMuc3RyZWFtSGFuZGxlcnM/Lm9uRW5kPy4oc3RyZWFtSWQsIGFjY3VtdWxhdGVkVGV4dCk7XG4gICAgfVxuXG4gICAgLy8g4pSA4pSAIFBhdXNlIGRldGVjdGlvbiDilIDilIBcbiAgICAvLyBQYXVzYWJsZSBzdGFnZXM6IGFueSBub24tdm9pZCByZXR1cm4gPSBwYXVzZSB3aXRoIHRoYXQgZGF0YS5cbiAgICAvLyBBbHNvIHN1cHBvcnRzIGV4cGxpY2l0IHBhdXNlKHsgLi4uIH0pIGZvciBiYWNrd2FyZCBjb21wYXQuXG4gICAgaWYgKG5vZGUuaXNQYXVzYWJsZSAmJiByZXN1bHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgcGF1c2VEYXRhID0gaXNQYXVzZVJlc3VsdChyZXN1bHQpID8gKHJlc3VsdCBhcyBhbnkpLmRhdGEgOiByZXN1bHQ7XG4gICAgICAvLyBOb3RpZnkgc2NvcGUgcmVjb3JkZXJzIGJlZm9yZSB0aHJvd2luZ1xuICAgICAgaWYgKHJhd1Njb3BlICYmIHR5cGVvZiAocmF3U2NvcGUgYXMgYW55KS5ub3RpZnlQYXVzZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAocmF3U2NvcGUgYXMgYW55KS5ub3RpZnlQYXVzZShub2RlLmlkLCBwYXVzZURhdGEpO1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IFBhdXNlU2lnbmFsKHBhdXNlRGF0YSwgbm9kZS5pZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxufVxuXG4vKiogUmFjZSBhIHByb21pc2UgYWdhaW5zdCBhbiBBYm9ydFNpZ25hbC4gUmVqZWN0cyB3aXRoIHRoZSBzaWduYWwncyByZWFzb24gb24gYWJvcnQuICovXG5mdW5jdGlvbiByYWNlQWJvcnQ8VD4ocHJvbWlzZTogUHJvbWlzZTxUPiwgc2lnbmFsOiBBYm9ydFNpZ25hbCk6IFByb21pc2U8VD4ge1xuICBpZiAoc2lnbmFsLmFib3J0ZWQpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3Qoc2lnbmFsLnJlYXNvbiBpbnN0YW5jZW9mIEVycm9yID8gc2lnbmFsLnJlYXNvbiA6IG5ldyBFcnJvcihzaWduYWwucmVhc29uID8/ICdBYm9ydGVkJykpO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3Qgb25BYm9ydCA9ICgpID0+XG4gICAgICByZWplY3Qoc2lnbmFsLnJlYXNvbiBpbnN0YW5jZW9mIEVycm9yID8gc2lnbmFsLnJlYXNvbiA6IG5ldyBFcnJvcihzaWduYWwucmVhc29uID8/ICdBYm9ydGVkJykpO1xuICAgIHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICBwcm9taXNlLnRoZW4oXG4gICAgICAodmFsKSA9PiB7XG4gICAgICAgIHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uQWJvcnQpO1xuICAgICAgICByZXNvbHZlKHZhbCk7XG4gICAgICB9LFxuICAgICAgKGVycikgPT4ge1xuICAgICAgICBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbkFib3J0KTtcbiAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xufVxuIl19