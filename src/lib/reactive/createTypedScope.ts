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
import { toJSONView } from './jsonProjection.js';
import { liveInspectionTraps, liveObject } from './liveView.js';
import { buildNestedPatch } from './pathBuilder.js';
import { deleteInPath, setInPath, unwrapProxy } from './structuralWrite.js';
import type { ReactiveOptions, ReactiveTarget, TypedScope } from './types.js';
import { BREAK_SETTER, EXECUTOR_INTERNAL_METHODS, IS_TYPED_SCOPE, SCOPE_METHOD_NAMES } from './types.js';

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
  $attachScopeRecorder: (t) => t.attachScopeRecorder.bind(t),
  $detachScopeRecorder: (t) => t.detachScopeRecorder.bind(t),
  $getScopeRecorders: (t) => t.getScopeRecorders.bind(t),
  $batchArray: (t) => (key: string, fn: (arr: unknown[]) => void) => {
    // One getValue — fires onRead once
    const current = t.getValue(key);
    // Clone once — DEEP (or start empty if missing/non-array). The read is
    // BORROWED: before the stage's first staged write it is committed shared
    // memory itself, so a shallow `[...current]` handed the stage the
    // committed ELEMENTS and `arr[0].n = 9` edited committed state in place
    // with no trace row (and the lazy buffer's base was then taken AFTER the
    // edit, so the net-change filter saw nothing). State values survive
    // `structuredClone` by contract, so the working copy is a full copy.
    const clone: unknown[] = Array.isArray(current) ? structuredClone(current) : [];
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

// -- Silent existence check --------------------------------------------------

/**
 * Does this key exist in state, answered with NO tracking side effect at all?
 *
 * `getStateKeys()` is the only inspection a ScopeFacade answers without routing
 * through the tracked read path. `hasKey()` deliberately DOES route through it:
 * `'k' in scope` is a real question about state that a stage can branch on, so
 * it registers as a read — which is exactly why this probe must not use it.
 *
 * Returns `undefined` when the target offers no silent answer; callers must
 * then choose deliberately rather than assume.
 */
function silentlyKnownKey(target: ReactiveTarget, key: string): boolean | undefined {
  if (!target.getStateKeys) return undefined;
  return target.getStateKeys().includes(key);
}

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
  readSilent: (key?: string) => unknown,
  state: ReactiveState,
  visited: Set<object> = new Set(),
): unknown {
  visited.add(obj);
  // Reads are LIVE (9.22.0) — see liveView.ts.
  const live = () => liveObject(obj, lodashGet(readSilent(rootKey), segments));

  return new Proxy(obj, {
    get(_raw, prop) {
      const raw = live();
      if (typeof prop === 'symbol') return (raw as any)[prop];
      if (prop === 'then') return undefined;
      if (prop === 'asymmetricMatch') return undefined;
      if (prop === 'constructor') return Object;
      // Law: serializing a proxied value equals serializing $getValue's value.
      // Only a cycle back-edge is pruned (jsonProjection.ts).
      if (prop === 'toJSON') return () => toJSONView(raw);

      const value = (raw as any)[prop];

      // An array past the cycle edge still gets copy-on-write interception —
      // it commits as a `set` of the root key, the same law as the nested
      // proxy above.
      if (Array.isArray(value) && shouldWrapWithProxy(value)) {
        const arrSegments = [...segments, prop as string];
        return createArrayProxy(
          () => (lodashGet(readSilent(rootKey), arrSegments) as unknown[]) ?? [],
          (newArr) => {
            target.setValue(rootKey, setInPath(readSilent(rootKey), arrSegments, unwrapProxy(newArr)));
            state.childCache.delete(rootKey);
          },
        );
      }

      // Continue tracking writes at deeper levels via chained terminal proxies.
      // Use visited set to prevent re-entering the same object (cycle in terminal chain).
      if (shouldWrapWithProxy(value) && !Array.isArray(value) && !visited.has(value as object)) {
        return createTerminalProxy(
          value as Record<string, unknown>,
          rootKey,
          [...segments, prop as string],
          target,
          readSilent,
          state,
          visited,
        );
      }

      return value;
    },
    set(_raw, prop, value) {
      if (typeof prop !== 'string') return true;
      const childSegments = [...segments, prop];
      const unwrapped = unwrapProxy(value);
      // Same law as the nested proxy: an array assignment REPLACES.
      if (Array.isArray(unwrapped)) {
        target.setValue(rootKey, setInPath(readSilent(rootKey), childSegments, unwrapped));
        state.childCache.delete(rootKey);
        return true;
      }
      const patch = buildNestedPatch(childSegments, unwrapped);
      target.updateValue(rootKey, patch);
      state.childCache.delete(rootKey);
      return true;
    },

    deleteProperty(_raw, prop) {
      if (typeof prop !== 'string') return true;
      target.setValue(rootKey, deleteInPath(readSilent(rootKey), [...segments, prop]));
      state.childCache.delete(rootKey);
      return true;
    },

    ...liveInspectionTraps(live),
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
  // Reads are LIVE (9.22.0): a held proxy reads its own writes, `'x' in o`
  // and `Object.keys(o)` see them, and `o.b = o.a * 10` uses the new `a`.
  // The captured object answers only when the path is gone — see liveView.ts.
  const live = () => liveObject(obj, lodashGet(readSilent(rootKey), segments));

  return new Proxy(obj, {
    get(_raw, prop) {
      const raw = live();
      if (typeof prop === 'symbol') return (raw as any)[prop];

      // Guard properties
      if (prop === 'then') return undefined;
      if (prop === 'asymmetricMatch') return undefined;
      if (prop === 'constructor') return Object;
      // Law: serializing a proxied value equals serializing $getValue's value —
      // nested objects, arrays and Dates included. Only a cycle back-edge is
      // pruned, so circular state still never throws here (jsonProjection.ts).
      // This trap also carries the WRITE path: unwrapProxy() round-trips
      // through JSON, so `scope.copy = scope.results` commits via this view.
      if (prop === 'toJSON') return () => toJSONView(raw);

      const value = (raw as any)[prop];

      // Primitive or non-wrappable -- return as-is (no deeper proxy)
      if (!shouldWrapWithProxy(value)) return value;

      const childSegments = [...segments, prop as string];

      // Array -- return array proxy.
      //
      // WHY THIS COMMITS A `set` OF THE ROOT KEY, not a merge of a nested patch
      // (9.22.0): an array mutation hands back the COMPLETE new array, and
      // `merge`'s array arm is a set UNION (`deepSmartMerge`). Committing
      // `[1,99,3]` as a merge onto `[1,2,3]` produced `[1,2,3,99]` — element
      // replacement, reordering and shrinking were unrepresentable through any
      // array that was not itself a top-level key, and the log recorded the
      // union faithfully, so state and log agreed and were both wrong. `set` is
      // the only verb that can say "this is the whole value now"; the root key
      // is the granularity every consumer indexes by (`findLastWriter`,
      // `sliceForKey`, `causalChain`), and it is exactly what a TOP-LEVEL array
      // write has always done. The new root is built by copying only the
      // containers on the path — the value read stays untouched.
      if (Array.isArray(value)) {
        return createArrayProxy(
          () => {
            // Segments, not a dot-joined string: a nested key may itself contain
            // a dot, and joining would address the wrong node.
            const current = readSilent(rootKey) as any;
            return (lodashGet(current, childSegments) as unknown[]) ?? [];
          },
          (newArr) => {
            target.setValue(rootKey, setInPath(readSilent(rootKey), childSegments, unwrapProxy(newArr)));
            state.childCache.delete(rootKey);
          },
        );
      }

      // Cycle detection: if this value is an ancestor in the current access
      // chain, return a terminal proxy (tracks writes, stops recursing reads).
      if (ancestors.has(value as object)) {
        return createTerminalProxy(value as Record<string, unknown>, rootKey, childSegments, target, readSilent, state);
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

    set(_raw, prop, value) {
      if (typeof prop !== 'string') return true;

      const childSegments = [...segments, prop];
      const unwrapped = unwrapProxy(value);

      // An ARRAY assignment REPLACES, at every depth (9.22.0). `merge`'s array
      // arm is a union, so `scope.k.tags = ['b']` used to APPEND — while the
      // identical expression one level up (`scope.tags = ['b']`) replaced, and
      // a shorter array (`scope.k.arr = [1]`) could not be expressed at all.
      // `$update(key, { tags: [...] })` remains the explicit append.
      if (Array.isArray(unwrapped)) {
        target.setValue(rootKey, setInPath(readSilent(rootKey), childSegments, unwrapped));
        state.childCache.delete(rootKey);
        return true;
      }

      const patch = buildNestedPatch(childSegments, unwrapped);
      target.updateValue(rootKey, patch);
      state.childCache.delete(rootKey);
      return true;
    },

    // `delete scope.order.customer.tier` — merge cannot express a REMOVAL
    // (a patch of `undefined` is read as absent by every consumer), so the key
    // is removed from a copy of the root and committed as a `set` of the root.
    deleteProperty(_raw, prop) {
      if (typeof prop !== 'string') return true;
      target.setValue(rootKey, deleteInPath(readSilent(rootKey), [...segments, prop]));
      state.childCache.delete(rootKey);
      return true;
    },

    ...liveInspectionTraps(live),
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
      //    FlowChartExecutor wrapping calls attachScopeRecorder, notifyStageStart, etc.
      //    directly on the scope. Forward only allowlisted methods.
      if (EXECUTOR_INTERNAL_METHODS.has(prop) && typeof (target as any)[prop] === 'function') {
        return (target as any)[prop].bind(target);
      }

      // 6. Serialization protocol probe. JSON.stringify asks EVERY value for a
      //    `toJSON` method before serializing it. That question comes from the
      //    runtime, not from the stage author, so it must not enter the read
      //    set — causalChain and sliceForKey would carry a key no chart names.
      //    A state key literally called 'toJSON' is legal, though: when the key
      //    really EXISTS this is a genuine read and stays tracked. And when the
      //    target cannot answer silently (silentlyKnownKey -> undefined), truth
      //    wins over noise: fall through and track. Never silently untracked.
      if (prop === 'toJSON' && silentlyKnownKey(target, prop) === false) return undefined;

      // 7. State key -- call getValue (fires onRead ONCE)
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
