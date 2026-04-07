/**
 * reactive/createTypedScope -- Core Proxy factory for TypedScope<T>.
 *
 * Wraps a ReactiveTarget (ScopeFacade) in a Proxy that provides:
 * - Typed property access: scope.creditTier (read), scope.creditTier = 'A' (write)
 * - Deep write interception: scope.customer.address.zip = '90210'
 * - Array mutation interception: scope.items.push('new')
 * - $-prefixed escape hatches: $getValue, $setValue, $read, $getArgs, etc.
 *
 * Read semantics: top-level get calls getValue() (fires onRead ONCE).
 *   Nested get traps navigate in-memory -- no additional onRead.
 *
 * Write semantics: top-level set calls setValue(). Nested set calls
 *   updateValue() with a partial object built from the accumulated path.
 */
import { nativeGet as lodashGet } from '../memory/pathOps.js';
import { shouldWrapWithProxy } from './allowlist.js';
import { createArrayProxy } from './arrayTraps.js';
import { buildNestedPatch } from './pathBuilder.js';
import { BREAK_SETTER, EXECUTOR_INTERNAL_METHODS, IS_TYPED_SCOPE, SCOPE_METHOD_NAMES } from './types.js';
// -- Proxy unwrapping --------------------------------------------------------
// structuredClone in TransactionBuffer cannot clone Proxy objects.
// When a user does `scope.backup = scope.customer`, the value is a Proxy.
// Unwrap to a plain object before storing.
function unwrapProxy(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value !== 'object')
        return value;
    // Fast path: plain objects and arrays don't need unwrapping
    try {
        // JSON round-trip strips Proxies. Safe because state values must be JSON-serializable.
        return JSON.parse(JSON.stringify(value));
    }
    catch (_a) {
        // Non-serializable (functions, symbols, etc.) — return as-is
        return value;
    }
}
const METHOD_ROUTES = {
    $getValue: (t) => t.getValue.bind(t),
    $setValue: (t) => t.setValue.bind(t),
    $update: (t) => t.updateValue.bind(t),
    $delete: (t) => t.deleteValue.bind(t),
    $read: (t) => (dotPath) => {
        const rootKey = dotPath.split('.')[0];
        const value = t.getValue(rootKey);
        if (!dotPath.includes('.'))
            return value;
        return lodashGet(value, dotPath.slice(rootKey.length + 1));
    },
    $getArgs: (t) => t.getArgs.bind(t),
    $getEnv: (t) => t.getEnv.bind(t),
    $debug: (t) => t.addDebugInfo.bind(t),
    $log: (t) => t.addDebugMessage.bind(t),
    $error: (t) => t.addErrorInfo.bind(t),
    $metric: (t) => t.addMetric.bind(t),
    $eval: (t) => t.addEval.bind(t),
    $attachRecorder: (t) => t.attachRecorder.bind(t),
    $detachRecorder: (t) => t.detachRecorder.bind(t),
    $getRecorders: (t) => t.getRecorders.bind(t),
    $batchArray: (t) => (key, fn) => {
        // One getValue — fires onRead once
        const current = t.getValue(key);
        // Clone once (or start empty if missing/non-array)
        const clone = Array.isArray(current) ? [...current] : [];
        // User applies all mutations to the plain clone — no Proxy, no per-mutation commit
        fn(clone);
        // One setValue — fires onWrite once with the final array
        t.setValue(key, clone);
    },
    $break: (_t, opts) => () => {
        if (!opts.breakFn)
            throw new Error('$break() is not available outside stage execution');
        opts.breakFn();
    },
    $toRaw: (t) => () => t,
};
// -- Guard properties --------------------------------------------------------
// These must be handled to prevent Proxy from being treated as a Promise,
// breaking instanceof checks, or confusing test matchers.
const GUARD_PROPS = {
    then: undefined, // prevent Promise detection
    asymmetricMatch: undefined, // prevent vitest/jest matcher confusion
    constructor: Object, // safe prototype
    [Symbol.toStringTag]: 'TypedScope',
};
// -- Nested child proxy (for deep write interception) ------------------------
//
// Cycle safety: an immutable Set<object> of ancestor objects is passed down
// each access chain. Each branch gets its own copy (new Set(parent)) so
// scope.x.friend and scope.x.coworker don't pollute each other's tracking.
// When a child value is already in the ancestor set, we've hit a cycle.
// At the cycle break: return a terminal proxy that tracks writes (set trap
// still builds path + calls updateValue) but doesn't recurse reads further.
function createTerminalProxy(obj, rootKey, segments, target, state, visited = new Set()) {
    visited.add(obj);
    return new Proxy(obj, {
        get(raw, prop) {
            if (typeof prop === 'symbol')
                return raw[prop];
            if (prop === 'then')
                return undefined;
            if (prop === 'asymmetricMatch')
                return undefined;
            if (prop === 'constructor')
                return Object;
            if (prop === 'toJSON')
                return () => {
                    // Strip object-typed values to prevent circular JSON errors
                    const safe = {};
                    for (const k of Object.keys(raw)) {
                        const v = raw[k];
                        if (v === null || typeof v !== 'object')
                            safe[k] = v;
                    }
                    return safe;
                };
            const value = raw[prop];
            // Continue tracking writes at deeper levels via chained terminal proxies.
            // Use visited set to prevent re-entering the same object (cycle in terminal chain).
            if (shouldWrapWithProxy(value) && !Array.isArray(value) && !visited.has(value)) {
                return createTerminalProxy(value, rootKey, [...segments, prop], target, state, visited);
            }
            return value;
        },
        set(raw, prop, value) {
            if (typeof prop !== 'string')
                return true;
            const childSegments = [...segments, prop];
            const patch = buildNestedPatch(childSegments, unwrapProxy(value));
            target.updateValue(rootKey, patch);
            state.childCache.delete(rootKey);
            return true;
        },
    });
}
function createNestedProxy(obj, rootKey, segments, target, readSilent, state, ancestors = new Set()) {
    return new Proxy(obj, {
        get(raw, prop) {
            if (typeof prop === 'symbol')
                return raw[prop];
            // Guard properties
            if (prop === 'then')
                return undefined;
            if (prop === 'asymmetricMatch')
                return undefined;
            if (prop === 'constructor')
                return Object;
            if (prop === 'toJSON')
                return () => {
                    // Strip object-typed values to prevent circular JSON errors
                    const safe = {};
                    for (const k of Object.keys(raw)) {
                        const v = raw[k];
                        if (v === null || typeof v !== 'object')
                            safe[k] = v;
                    }
                    return safe;
                };
            const value = raw[prop];
            // Primitive or non-wrappable -- return as-is (no deeper proxy)
            if (!shouldWrapWithProxy(value))
                return value;
            const childSegments = [...segments, prop];
            // Array -- return array proxy
            if (Array.isArray(value)) {
                return createArrayProxy(() => {
                    var _a;
                    const current = readSilent(rootKey);
                    return (_a = lodashGet(current, childSegments.join('.'))) !== null && _a !== void 0 ? _a : [];
                }, (newArr) => {
                    const patch = buildNestedPatch(childSegments, unwrapProxy(newArr));
                    target.updateValue(rootKey, patch);
                    state.childCache.delete(rootKey);
                });
            }
            // Cycle detection: if this value is an ancestor in the current access
            // chain, return a terminal proxy (tracks writes, stops recursing reads).
            if (ancestors.has(value)) {
                return createTerminalProxy(value, rootKey, childSegments, target, state);
            }
            // Build new ancestor set for this branch (immutable -- no cross-branch pollution)
            const childAncestors = new Set(ancestors);
            childAncestors.add(value);
            return createNestedProxy(value, rootKey, childSegments, target, readSilent, state, childAncestors);
        },
        set(raw, prop, value) {
            if (typeof prop !== 'string')
                return true;
            const childSegments = [...segments, prop];
            const patch = buildNestedPatch(childSegments, unwrapProxy(value));
            target.updateValue(rootKey, patch);
            state.childCache.delete(rootKey);
            return true;
        },
    });
}
// -- Top-level proxy (the main TypedScope) -----------------------------------
/**
 * Creates a TypedScope<T> proxy wrapping a ReactiveTarget.
 *
 * @param target - The underlying scope (ScopeFacade or any ReactiveTarget)
 * @param options - Optional configuration (breakPipeline injection)
 * @returns A Proxy with typed property access and $-prefixed methods
 */
export function createTypedScope(target, options) {
    var _a;
    const state = {
        breakFn: options === null || options === void 0 ? void 0 : options.breakPipeline,
        childCache: new Map(),
    };
    // Bind silent-read method once — avoids per-call ?? + .call() in array proxy getCurrent closures
    const readSilent = ((_a = target.getValueSilent) !== null && _a !== void 0 ? _a : target.getValue).bind(target);
    const proxy = new Proxy(target, {
        get(_proxyTarget, prop, _receiver) {
            // 1. Internal symbols (check before other symbols)
            if (prop === IS_TYPED_SCOPE)
                return true;
            if (prop === BREAK_SETTER) {
                return (fn) => {
                    state.breakFn = fn;
                };
            }
            // 2. Symbol properties (guard + inspection)
            if (typeof prop === 'symbol') {
                if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop))
                    return GUARD_PROPS[prop];
                // Node.js util.inspect — show state snapshot, not proxy internals
                if (prop === Symbol.for('nodejs.util.inspect.custom')) {
                    return () => target.getValue();
                }
                return undefined;
            }
            // 3. String guard properties
            if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop))
                return GUARD_PROPS[prop];
            // 4. $-prefixed methods -- route to facade
            if (SCOPE_METHOD_NAMES.has(prop)) {
                const router = METHOD_ROUTES[prop];
                if (router)
                    return router(target, state);
                return undefined;
            }
            // 5. Executor-internal method pass-through (explicit allowlist)
            //    FlowChartExecutor wrapping calls attachRecorder, notifyStageStart, etc.
            //    directly on the scope. Forward only allowlisted methods.
            if (EXECUTOR_INTERNAL_METHODS.has(prop) && typeof target[prop] === 'function') {
                return target[prop].bind(target);
            }
            // 6. State key -- call getValue (fires onRead ONCE)
            const value = target.getValue(prop);
            // Primitive or null/undefined -- return as-is
            if (value === null || value === undefined || typeof value !== 'object') {
                return value;
            }
            // Non-wrappable (Date, Map, class instance, etc.) -- return unwrapped
            if (!shouldWrapWithProxy(value))
                return value;
            // Array -- return array proxy (cached for identity equality)
            if (Array.isArray(value)) {
                const cached = state.childCache.get(prop);
                if (cached && cached.ref === value)
                    return cached.proxy;
                const arrProxy = createArrayProxy(() => { var _a; return (_a = readSilent(prop)) !== null && _a !== void 0 ? _a : []; }, (newArr) => {
                    target.setValue(prop, unwrapProxy(newArr));
                    state.childCache.delete(prop);
                });
                state.childCache.set(prop, { ref: value, proxy: arrProxy });
                return arrProxy;
            }
            // Plain object -- return nested proxy (cached for identity equality)
            const cached = state.childCache.get(prop);
            if (cached && cached.ref === value)
                return cached.proxy;
            const nested = createNestedProxy(value, prop, [], target, readSilent, state, new Set([value]));
            state.childCache.set(prop, { ref: value, proxy: nested });
            return nested;
        },
        set(_proxyTarget, prop, value) {
            if (typeof prop !== 'string')
                return true;
            if (SCOPE_METHOD_NAMES.has(prop)) {
                throw new Error(`Cannot set state key "${prop}" -- it conflicts with a reserved TypedScope method. Rename the state key to avoid $-prefixed names.`);
            }
            // Unwrap Proxy values before storing — structuredClone in TransactionBuffer
            // cannot clone Proxy objects. This handles: scope.backup = scope.customer
            const unwrapped = unwrapProxy(value);
            target.setValue(prop, unwrapped);
            state.childCache.delete(prop); // invalidate cache
            return true;
        },
        deleteProperty(_proxyTarget, prop) {
            if (typeof prop !== 'string')
                return true;
            target.deleteValue(prop);
            state.childCache.delete(prop);
            return true;
        },
        has(_proxyTarget, prop) {
            if (typeof prop === 'symbol')
                return Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop);
            if (SCOPE_METHOD_NAMES.has(prop))
                return true;
            // Use non-tracking hasKey if available, else fallback to getStateKeys
            if (target.hasKey)
                return target.hasKey(prop);
            if (target.getStateKeys)
                return target.getStateKeys().includes(prop);
            // Fallback: getValue fires onRead (acceptable degradation)
            return target.getValue(prop) !== undefined;
        },
        ownKeys() {
            // Use non-tracking getStateKeys if available, else fallback
            if (target.getStateKeys)
                return target.getStateKeys();
            const snapshot = target.getValue();
            if (!snapshot || typeof snapshot !== 'object')
                return [];
            return Object.keys(snapshot);
        },
        getOwnPropertyDescriptor(_proxyTarget, prop) {
            if (typeof prop !== 'string')
                return undefined;
            if (SCOPE_METHOD_NAMES.has(prop))
                return undefined; // $-methods are non-enumerable
            // Check existence without firing onRead — no getValue call here
            const exists = target.hasKey
                ? target.hasKey(prop)
                : target.getStateKeys
                    ? target.getStateKeys().includes(prop)
                    : target.getValue(prop) !== undefined; // fallback only
            if (!exists)
                return undefined;
            // Return a minimal descriptor — actual value is fetched via the get trap
            return { configurable: true, enumerable: true, writable: true };
        },
    });
    return proxy;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlYXRlVHlwZWRTY29wZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcmVhY3RpdmUvY3JlYXRlVHlwZWRTY29wZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUVILE9BQU8sRUFBRSxTQUFTLElBQUksU0FBUyxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDOUQsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDckQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDbkQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFFcEQsT0FBTyxFQUFFLFlBQVksRUFBRSx5QkFBeUIsRUFBRSxjQUFjLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFekcsK0VBQStFO0FBQy9FLG1FQUFtRTtBQUNuRSwwRUFBMEU7QUFDMUUsMkNBQTJDO0FBRTNDLFNBQVMsV0FBVyxDQUFDLEtBQWM7SUFDakMsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDeEQsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDNUMsNERBQTREO0lBQzVELElBQUksQ0FBQztRQUNILHVGQUF1RjtRQUN2RixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQzNDLENBQUM7SUFBQyxXQUFNLENBQUM7UUFDUCw2REFBNkQ7UUFDN0QsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0FBQ0gsQ0FBQztBQU1ELE1BQU0sYUFBYSxHQUFpQztJQUNsRCxTQUFTLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFB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IC0tIENvcmUgUHJveHkgZmFjdG9yeSBmb3IgVHlwZWRTY29wZTxUPi5cbiAqXG4gKiBXcmFwcyBhIFJlYWN0aXZlVGFyZ2V0IChTY29wZUZhY2FkZSkgaW4gYSBQcm94eSB0aGF0IHByb3ZpZGVzOlxuICogLSBUeXBlZCBwcm9wZXJ0eSBhY2Nlc3M6IHNjb3BlLmNyZWRpdFRpZXIgKHJlYWQpLCBzY29wZS5jcmVkaXRUaWVyID0gJ0EnICh3cml0ZSlcbiAqIC0gRGVlcCB3cml0ZSBpbnRlcmNlcHRpb246IHNjb3BlLmN1c3RvbWVyLmFkZHJlc3MuemlwID0gJzkwMjEwJ1xuICogLSBBcnJheSBtdXRhdGlvbiBpbnRlcmNlcHRpb246IHNjb3BlLml0ZW1zLnB1c2goJ25ldycpXG4gKiAtICQtcHJlZml4ZWQgZXNjYXBlIGhhdGNoZXM6ICRnZXRWYWx1ZSwgJHNldFZhbHVlLCAkcmVhZCwgJGdldEFyZ3MsIGV0Yy5cbiAqXG4gKiBSZWFkIHNlbWFudGljczogdG9wLWxldmVsIGdldCBjYWxscyBnZXRWYWx1ZSgpIChmaXJlcyBvblJlYWQgT05DRSkuXG4gKiAgIE5lc3RlZCBnZXQgdHJhcHMgbmF2aWdhdGUgaW4tbWVtb3J5IC0tIG5vIGFkZGl0aW9uYWwgb25SZWFkLlxuICpcbiAqIFdyaXRlIHNlbWFudGljczogdG9wLWxldmVsIHNldCBjYWxscyBzZXRWYWx1ZSgpLiBOZXN0ZWQgc2V0IGNhbGxzXG4gKiAgIHVwZGF0ZVZhbHVlKCkgd2l0aCBhIHBhcnRpYWwgb2JqZWN0IGJ1aWx0IGZyb20gdGhlIGFjY3VtdWxhdGVkIHBhdGguXG4gKi9cblxuaW1wb3J0IHsgbmF0aXZlR2V0IGFzIGxvZGFzaEdldCB9IGZyb20gJy4uL21lbW9yeS9wYXRoT3BzLmpzJztcbmltcG9ydCB7IHNob3VsZFdyYXBXaXRoUHJveHkgfSBmcm9tICcuL2FsbG93bGlzdC5qcyc7XG5pbXBvcnQgeyBjcmVhdGVBcnJheVByb3h5IH0gZnJvbSAnLi9hcnJheVRyYXBzLmpzJztcbmltcG9ydCB7IGJ1aWxkTmVzdGVkUGF0Y2ggfSBmcm9tICcuL3BhdGhCdWlsZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgUmVhY3RpdmVPcHRpb25zLCBSZWFjdGl2ZVRhcmdldCwgVHlwZWRTY29wZSB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHsgQlJFQUtfU0VUVEVSLCBFWEVDVVRPUl9JTlRFUk5BTF9NRVRIT0RTLCBJU19UWVBFRF9TQ09QRSwgU0NPUEVfTUVUSE9EX05BTUVTIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIC0tIFByb3h5IHVud3JhcHBpbmcgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHN0cnVjdHVyZWRDbG9uZSBpbiBUcmFuc2FjdGlvbkJ1ZmZlciBjYW5ub3QgY2xvbmUgUHJveHkgb2JqZWN0cy5cbi8vIFdoZW4gYSB1c2VyIGRvZXMgYHNjb3BlLmJhY2t1cCA9IHNjb3BlLmN1c3RvbWVyYCwgdGhlIHZhbHVlIGlzIGEgUHJveHkuXG4vLyBVbndyYXAgdG8gYSBwbGFpbiBvYmplY3QgYmVmb3JlIHN0b3JpbmcuXG5cbmZ1bmN0aW9uIHVud3JhcFByb3h5KHZhbHVlOiB1bmtub3duKTogdW5rbm93biB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdmFsdWU7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gdmFsdWU7XG4gIC8vIEZhc3QgcGF0aDogcGxhaW4gb2JqZWN0cyBhbmQgYXJyYXlzIGRvbid0IG5lZWQgdW53cmFwcGluZ1xuICB0cnkge1xuICAgIC8vIEpTT04gcm91bmQtdHJpcCBzdHJpcHMgUHJveGllcy4gU2FmZSBiZWNhdXNlIHN0YXRlIHZhbHVlcyBtdXN0IGJlIEpTT04tc2VyaWFsaXphYmxlLlxuICAgIHJldHVybiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1zZXJpYWxpemFibGUgKGZ1bmN0aW9ucywgc3ltYm9scywgZXRjLikg4oCUIHJldHVybiBhcy1pc1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxufVxuXG4vLyAtLSAkLW1ldGhvZCByb3V0aW5nIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnR5cGUgTWV0aG9kUm91dGVyID0gKHRhcmdldDogUmVhY3RpdmVUYXJnZXQsIG9wdHM6IFJlYWN0aXZlU3RhdGUpID0+IHVua25vd247XG5cbmNvbnN0IE1FVEhPRF9ST1VURVM6IFJlY29yZDxzdHJpbmcsIE1ldGhvZFJvdXRlcj4gPSB7XG4gICRnZXRWYWx1ZTogKHQpID0+IHQuZ2V0VmFsdWUuYmluZCh0KSxcbiAgJHNldFZhbHVlOiAodCkgPT4gdC5zZXRWYWx1ZS5iaW5kKHQpLFxuICAkdXBkYXRlOiAodCkgPT4gdC51cGRhdGVWYWx1ZS5iaW5kKHQpLFxuICAkZGVsZXRlOiAodCkgPT4gdC5kZWxldGVWYWx1ZS5iaW5kKHQpLFxuICAkcmVhZDogKHQpID0+IChkb3RQYXRoOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCByb290S2V5ID0gZG90UGF0aC5zcGxpdCgnLicpWzBdO1xuICAgIGNvbnN0IHZhbHVlID0gdC5nZXRWYWx1ZShyb290S2V5KTtcbiAgICBpZiAoIWRvdFBhdGguaW5jbHVkZXMoJy4nKSkgcmV0dXJuIHZhbHVlO1xuICAgIHJldHVybiBsb2Rhc2hHZXQodmFsdWUsIGRvdFBhdGguc2xpY2Uocm9vdEtleS5sZW5ndGggKyAxKSk7XG4gIH0sXG4gICRnZXRBcmdzOiAodCkgPT4gdC5nZXRBcmdzLmJpbmQodCksXG4gICRnZXRFbnY6ICh0KSA9PiB0LmdldEVudi5iaW5kKHQpLFxuICAkZGVidWc6ICh0KSA9PiB0LmFkZERlYnVnSW5mby5iaW5kKHQpLFxuICAkbG9nOiAodCkgPT4gdC5hZGREZWJ1Z01lc3NhZ2UuYmluZCh0KSxcbiAgJGVycm9yOiAodCkgPT4gdC5hZGRFcnJvckluZm8uYmluZCh0KSxcbiAgJG1ldHJpYzogKHQpID0+IHQuYWRkTWV0cmljLmJpbmQodCksXG4gICRldmFsOiAodCkgPT4gdC5hZGRFdmFsLmJpbmQodCksXG4gICRhdHRhY2hSZWNvcmRlcjogKHQpID0+IHQuYXR0YWNoUmVjb3JkZXIuYmluZCh0KSxcbiAgJGRldGFjaFJlY29yZGVyOiAodCkgPT4gdC5kZXRhY2hSZWNvcmRlci5iaW5kKHQpLFxuICAkZ2V0UmVjb3JkZXJzOiAodCkgPT4gdC5nZXRSZWNvcmRlcnMuYmluZCh0KSxcbiAgJGJhdGNoQXJyYXk6ICh0KSA9PiAoa2V5OiBzdHJpbmcsIGZuOiAoYXJyOiB1bmtub3duW10pID0+IHZvaWQpID0+IHtcbiAgICAvLyBPbmUgZ2V0VmFsdWUg4oCUIGZpcmVzIG9uUmVhZCBvbmNlXG4gICAgY29uc3QgY3VycmVudCA9IHQuZ2V0VmFsdWUoa2V5KTtcbiAgICAvLyBDbG9uZSBvbmNlIChvciBzdGFydCBlbXB0eSBpZiBtaXNzaW5nL25vbi1hcnJheSlcbiAgICBjb25zdCBjbG9uZTogdW5rbm93bltdID0gQXJyYXkuaXNBcnJheShjdXJyZW50KSA/IFsuLi5jdXJyZW50XSA6IFtdO1xuICAgIC8vIFVzZXIgYXBwbGllcyBhbGwgbXV0YXRpb25zIHRvIHRoZSBwbGFpbiBjbG9uZSDigJQgbm8gUHJveHksIG5vIHBlci1tdXRhdGlvbiBjb21taXRcbiAgICBmbihjbG9uZSk7XG4gICAgLy8gT25lIHNldFZhbHVlIOKAlCBmaXJlcyBvbldyaXRlIG9uY2Ugd2l0aCB0aGUgZmluYWwgYXJyYXlcbiAgICB0LnNldFZhbHVlKGtleSwgY2xvbmUpO1xuICB9LFxuICAkYnJlYWs6IChfdCwgb3B0cykgPT4gKCkgPT4ge1xuICAgIGlmICghb3B0cy5icmVha0ZuKSB0aHJvdyBuZXcgRXJyb3IoJyRicmVhaygpIGlzIG5vdCBhdmFpbGFibGUgb3V0c2lkZSBzdGFnZSBleGVjdXRpb24nKTtcbiAgICBvcHRzLmJyZWFrRm4oKTtcbiAgfSxcbiAgJHRvUmF3OiAodCkgPT4gKCkgPT4gdCxcbn07XG5cbi8vIC0tIEd1YXJkIHByb3BlcnRpZXMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZXNlIG11c3QgYmUgaGFuZGxlZCB0byBwcmV2ZW50IFByb3h5IGZyb20gYmVpbmcgdHJlYXRlZCBhcyBhIFByb21pc2UsXG4vLyBicmVha2luZyBpbnN0YW5jZW9mIGNoZWNrcywgb3IgY29uZnVzaW5nIHRlc3QgbWF0Y2hlcnMuXG5cbmNvbnN0IEdVQVJEX1BST1BTOiBSZWNvcmQ8c3RyaW5nIHwgc3ltYm9sLCB1bmtub3duPiA9IHtcbiAgdGhlbjogdW5kZWZpbmVkLCAvLyBwcmV2ZW50IFByb21pc2UgZGV0ZWN0aW9uXG4gIGFzeW1tZXRyaWNNYXRjaDogdW5kZWZpbmVkLCAvLyBwcmV2ZW50IHZpdGVzdC9qZXN0IG1hdGNoZXIgY29uZnVzaW9uXG4gIGNvbnN0cnVjdG9yOiBPYmplY3QsIC8vIHNhZmUgcHJvdG90eXBlXG4gIFtTeW1ib2wudG9TdHJpbmdUYWddOiAnVHlwZWRTY29wZScsXG59O1xuXG4vLyAtLSBNdXRhYmxlIHN0YXRlIHBlciBwcm94eSBpbnN0YW5jZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBSZWFjdGl2ZVN0YXRlIHtcbiAgYnJlYWtGbj86ICgpID0+IHZvaWQ7XG4gIC8qKiBDYWNoZTogdG9wLWxldmVsIGtleSAtPiB7IHJhdyBvYmplY3QgcmVmLCBjaGlsZCBwcm94eSB9ICovXG4gIGNoaWxkQ2FjaGU6IE1hcDxzdHJpbmcsIHsgcmVmOiBvYmplY3Q7IHByb3h5OiBvYmplY3QgfT47XG59XG5cbi8vIC0tIE5lc3RlZCBjaGlsZCBwcm94eSAoZm9yIGRlZXAgd3JpdGUgaW50ZXJjZXB0aW9uKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vXG4vLyBDeWNsZSBzYWZldHk6IGFuIGltbXV0YWJsZSBTZXQ8b2JqZWN0PiBvZiBhbmNlc3RvciBvYmplY3RzIGlzIHBhc3NlZCBkb3duXG4vLyBlYWNoIGFjY2VzcyBjaGFpbi4gRWFjaCBicmFuY2ggZ2V0cyBpdHMgb3duIGNvcHkgKG5ldyBTZXQocGFyZW50KSkgc29cbi8vIHNjb3BlLnguZnJpZW5kIGFuZCBzY29wZS54LmNvd29ya2VyIGRvbid0IHBvbGx1dGUgZWFjaCBvdGhlcidzIHRyYWNraW5nLlxuLy8gV2hlbiBhIGNoaWxkIHZhbHVlIGlzIGFscmVhZHkgaW4gdGhlIGFuY2VzdG9yIHNldCwgd2UndmUgaGl0IGEgY3ljbGUuXG4vLyBBdCB0aGUgY3ljbGUgYnJlYWs6IHJldHVybiBhIHRlcm1pbmFsIHByb3h5IHRoYXQgdHJhY2tzIHdyaXRlcyAoc2V0IHRyYXBcbi8vIHN0aWxsIGJ1aWxkcyBwYXRoICsgY2FsbHMgdXBkYXRlVmFsdWUpIGJ1dCBkb2Vzbid0IHJlY3Vyc2UgcmVhZHMgZnVydGhlci5cblxuZnVuY3Rpb24gY3JlYXRlVGVybWluYWxQcm94eShcbiAgb2JqOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgcm9vdEtleTogc3RyaW5nLFxuICBzZWdtZW50czogc3RyaW5nW10sXG4gIHRhcmdldDogUmVhY3RpdmVUYXJnZXQsXG4gIHN0YXRlOiBSZWFjdGl2ZVN0YXRlLFxuICB2aXNpdGVkOiBTZXQ8b2JqZWN0PiA9IG5ldyBTZXQoKSxcbik6IHVua25vd24ge1xuICB2aXNpdGVkLmFkZChvYmopO1xuXG4gIHJldHVybiBuZXcgUHJveHkob2JqLCB7XG4gICAgZ2V0KHJhdywgcHJvcCkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wID09PSAnc3ltYm9sJykgcmV0dXJuIChyYXcgYXMgYW55KVtwcm9wXTtcbiAgICAgIGlmIChwcm9wID09PSAndGhlbicpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2FzeW1tZXRyaWNNYXRjaCcpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2NvbnN0cnVjdG9yJykgcmV0dXJuIE9iamVjdDtcbiAgICAgIGlmIChwcm9wID09PSAndG9KU09OJylcbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAvLyBTdHJpcCBvYmplY3QtdHlwZWQgdmFsdWVzIHRvIHByZXZlbnQgY2lyY3VsYXIgSlNPTiBlcnJvcnNcbiAgICAgICAgICBjb25zdCBzYWZlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhyYXcpKSB7XG4gICAgICAgICAgICBjb25zdCB2ID0gKHJhdyBhcyBhbnkpW2tdO1xuICAgICAgICAgICAgaWYgKHYgPT09IG51bGwgfHwgdHlwZW9mIHYgIT09ICdvYmplY3QnKSBzYWZlW2tdID0gdjtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHNhZmU7XG4gICAgICAgIH07XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gKHJhdyBhcyBhbnkpW3Byb3BdO1xuXG4gICAgICAvLyBDb250aW51ZSB0cmFja2luZyB3cml0ZXMgYXQgZGVlcGVyIGxldmVscyB2aWEgY2hhaW5lZCB0ZXJtaW5hbCBwcm94aWVzLlxuICAgICAgLy8gVXNlIHZpc2l0ZWQgc2V0IHRvIHByZXZlbnQgcmUtZW50ZXJpbmcgdGhlIHNhbWUgb2JqZWN0IChjeWNsZSBpbiB0ZXJtaW5hbCBjaGFpbikuXG4gICAgICBpZiAoc2hvdWxkV3JhcFdpdGhQcm94eSh2YWx1ZSkgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpICYmICF2aXNpdGVkLmhhcyh2YWx1ZSBhcyBvYmplY3QpKSB7XG4gICAgICAgIHJldHVybiBjcmVhdGVUZXJtaW5hbFByb3h5KFxuICAgICAgICAgIHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICAgIHJvb3RLZXksXG4gICAgICAgICAgWy4uLnNlZ21lbnRzLCBwcm9wIGFzIHN0cmluZ10sXG4gICAgICAgICAgdGFyZ2V0LFxuICAgICAgICAgIHN0YXRlLFxuICAgICAgICAgIHZpc2l0ZWQsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9LFxuICAgIHNldChyYXcsIHByb3AsIHZhbHVlKSB7XG4gICAgICBpZiAodHlwZW9mIHByb3AgIT09ICdzdHJpbmcnKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGNvbnN0IGNoaWxkU2VnbWVudHMgPSBbLi4uc2VnbWVudHMsIHByb3BdO1xuICAgICAgY29uc3QgcGF0Y2ggPSBidWlsZE5lc3RlZFBhdGNoKGNoaWxkU2VnbWVudHMsIHVud3JhcFByb3h5KHZhbHVlKSk7XG4gICAgICB0YXJnZXQudXBkYXRlVmFsdWUocm9vdEtleSwgcGF0Y2gpO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocm9vdEtleSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTmVzdGVkUHJveHkoXG4gIG9iajogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIHJvb3RLZXk6IHN0cmluZyxcbiAgc2VnbWVudHM6IHN0cmluZ1tdLFxuICB0YXJnZXQ6IFJlYWN0aXZlVGFyZ2V0LFxuICByZWFkU2lsZW50OiAoa2V5Pzogc3RyaW5nKSA9PiB1bmtub3duLFxuICBzdGF0ZTogUmVhY3RpdmVTdGF0ZSxcbiAgYW5jZXN0b3JzOiBTZXQ8b2JqZWN0PiA9IG5ldyBTZXQoKSxcbik6IHVua25vd24ge1xuICByZXR1cm4gbmV3IFByb3h5KG9iaiwge1xuICAgIGdldChyYXcsIHByb3ApIHtcbiAgICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ3N5bWJvbCcpIHJldHVybiAocmF3IGFzIGFueSlbcHJvcF07XG5cbiAgICAgIC8vIEd1YXJkIHByb3BlcnRpZXNcbiAgICAgIGlmIChwcm9wID09PSAndGhlbicpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2FzeW1tZXRyaWNNYXRjaCcpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBpZiAocHJvcCA9PT0gJ2NvbnN0cnVjdG9yJykgcmV0dXJuIE9iamVjdDtcbiAgICAgIGlmIChwcm9wID09PSAndG9KU09OJylcbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAvLyBTdHJpcCBvYmplY3QtdHlwZWQgdmFsdWVzIHRvIHByZXZlbnQgY2lyY3VsYXIgSlNPTiBlcnJvcnNcbiAgICAgICAgICBjb25zdCBzYWZlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhyYXcpKSB7XG4gICAgICAgICAgICBjb25zdCB2ID0gKHJhdyBhcyBhbnkpW2tdO1xuICAgICAgICAgICAgaWYgKHYgPT09IG51bGwgfHwgdHlwZW9mIHYgIT09ICdvYmplY3QnKSBzYWZlW2tdID0gdjtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHNhZmU7XG4gICAgICAgIH07XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gKHJhdyBhcyBhbnkpW3Byb3BdO1xuXG4gICAgICAvLyBQcmltaXRpdmUgb3Igbm9uLXdyYXBwYWJsZSAtLSByZXR1cm4gYXMtaXMgKG5vIGRlZXBlciBwcm94eSlcbiAgICAgIGlmICghc2hvdWxkV3JhcFdpdGhQcm94eSh2YWx1ZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgY29uc3QgY2hpbGRTZWdtZW50cyA9IFsuLi5zZWdtZW50cywgcHJvcCBhcyBzdHJpbmddO1xuXG4gICAgICAvLyBBcnJheSAtLSByZXR1cm4gYXJyYXkgcHJveHlcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gY3JlYXRlQXJyYXlQcm94eShcbiAgICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gcmVhZFNpbGVudChyb290S2V5KSBhcyBhbnk7XG4gICAgICAgICAgICByZXR1cm4gbG9kYXNoR2V0KGN1cnJlbnQsIGNoaWxkU2VnbWVudHMuam9pbignLicpKSA/PyBbXTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIChuZXdBcnIpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHBhdGNoID0gYnVpbGROZXN0ZWRQYXRjaChjaGlsZFNlZ21lbnRzLCB1bndyYXBQcm94eShuZXdBcnIpKTtcbiAgICAgICAgICAgIHRhcmdldC51cGRhdGVWYWx1ZShyb290S2V5LCBwYXRjaCk7XG4gICAgICAgICAgICBzdGF0ZS5jaGlsZENhY2hlLmRlbGV0ZShyb290S2V5KTtcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBDeWNsZSBkZXRlY3Rpb246IGlmIHRoaXMgdmFsdWUgaXMgYW4gYW5jZXN0b3IgaW4gdGhlIGN1cnJlbnQgYWNjZXNzXG4gICAgICAvLyBjaGFpbiwgcmV0dXJuIGEgdGVybWluYWwgcHJveHkgKHRyYWNrcyB3cml0ZXMsIHN0b3BzIHJlY3Vyc2luZyByZWFkcykuXG4gICAgICBpZiAoYW5jZXN0b3JzLmhhcyh2YWx1ZSBhcyBvYmplY3QpKSB7XG4gICAgICAgIHJldHVybiBjcmVhdGVUZXJtaW5hbFByb3h5KHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCByb290S2V5LCBjaGlsZFNlZ21lbnRzLCB0YXJnZXQsIHN0YXRlKTtcbiAgICAgIH1cblxuICAgICAgLy8gQnVpbGQgbmV3IGFuY2VzdG9yIHNldCBmb3IgdGhpcyBicmFuY2ggKGltbXV0YWJsZSAtLSBubyBjcm9zcy1icmFuY2ggcG9sbHV0aW9uKVxuICAgICAgY29uc3QgY2hpbGRBbmNlc3RvcnMgPSBuZXcgU2V0KGFuY2VzdG9ycyk7XG4gICAgICBjaGlsZEFuY2VzdG9ycy5hZGQodmFsdWUgYXMgb2JqZWN0KTtcblxuICAgICAgcmV0dXJuIGNyZWF0ZU5lc3RlZFByb3h5KFxuICAgICAgICB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgICAgcm9vdEtleSxcbiAgICAgICAgY2hpbGRTZWdtZW50cyxcbiAgICAgICAgdGFyZ2V0LFxuICAgICAgICByZWFkU2lsZW50LFxuICAgICAgICBzdGF0ZSxcbiAgICAgICAgY2hpbGRBbmNlc3RvcnMsXG4gICAgICApO1xuICAgIH0sXG5cbiAgICBzZXQocmF3LCBwcm9wLCB2YWx1ZSkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wICE9PSAnc3RyaW5nJykgcmV0dXJuIHRydWU7XG5cbiAgICAgIGNvbnN0IGNoaWxkU2VnbWVudHMgPSBbLi4uc2VnbWVudHMsIHByb3BdO1xuICAgICAgY29uc3QgcGF0Y2ggPSBidWlsZE5lc3RlZFBhdGNoKGNoaWxkU2VnbWVudHMsIHVud3JhcFByb3h5KHZhbHVlKSk7XG4gICAgICB0YXJnZXQudXBkYXRlVmFsdWUocm9vdEtleSwgcGF0Y2gpO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocm9vdEtleSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICB9KTtcbn1cblxuLy8gLS0gVG9wLWxldmVsIHByb3h5ICh0aGUgbWFpbiBUeXBlZFNjb3BlKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIENyZWF0ZXMgYSBUeXBlZFNjb3BlPFQ+IHByb3h5IHdyYXBwaW5nIGEgUmVhY3RpdmVUYXJnZXQuXG4gKlxuICogQHBhcmFtIHRhcmdldCAtIFRoZSB1bmRlcmx5aW5nIHNjb3BlIChTY29wZUZhY2FkZSBvciBhbnkgUmVhY3RpdmVUYXJnZXQpXG4gKiBAcGFyYW0gb3B0aW9ucyAtIE9wdGlvbmFsIGNvbmZpZ3VyYXRpb24gKGJyZWFrUGlwZWxpbmUgaW5qZWN0aW9uKVxuICogQHJldHVybnMgQSBQcm94eSB3aXRoIHR5cGVkIHByb3BlcnR5IGFjY2VzcyBhbmQgJC1wcmVmaXhlZCBtZXRob2RzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVUeXBlZFNjb3BlPFQgZXh0ZW5kcyBvYmplY3Q+KHRhcmdldDogUmVhY3RpdmVUYXJnZXQsIG9wdGlvbnM/OiBSZWFjdGl2ZU9wdGlvbnMpOiBUeXBlZFNjb3BlPFQ+IHtcbiAgY29uc3Qgc3RhdGU6IFJlYWN0aXZlU3RhdGUgPSB7XG4gICAgYnJlYWtGbjogb3B0aW9ucz8uYnJlYWtQaXBlbGluZSxcbiAgICBjaGlsZENhY2hlOiBuZXcgTWFwKCksXG4gIH07XG5cbiAgLy8gQmluZCBzaWxlbnQtcmVhZCBtZXRob2Qgb25jZSDigJQgYXZvaWRzIHBlci1jYWxsID8/ICsgLmNhbGwoKSBpbiBhcnJheSBwcm94eSBnZXRDdXJyZW50IGNsb3N1cmVzXG4gIGNvbnN0IHJlYWRTaWxlbnQgPSAodGFyZ2V0LmdldFZhbHVlU2lsZW50ID8/IHRhcmdldC5nZXRWYWx1ZSkuYmluZCh0YXJnZXQpO1xuXG4gIGNvbnN0IHByb3h5ID0gbmV3IFByb3h5KHRhcmdldCBhcyB1bmtub3duIGFzIFR5cGVkU2NvcGU8VD4sIHtcbiAgICBnZXQoX3Byb3h5VGFyZ2V0LCBwcm9wLCBfcmVjZWl2ZXIpIHtcbiAgICAgIC8vIDEuIEludGVybmFsIHN5bWJvbHMgKGNoZWNrIGJlZm9yZSBvdGhlciBzeW1ib2xzKVxuICAgICAgaWYgKHByb3AgPT09IElTX1RZUEVEX1NDT1BFKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChwcm9wID09PSBCUkVBS19TRVRURVIpIHtcbiAgICAgICAgcmV0dXJuIChmbjogKCkgPT4gdm9pZCkgPT4ge1xuICAgICAgICAgIHN0YXRlLmJyZWFrRm4gPSBmbjtcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gMi4gU3ltYm9sIHByb3BlcnRpZXMgKGd1YXJkICsgaW5zcGVjdGlvbilcbiAgICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ3N5bWJvbCcpIHtcbiAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChHVUFSRF9QUk9QUywgcHJvcCkpIHJldHVybiBHVUFSRF9QUk9QU1twcm9wXTtcbiAgICAgICAgLy8gTm9kZS5qcyB1dGlsLmluc3BlY3Qg4oCUIHNob3cgc3RhdGUgc25hcHNob3QsIG5vdCBwcm94eSBpbnRlcm5hbHNcbiAgICAgICAgaWYgKHByb3AgPT09IFN5bWJvbC5mb3IoJ25vZGVqcy51dGlsLmluc3BlY3QuY3VzdG9tJykpIHtcbiAgICAgICAgICByZXR1cm4gKCkgPT4gdGFyZ2V0LmdldFZhbHVlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgLy8gMy4gU3RyaW5nIGd1YXJkIHByb3BlcnRpZXNcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoR1VBUkRfUFJPUFMsIHByb3ApKSByZXR1cm4gR1VBUkRfUFJPUFNbcHJvcF07XG5cbiAgICAgIC8vIDQuICQtcHJlZml4ZWQgbWV0aG9kcyAtLSByb3V0ZSB0byBmYWNhZGVcbiAgICAgIGlmIChTQ09QRV9NRVRIT0RfTkFNRVMuaGFzKHByb3ApKSB7XG4gICAgICAgIGNvbnN0IHJvdXRlciA9IE1FVEhPRF9ST1VURVNbcHJvcF07XG4gICAgICAgIGlmIChyb3V0ZXIpIHJldHVybiByb3V0ZXIodGFyZ2V0LCBzdGF0ZSk7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIDUuIEV4ZWN1dG9yLWludGVybmFsIG1ldGhvZCBwYXNzLXRocm91Z2ggKGV4cGxpY2l0IGFsbG93bGlzdClcbiAgICAgIC8vICAgIEZsb3dDaGFydEV4ZWN1dG9yIHdyYXBwaW5nIGNhbGxzIGF0dGFjaFJlY29yZGVyLCBub3RpZnlTdGFnZVN0YXJ0LCBldGMuXG4gICAgICAvLyAgICBkaXJlY3RseSBvbiB0aGUgc2NvcGUuIEZvcndhcmQgb25seSBhbGxvd2xpc3RlZCBtZXRob2RzLlxuICAgICAgaWYgKEVYRUNVVE9SX0lOVEVSTkFMX01FVEhPRFMuaGFzKHByb3ApICYmIHR5cGVvZiAodGFyZ2V0IGFzIGFueSlbcHJvcF0gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgcmV0dXJuICh0YXJnZXQgYXMgYW55KVtwcm9wXS5iaW5kKHRhcmdldCk7XG4gICAgICB9XG5cbiAgICAgIC8vIDYuIFN0YXRlIGtleSAtLSBjYWxsIGdldFZhbHVlIChmaXJlcyBvblJlYWQgT05DRSlcbiAgICAgIGNvbnN0IHZhbHVlID0gdGFyZ2V0LmdldFZhbHVlKHByb3ApO1xuXG4gICAgICAvLyBQcmltaXRpdmUgb3IgbnVsbC91bmRlZmluZWQgLS0gcmV0dXJuIGFzLWlzXG4gICAgICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgLy8gTm9uLXdyYXBwYWJsZSAoRGF0ZSwgTWFwLCBjbGFzcyBpbnN0YW5jZSwgZXRjLikgLS0gcmV0dXJuIHVud3JhcHBlZFxuICAgICAgaWYgKCFzaG91bGRXcmFwV2l0aFByb3h5KHZhbHVlKSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAvLyBBcnJheSAtLSByZXR1cm4gYXJyYXkgcHJveHkgKGNhY2hlZCBmb3IgaWRlbnRpdHkgZXF1YWxpdHkpXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgY29uc3QgY2FjaGVkID0gc3RhdGUuY2hpbGRDYWNoZS5nZXQocHJvcCk7XG4gICAgICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLnJlZiA9PT0gdmFsdWUpIHJldHVybiBjYWNoZWQucHJveHk7XG5cbiAgICAgICAgY29uc3QgYXJyUHJveHkgPSBjcmVhdGVBcnJheVByb3h5KFxuICAgICAgICAgICgpID0+IChyZWFkU2lsZW50KHByb3ApIGFzIHVua25vd25bXSkgPz8gW10sXG4gICAgICAgICAgKG5ld0FycikgPT4ge1xuICAgICAgICAgICAgdGFyZ2V0LnNldFZhbHVlKHByb3AsIHVud3JhcFByb3h5KG5ld0FycikpO1xuICAgICAgICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocHJvcCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICAgICAgc3RhdGUuY2hpbGRDYWNoZS5zZXQocHJvcCwgeyByZWY6IHZhbHVlIGFzIG9iamVjdCwgcHJveHk6IGFyclByb3h5IGFzIHVua25vd24gYXMgb2JqZWN0IH0pO1xuICAgICAgICByZXR1cm4gYXJyUHJveHk7XG4gICAgICB9XG5cbiAgICAgIC8vIFBsYWluIG9iamVjdCAtLSByZXR1cm4gbmVzdGVkIHByb3h5IChjYWNoZWQgZm9yIGlkZW50aXR5IGVxdWFsaXR5KVxuICAgICAgY29uc3QgY2FjaGVkID0gc3RhdGUuY2hpbGRDYWNoZS5nZXQocHJvcCk7XG4gICAgICBpZiAoY2FjaGVkICYmIGNhY2hlZC5yZWYgPT09IHZhbHVlKSByZXR1cm4gY2FjaGVkLnByb3h5O1xuXG4gICAgICBjb25zdCBuZXN0ZWQgPSBjcmVhdGVOZXN0ZWRQcm94eShcbiAgICAgICAgdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgIHByb3AsXG4gICAgICAgIFtdLFxuICAgICAgICB0YXJnZXQsXG4gICAgICAgIHJlYWRTaWxlbnQsXG4gICAgICAgIHN0YXRlLFxuICAgICAgICBuZXcgU2V0PG9iamVjdD4oW3ZhbHVlIGFzIG9iamVjdF0pLCAvLyBzZWVkIGFuY2VzdG9yIHNldCB3aXRoIHJvb3Qgb2JqZWN0XG4gICAgICApO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5zZXQocHJvcCwgeyByZWY6IHZhbHVlIGFzIG9iamVjdCwgcHJveHk6IG5lc3RlZCBhcyBvYmplY3QgfSk7XG4gICAgICByZXR1cm4gbmVzdGVkO1xuICAgIH0sXG5cbiAgICBzZXQoX3Byb3h5VGFyZ2V0LCBwcm9wLCB2YWx1ZSkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wICE9PSAnc3RyaW5nJykgcmV0dXJuIHRydWU7XG4gICAgICBpZiAoU0NPUEVfTUVUSE9EX05BTUVTLmhhcyhwcm9wKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYENhbm5vdCBzZXQgc3RhdGUga2V5IFwiJHtwcm9wfVwiIC0tIGl0IGNvbmZsaWN0cyB3aXRoIGEgcmVzZXJ2ZWQgVHlwZWRTY29wZSBtZXRob2QuIFJlbmFtZSB0aGUgc3RhdGUga2V5IHRvIGF2b2lkICQtcHJlZml4ZWQgbmFtZXMuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIFVud3JhcCBQcm94eSB2YWx1ZXMgYmVmb3JlIHN0b3Jpbmcg4oCUIHN0cnVjdHVyZWRDbG9uZSBpbiBUcmFuc2FjdGlvbkJ1ZmZlclxuICAgICAgLy8gY2Fubm90IGNsb25lIFByb3h5IG9iamVjdHMuIFRoaXMgaGFuZGxlczogc2NvcGUuYmFja3VwID0gc2NvcGUuY3VzdG9tZXJcbiAgICAgIGNvbnN0IHVud3JhcHBlZCA9IHVud3JhcFByb3h5KHZhbHVlKTtcbiAgICAgIHRhcmdldC5zZXRWYWx1ZShwcm9wLCB1bndyYXBwZWQpO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocHJvcCk7IC8vIGludmFsaWRhdGUgY2FjaGVcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG5cbiAgICBkZWxldGVQcm9wZXJ0eShfcHJveHlUYXJnZXQsIHByb3ApIHtcbiAgICAgIGlmICh0eXBlb2YgcHJvcCAhPT0gJ3N0cmluZycpIHJldHVybiB0cnVlO1xuICAgICAgdGFyZ2V0LmRlbGV0ZVZhbHVlKHByb3ApO1xuICAgICAgc3RhdGUuY2hpbGRDYWNoZS5kZWxldGUocHJvcCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuXG4gICAgaGFzKF9wcm94eVRhcmdldCwgcHJvcCkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wID09PSAnc3ltYm9sJykgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChHVUFSRF9QUk9QUywgcHJvcCk7XG4gICAgICBpZiAoU0NPUEVfTUVUSE9EX05BTUVTLmhhcyhwcm9wKSkgcmV0dXJuIHRydWU7XG4gICAgICAvLyBVc2Ugbm9uLXRyYWNraW5nIGhhc0tleSBpZiBhdmFpbGFibGUsIGVsc2UgZmFsbGJhY2sgdG8gZ2V0U3RhdGVLZXlzXG4gICAgICBpZiAodGFyZ2V0Lmhhc0tleSkgcmV0dXJuIHRhcmdldC5oYXNLZXkocHJvcCk7XG4gICAgICBpZiAodGFyZ2V0LmdldFN0YXRlS2V5cykgcmV0dXJuIHRhcmdldC5nZXRTdGF0ZUtleXMoKS5pbmNsdWRlcyhwcm9wKTtcbiAgICAgIC8vIEZhbGxiYWNrOiBnZXRWYWx1ZSBmaXJlcyBvblJlYWQgKGFjY2VwdGFibGUgZGVncmFkYXRpb24pXG4gICAgICByZXR1cm4gdGFyZ2V0LmdldFZhbHVlKHByb3ApICE9PSB1bmRlZmluZWQ7XG4gICAgfSxcblxuICAgIG93bktleXMoKSB7XG4gICAgICAvLyBVc2Ugbm9uLXRyYWNraW5nIGdldFN0YXRlS2V5cyBpZiBhdmFpbGFibGUsIGVsc2UgZmFsbGJhY2tcbiAgICAgIGlmICh0YXJnZXQuZ2V0U3RhdGVLZXlzKSByZXR1cm4gdGFyZ2V0LmdldFN0YXRlS2V5cygpO1xuICAgICAgY29uc3Qgc25hcHNob3QgPSB0YXJnZXQuZ2V0VmFsdWUoKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICghc25hcHNob3QgfHwgdHlwZW9mIHNuYXBzaG90ICE9PSAnb2JqZWN0JykgcmV0dXJuIFtdO1xuICAgICAgcmV0dXJuIE9iamVjdC5rZXlzKHNuYXBzaG90KTtcbiAgICB9LFxuXG4gICAgZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKF9wcm94eVRhcmdldCwgcHJvcCkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wICE9PSAnc3RyaW5nJykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIGlmIChTQ09QRV9NRVRIT0RfTkFNRVMuaGFzKHByb3ApKSByZXR1cm4gdW5kZWZpbmVkOyAvLyAkLW1ldGhvZHMgYXJlIG5vbi1lbnVtZXJhYmxlXG4gICAgICAvLyBDaGVjayBleGlzdGVuY2Ugd2l0aG91dCBmaXJpbmcgb25SZWFkIOKAlCBubyBnZXRWYWx1ZSBjYWxsIGhlcmVcbiAgICAgIGNvbnN0IGV4aXN0cyA9IHRhcmdldC5oYXNLZXlcbiAgICAgICAgPyB0YXJnZXQuaGFzS2V5KHByb3ApXG4gICAgICAgIDogdGFyZ2V0LmdldFN0YXRlS2V5c1xuICAgICAgICA/IHRhcmdldC5nZXRTdGF0ZUtleXMoKS5pbmNsdWRlcyhwcm9wKVxuICAgICAgICA6IHRhcmdldC5nZXRWYWx1ZShwcm9wKSAhPT0gdW5kZWZpbmVkOyAvLyBmYWxsYmFjayBvbmx5XG4gICAgICBpZiAoIWV4aXN0cykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIC8vIFJldHVybiBhIG1pbmltYWwgZGVzY3JpcHRvciDigJQgYWN0dWFsIHZhbHVlIGlzIGZldGNoZWQgdmlhIHRoZSBnZXQgdHJhcFxuICAgICAgcmV0dXJuIHsgY29uZmlndXJhYmxlOiB0cnVlLCBlbnVtZXJhYmxlOiB0cnVlLCB3cml0YWJsZTogdHJ1ZSB9O1xuICAgIH0sXG4gIH0pO1xuXG4gIHJldHVybiBwcm94eTtcbn1cbiJdfQ==