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
import type { ReactiveOptions, ReactiveTarget, TypedScope } from './types.js';
import { BREAK_SETTER, EXECUTOR_INTERNAL_METHODS, IS_TYPED_SCOPE, SCOPE_METHOD_NAMES } from './types.js';

// -- Proxy unwrapping --------------------------------------------------------
// structuredClone in TransactionBuffer cannot clone Proxy objects.
// When a user does `scope.backup = scope.customer`, the value is a Proxy.
// Unwrap to a plain object before storing.

function unwrapProxy(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  // Fast path: plain objects and arrays don't need unwrapping
  try {
    // JSON round-trip strips Proxies. Safe because state values must be JSON-serializable.
    return JSON.parse(JSON.stringify(value));
  } catch {
    // Non-serializable (functions, symbols, etc.) — return as-is
    return value;
  }
}

// -- $-method routing --------------------------------------------------------

type MethodRouter = (target: ReactiveTarget, opts: ReactiveState) => unknown;

const METHOD_ROUTES: Record<string, MethodRouter> = {
  $getValue: (t) => t.getValue.bind(t),
  $setValue: (t) => t.setValue.bind(t),
  $update: (t) => t.updateValue.bind(t),
  $delete: (t) => t.deleteValue.bind(t),
  $read: (t) => (dotPath: string) => {
    const rootKey = dotPath.split('.')[0];
    const value = t.getValue(rootKey);
    if (!dotPath.includes('.')) return value;
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
  $batchArray: (t) => (key: string, fn: (arr: unknown[]) => void) => {
    // One getValue — fires onRead once
    const current = t.getValue(key);
    // Clone once (or start empty if missing/non-array)
    const clone: unknown[] = Array.isArray(current) ? [...current] : [];
    // User applies all mutations to the plain clone — no Proxy, no per-mutation commit
    fn(clone);
    // One setValue — fires onWrite once with the final array
    t.setValue(key, clone);
  },
  $break: (_t, opts) => (reason?: string) => {
    if (!opts.breakFn) throw new Error('$break() is not available outside stage execution');
    opts.breakFn(reason);
  },
  // Observability — Emit channel (Phase 3). Routes to ScopeFacade.emitEvent
  // which handles fast-path, enrichment, redaction, and error isolation.
  $emit: (t) => t.emitEvent.bind(t),
  // Detach (T4) — fire-and-forget child flowcharts. Delegates to ScopeFacade
  // which minted refIds from runtimeStageId.
  $detachAndJoinLater: (t) => t.detachAndJoinLater.bind(t),
  $detachAndForget: (t) => t.detachAndForget.bind(t),
  $toRaw: (t) => () => t,
};

// -- Guard properties --------------------------------------------------------
// These must be handled to prevent Proxy from being treated as a Promise,
// breaking instanceof checks, or confusing test matchers.

const GUARD_PROPS: Record<string | symbol, unknown> = {
  then: undefined, // prevent Promise detection
  asymmetricMatch: undefined, // prevent vitest/jest matcher confusion
  constructor: Object, // safe prototype
  [Symbol.toStringTag]: 'TypedScope',
};

// -- Mutable state per proxy instance ----------------------------------------

interface ReactiveState {
  breakFn?: (reason?: string) => void;
  /** Cache: top-level key -> { raw object ref, child proxy } */
  childCache: Map<string, { ref: object; proxy: object }>;
}

// -- Nested child proxy (for deep write interception) ------------------------
//
// Cycle safety: an immutable Set<object> of ancestor objects is passed down
// each access chain. Each branch gets its own copy (new Set(parent)) so
// scope.x.friend and scope.x.coworker don't pollute each other's tracking.
// When a child value is already in the ancestor set, we've hit a cycle.
// At the cycle break: return a terminal proxy that tracks writes (set trap
// still builds path + calls updateValue) but doesn't recurse reads further.

function createTerminalProxy(
  obj: Record<string, unknown>,
  rootKey: string,
  segments: string[],
  target: ReactiveTarget,
  state: ReactiveState,
  visited: Set<object> = new Set(),
): unknown {
  visited.add(obj);

  return new Proxy(obj, {
    get(raw, prop) {
      if (typeof prop === 'symbol') return (raw as any)[prop];
      if (prop === 'then') return undefined;
      if (prop === 'asymmetricMatch') return undefined;
      if (prop === 'constructor') return Object;
      if (prop === 'toJSON')
        return () => {
          // Strip object-typed values to prevent circular JSON errors
          const safe: Record<string, unknown> = {};
          for (const k of Object.keys(raw)) {
            const v = (raw as any)[k];
            if (v === null || typeof v !== 'object') safe[k] = v;
          }
          return safe;
        };

      const value = (raw as any)[prop];

      // Continue tracking writes at deeper levels via chained terminal proxies.
      // Use visited set to prevent re-entering the same object (cycle in terminal chain).
      if (shouldWrapWithProxy(value) && !Array.isArray(value) && !visited.has(value as object)) {
        return createTerminalProxy(
          value as Record<string, unknown>,
          rootKey,
          [...segments, prop as string],
          target,
          state,
          visited,
        );
      }

      return value;
    },
    set(raw, prop, value) {
      if (typeof prop !== 'string') return true;
      const childSegments = [...segments, prop];
      const patch = buildNestedPatch(childSegments, unwrapProxy(value));
      target.updateValue(rootKey, patch);
      state.childCache.delete(rootKey);
      return true;
    },
  });
}

function createNestedProxy(
  obj: Record<string, unknown>,
  rootKey: string,
  segments: string[],
  target: ReactiveTarget,
  readSilent: (key?: string) => unknown,
  state: ReactiveState,
  ancestors: Set<object> = new Set(),
): unknown {
  return new Proxy(obj, {
    get(raw, prop) {
      if (typeof prop === 'symbol') return (raw as any)[prop];

      // Guard properties
      if (prop === 'then') return undefined;
      if (prop === 'asymmetricMatch') return undefined;
      if (prop === 'constructor') return Object;
      if (prop === 'toJSON')
        return () => {
          // Strip object-typed values to prevent circular JSON errors
          const safe: Record<string, unknown> = {};
          for (const k of Object.keys(raw)) {
            const v = (raw as any)[k];
            if (v === null || typeof v !== 'object') safe[k] = v;
          }
          return safe;
        };

      const value = (raw as any)[prop];

      // Primitive or non-wrappable -- return as-is (no deeper proxy)
      if (!shouldWrapWithProxy(value)) return value;

      const childSegments = [...segments, prop as string];

      // Array -- return array proxy
      if (Array.isArray(value)) {
        return createArrayProxy(
          () => {
            const current = readSilent(rootKey) as any;
            return lodashGet(current, childSegments.join('.')) ?? [];
          },
          (newArr) => {
            const patch = buildNestedPatch(childSegments, unwrapProxy(newArr));
            target.updateValue(rootKey, patch);
            state.childCache.delete(rootKey);
          },
        );
      }

      // Cycle detection: if this value is an ancestor in the current access
      // chain, return a terminal proxy (tracks writes, stops recursing reads).
      if (ancestors.has(value as object)) {
        return createTerminalProxy(value as Record<string, unknown>, rootKey, childSegments, target, state);
      }

      // Build new ancestor set for this branch (immutable -- no cross-branch pollution)
      const childAncestors = new Set(ancestors);
      childAncestors.add(value as object);

      return createNestedProxy(
        value as Record<string, unknown>,
        rootKey,
        childSegments,
        target,
        readSilent,
        state,
        childAncestors,
      );
    },

    set(raw, prop, value) {
      if (typeof prop !== 'string') return true;

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
export function createTypedScope<T extends object>(target: ReactiveTarget, options?: ReactiveOptions): TypedScope<T> {
  const state: ReactiveState = {
    breakFn: options?.breakPipeline,
    childCache: new Map(),
  };

  // Bind silent-read method once — avoids per-call ?? + .call() in array proxy getCurrent closures
  const readSilent = (target.getValueSilent ?? target.getValue).bind(target);

  const proxy = new Proxy(target as unknown as TypedScope<T>, {
    get(_proxyTarget, prop, _receiver) {
      // 1. Internal symbols (check before other symbols)
      if (prop === IS_TYPED_SCOPE) return true;
      if (prop === BREAK_SETTER) {
        return (fn: () => void) => {
          state.breakFn = fn;
        };
      }

      // 2. Symbol properties (guard + inspection)
      if (typeof prop === 'symbol') {
        if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop)) return GUARD_PROPS[prop];
        // Node.js util.inspect — show state snapshot, not proxy internals
        if (prop === Symbol.for('nodejs.util.inspect.custom')) {
          return () => target.getValue();
        }
        return undefined;
      }

      // 3. String guard properties
      if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop)) return GUARD_PROPS[prop];

      // 4. $-prefixed methods -- route to facade
      if (SCOPE_METHOD_NAMES.has(prop)) {
        const router = METHOD_ROUTES[prop];
        if (router) return router(target, state);
        return undefined;
      }

      // 5. Executor-internal method pass-through (explicit allowlist)
      //    FlowChartExecutor wrapping calls attachRecorder, notifyStageStart, etc.
      //    directly on the scope. Forward only allowlisted methods.
      if (EXECUTOR_INTERNAL_METHODS.has(prop) && typeof (target as any)[prop] === 'function') {
        return (target as any)[prop].bind(target);
      }

      // 6. State key -- call getValue (fires onRead ONCE)
      const value = target.getValue(prop);

      // Primitive or null/undefined -- return as-is
      if (value === null || value === undefined || typeof value !== 'object') {
        return value;
      }

      // Non-wrappable (Date, Map, class instance, etc.) -- return unwrapped
      if (!shouldWrapWithProxy(value)) return value;

      // Array -- return array proxy (cached for identity equality)
      if (Array.isArray(value)) {
        const cached = state.childCache.get(prop);
        if (cached && cached.ref === value) return cached.proxy;

        const arrProxy = createArrayProxy(
          () => (readSilent(prop) as unknown[]) ?? [],
          (newArr) => {
            target.setValue(prop, unwrapProxy(newArr));
            state.childCache.delete(prop);
          },
        );
        state.childCache.set(prop, { ref: value as object, proxy: arrProxy as unknown as object });
        return arrProxy;
      }

      // Plain object -- return nested proxy (cached for identity equality)
      const cached = state.childCache.get(prop);
      if (cached && cached.ref === value) return cached.proxy;

      const nested = createNestedProxy(
        value as Record<string, unknown>,
        prop,
        [],
        target,
        readSilent,
        state,
        new Set<object>([value as object]), // seed ancestor set with root object
      );
      state.childCache.set(prop, { ref: value as object, proxy: nested as object });
      return nested;
    },

    set(_proxyTarget, prop, value) {
      if (typeof prop !== 'string') return true;
      if (SCOPE_METHOD_NAMES.has(prop)) {
        throw new Error(
          `Cannot set state key "${prop}" -- it conflicts with a reserved TypedScope method. Rename the state key to avoid $-prefixed names.`,
        );
      }
      // Unwrap Proxy values before storing — structuredClone in TransactionBuffer
      // cannot clone Proxy objects. This handles: scope.backup = scope.customer
      const unwrapped = unwrapProxy(value);
      target.setValue(prop, unwrapped);
      state.childCache.delete(prop); // invalidate cache
      return true;
    },

    deleteProperty(_proxyTarget, prop) {
      if (typeof prop !== 'string') return true;
      target.deleteValue(prop);
      state.childCache.delete(prop);
      return true;
    },

    has(_proxyTarget, prop) {
      if (typeof prop === 'symbol') return Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop);
      if (SCOPE_METHOD_NAMES.has(prop)) return true;
      // Use non-tracking hasKey if available, else fallback to getStateKeys
      if (target.hasKey) return target.hasKey(prop);
      if (target.getStateKeys) return target.getStateKeys().includes(prop);
      // Fallback: getValue fires onRead (acceptable degradation)
      return target.getValue(prop) !== undefined;
    },

    ownKeys() {
      // Use non-tracking getStateKeys if available, else fallback
      if (target.getStateKeys) return target.getStateKeys();
      const snapshot = target.getValue() as Record<string, unknown> | undefined;
      if (!snapshot || typeof snapshot !== 'object') return [];
      return Object.keys(snapshot);
    },

    getOwnPropertyDescriptor(_proxyTarget, prop) {
      if (typeof prop !== 'string') return undefined;
      if (SCOPE_METHOD_NAMES.has(prop)) return undefined; // $-methods are non-enumerable
      // Check existence without firing onRead — no getValue call here
      const exists = target.hasKey
        ? target.hasKey(prop)
        : target.getStateKeys
        ? target.getStateKeys().includes(prop)
        : target.getValue(prop) !== undefined; // fallback only
      if (!exists) return undefined;
      // Return a minimal descriptor — actual value is fetched via the get trap
      return { configurable: true, enumerable: true, writable: true };
    },
  });

  return proxy;
}
