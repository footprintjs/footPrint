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
import { arrayProxyAt } from './arrayTraps.js';
import { rememberHandle, unwrapHandles } from './handles.js';
import { cachedMember, liveGetTrap, liveInspectionTraps, liveObject, MemberCache } from './liveView.js';
import { unwrapProxy } from './structuralWrite.js';
import type { ReactiveOptions, ReactiveTarget, TypedScope } from './types.js';
import { BREAK_SETTER, EXECUTOR_INTERNAL_METHODS, IS_TYPED_SCOPE, SCOPE_METHOD_NAMES } from './types.js';
import { type WriteSink, rootKeySink, sinkDeleteTrap, sinkSetTrap } from './writeTraps.js';

// -- $-method routing --------------------------------------------------------

type MethodRouter = (target: ReactiveTarget, opts: ReactiveState) => unknown;

const METHOD_ROUTES: Record<string, MethodRouter> = {
  $getValue: (t) => t.getValue.bind(t),
  // A handle the scope handed out is a value it accepts back (handles.ts):
  // `$setValue('copy', scope.customer)` stores the value behind the handle,
  // not a Proxy the commit could never clone. The set trap has always done
  // this for `scope.copy = scope.customer` (through `unwrapProxy`); these
  // are the explicit doors. A handle-free value passes through by reference.
  $setValue: (t) => (key: string, value: unknown, shouldRedact?: boolean, description?: string) =>
    t.setValue(key, unwrapHandles(value), shouldRedact, description),
  $update: (t) => (key: string, value: unknown, description?: string) =>
    t.updateValue(key, unwrapHandles(value), description),
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
    // One setValue — fires onWrite once with the final array. The stage may
    // have pushed handles into the clone (`arr.push(scope.template)`) — they
    // are values by the time the array is staged (handles.ts).
    t.setValue(key, unwrapHandles(clone));
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
  /** The top-level key's child proxy, validated by raw identity (`liveView.ts · cachedMember`); a sink drops the key on write. */
  childCache: MemberCache;
}

// -- Nested child proxies (for deep write interception) -----------------------
//
// Both factories are ORCHESTRATORS (9.23.1): reads are `liveView.ts`, writes
// are `writeTraps.ts` over a `rootKeySink`, and the ONE thing each decides
// itself is what a child member becomes — the cycle policy. Each holds its
// own per-member proxy cache (9.23.2, `liveView.ts · cachedMember`).
//
// Cycle safety: an immutable Set<object> of ancestor objects is passed down
// each access chain. Each branch gets its own copy (new Set(parent)) so
// scope.x.friend and scope.x.coworker don't pollute each other's tracking.
// When a child value is already in the ancestor set, we've hit a cycle.
// At the cycle break: return a terminal proxy that tracks writes (set trap
// still builds path + commits through the sink) but doesn't recurse reads
// further. The terminal chain shares ONE mutable `visited` set: a value seen
// anywhere past the cycle edge is handed back raw.

function createTerminalProxy(
  obj: Record<string, unknown>,
  sink: WriteSink,
  segments: readonly string[],
  visited: Set<object> = new Set(),
): unknown {
  visited.add(obj);
  const members = new MemberCache();
  const live = () => liveObject(obj, sink.readAt(segments));
  const child = (value: unknown, path: string[]): unknown => {
    if (!shouldWrapWithProxy(value)) return value;
    // An array past the cycle edge still gets copy-on-write interception —
    // it commits as a `set` of the root key, the same law as the nested proxy.
    if (Array.isArray(value)) return arrayProxyAt(sink, path);
    if (visited.has(value as object)) return value;
    return createTerminalProxy(value as Record<string, unknown>, sink, path, visited);
  };
  return rememberHandle(
    new Proxy(obj, {
      get: liveGetTrap(live, segments, child, members),
      set: sinkSetTrap(sink, segments),
      deleteProperty: sinkDeleteTrap(sink, segments),
      ...liveInspectionTraps(live),
    }),
    live,
  );
}

function createNestedProxy(
  obj: Record<string, unknown>,
  sink: WriteSink,
  segments: readonly string[],
  ancestors: Set<object> = new Set(),
): unknown {
  // Reads are LIVE (9.22.0): a held proxy reads its own writes, `'x' in o`
  // and `Object.keys(o)` see them, and `o.b = o.a * 10` uses the new `a`.
  // The captured object answers only when the path is gone — see liveView.ts.
  const members = new MemberCache();
  const live = () => liveObject(obj, sink.readAt(segments));
  const child = (value: unknown, path: string[]): unknown => {
    if (!shouldWrapWithProxy(value)) return value;
    // An array commits as a `set` of the ROOT KEY (reactive/README.md, law 3)
    // — the sink's verb, whatever depth the array sits at.
    if (Array.isArray(value)) return arrayProxyAt(sink, path);
    if (ancestors.has(value as object)) return createTerminalProxy(value as Record<string, unknown>, sink, path);
    return createNestedProxy(value as Record<string, unknown>, sink, path, new Set(ancestors).add(value as object));
  };
  return rememberHandle(
    new Proxy(obj, {
      get: liveGetTrap(live, segments, child, members),
      set: sinkSetTrap(sink, segments),
      deleteProperty: sinkDeleteTrap(sink, segments),
      ...liveInspectionTraps(live),
    }),
    live,
  );
}

// -- Top-level leaves ---------------------------------------------------------

/** `internalRead` answered nothing: the name is a state key and must be read (tracked) from the target. */
const STATE_KEY: unique symbol = Symbol('state-key');

/**
 * WHY: the names the scope answers ITSELF — internal symbols, the guard
 * properties, Node's inspect hook, the `$`-methods, the executor's allowlisted
 * pass-throughs (`attachScopeRecorder`, `notifyStageStart`, …, called directly
 * on the scope) and the JSON probe — must never become tracked reads;
 * everything else is a state key and is left to the caller.
 *
 * The probe: `JSON.stringify` asks EVERY value for a `toJSON` method. That
 * question comes from the runtime, not the stage author, so it must not enter
 * the read set. A state key literally called 'toJSON' is legal: when it EXISTS
 * this is a genuine read and stays tracked, and when the target cannot answer
 * silently, truth wins over noise — fall through.
 */
function internalRead(target: ReactiveTarget, state: ReactiveState, prop: string | symbol): unknown {
  if (prop === IS_TYPED_SCOPE) return true;
  if (prop === BREAK_SETTER) {
    return (fn: () => void) => {
      state.breakFn = fn;
    };
  }
  if (typeof prop === 'symbol') {
    if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop)) return GUARD_PROPS[prop];
    if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => target.getValue();
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(GUARD_PROPS, prop)) return GUARD_PROPS[prop];
  if (SCOPE_METHOD_NAMES.has(prop)) return METHOD_ROUTES[prop]?.(target, state);
  if (EXECUTOR_INTERNAL_METHODS.has(prop) && typeof (target as any)[prop] === 'function') {
    return (target as any)[prop].bind(target);
  }
  if (prop === 'toJSON' && silentlyKnownKey(target, prop) === false) return undefined;
  return STATE_KEY;
}

/**
 * A wrappable state value becomes the array or nested proxy for its key;
 * anything else is handed back raw. `scope.k === scope.k` holds within a
 * stage through the same per-member cache every object proxy uses
 * (`liveView.ts · cachedMember`): a write to the key drops the entry (the
 * sink does it), a commit swaps the value and the ref check misses — either
 * way the next read builds a fresh proxy over the new value.
 */
function wrapStateValue(
  target: ReactiveTarget,
  readSilent: (key: string) => unknown,
  state: ReactiveState,
  key: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (!shouldWrapWithProxy(value)) return value; // Date, Map, class instance, frozen …
  return cachedMember(
    state.childCache,
    key,
    value,
    () => {
      const sink = rootKeySink(target, readSilent, key, state.childCache);
      if (Array.isArray(value)) return arrayProxyAt(sink, []);
      return createNestedProxy(value as Record<string, unknown>, sink, [], new Set<object>([value]));
    },
    [],
  );
}

/** WHY: a `$`-name can never be a state key — the write is refused, not shadowed; every other assignment
 *  stores the unwrapped value (landmine 1) and drops the key's cached proxy. */
function assignStateKey(target: ReactiveTarget, state: ReactiveState, key: string, value: unknown): void {
  if (SCOPE_METHOD_NAMES.has(key)) {
    throw new Error(
      `Cannot set state key "${key}" -- it conflicts with a reserved TypedScope method. Rename the state key to avoid $-prefixed names.`,
    );
  }
  target.setValue(key, unwrapProxy(value));
  state.childCache.delete(key);
}

/** Does the key exist — answered without a tracked read wherever the target can; `getValue` is the last resort. */
function knownKey(target: ReactiveTarget, key: string): boolean {
  if (target.hasKey) return target.hasKey(key);
  if (target.getStateKeys) return target.getStateKeys().includes(key);
  return target.getValue(key) !== undefined; // fallback: fires onRead (acceptable degradation)
}

/** Every state key — silently where the target can, else from a whole-state read. */
function stateKeys(target: ReactiveTarget): string[] {
  if (target.getStateKeys) return target.getStateKeys();
  const snapshot = target.getValue() as Record<string, unknown> | undefined;
  return snapshot && typeof snapshot === 'object' ? Object.keys(snapshot) : [];
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
  const state: ReactiveState = { breakFn: options?.breakPipeline, childCache: new MemberCache() };
  // Bind the silent read once — the nested/array proxies resolve their live view through it.
  const readSilent = (target.getValueSilent ?? target.getValue).bind(target);

  return new Proxy(target as unknown as TypedScope<T>, {
    get(_proxyTarget, prop) {
      const answered = internalRead(target, state, prop);
      if (answered !== STATE_KEY) return answered;
      // A state key: ONE tracked read (fires onRead once), then the wrapper.
      return wrapStateValue(target, readSilent, state, prop as string, target.getValue(prop as string));
    },
    set(_proxyTarget, prop, value) {
      if (typeof prop === 'string') assignStateKey(target, state, prop, value);
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
      return SCOPE_METHOD_NAMES.has(prop) || knownKey(target, prop);
    },
    ownKeys: () => stateKeys(target),
    getOwnPropertyDescriptor(_proxyTarget, prop) {
      if (typeof prop !== 'string' || SCOPE_METHOD_NAMES.has(prop)) return undefined; // $-methods are non-enumerable
      if (!knownKey(target, prop)) return undefined;
      return { configurable: true, enumerable: true, writable: true }; // the value is fetched via the get trap
    },
  });
}
