/**
 * reactive/arrayTraps -- Array mutation interception via Proxy.
 *
 * When scope.items is an array, we return a Proxy that intercepts mutating
 * methods (push, pop, splice, etc.) AND indexed access. Each mutation:
 * 1. Clones the current array
 * 2. Applies the mutation to the clone
 * 3. Commits the new array via the commit callback
 *
 * Non-mutating methods (map, filter, forEach, etc.) pass through to the
 * current array snapshot without interception.
 *
 * The original array in state is NEVER mutated directly -- all writes go
 * through the commit callback which calls setValue/updateValue.
 *
 * ── Indexed access is part of the chain (9.22.0) ─────────────────────────
 * `arr[i]` used to hand back the RAW element, which broke the proxy chain at
 * exactly the point users write through it: `order.lines[0].qty = 4` was an
 * in-place mutation of a borrowed read — no trap, no trace row, no commit.
 * Before the stage's first staged write that borrowed value IS committed
 * shared memory, so the mutation moved state while the log stayed empty; after
 * it, the mutation landed in the private buffer clone and was dropped. Same
 * expression, two silent outcomes.
 *
 * Now an indexed read of a wrappable element returns an ELEMENT PROXY that
 * accumulates the path inside the element and, on write, rebuilds the array
 * immutably ({@link setInPath}) and hands the whole new array to `commit` —
 * the same funnel `push` already used. One write path for the whole array,
 * whatever depth it is addressed at.
 *
 * ── What is still NOT seen (by design) ───────────────────────────────────
 * Elements reached WITHOUT an index — `find()`, `filter()`, `for…of`,
 * `forEach`, destructuring — are handed back raw, because wrapping them would
 * mean returning proxies out of every read method (`map` would build an array
 * of proxies) for a cost the library should not pay. Mutating one of those is
 * not lost in silence either: `StageContext` compares what a stage READ with
 * what the value holds at commit and, in dev mode, warns with the exact path.
 * See src/lib/reactive/README.md.
 */

import { nativeGet } from '../memory/pathOps.js';
import { shouldWrapWithProxy } from './allowlist.js';
import { toJSONView } from './jsonProjection.js';
import { liveInspectionTraps, liveObject } from './liveView.js';
import { deleteInPath, setInPath, unwrapProxy } from './structuralWrite.js';

/** Methods that mutate the array in-place. We intercept and copy-on-write. */
const MUTATING_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);

/** Reads that must never be answered with a state value (see createTypedScope's GUARD_PROPS). */
function guardValue(prop: string): { hit: boolean; value?: unknown } {
  if (prop === 'then' || prop === 'asymmetricMatch') return { hit: true, value: undefined };
  if (prop === 'constructor') return { hit: true, value: Object };
  return { hit: false };
}

/**
 * The three primitives every write inside an element goes through. All of them
 * rebuild the owning array immutably and hand the WHOLE new array to `commit`
 * — the array proxy's own copy-on-write contract, applied one or more levels
 * down. `path` is measured from the element: `[]` IS the element slot.
 */
function replaceInElement(
  getCurrent: () => unknown[],
  commit: (next: any[]) => void,
  index: number,
  path: readonly string[],
  value: unknown,
): void {
  const next = [...getCurrent()];
  if (index >= next.length) return; // the element is gone — nothing to write into
  next[index] = path.length === 0 ? value : setInPath(next[index], path, value);
  commit(next);
}

function removeInElement(
  getCurrent: () => unknown[],
  commit: (next: any[]) => void,
  index: number,
  path: readonly string[],
): void {
  const next = [...getCurrent()];
  if (index >= next.length) return;
  next[index] = deleteInPath(next[index], path);
  commit(next);
}

/** The value at `path` inside element `index`, as it stands NOW (read-your-writes). */
function readInElement(getCurrent: () => unknown[], index: number, path: readonly string[]): unknown {
  const element = getCurrent()[index];
  return path.length === 0 ? element : nativeGet(element, path as string[]);
}

/**
 * Proxy over one OBJECT element (or an object nested inside one), carrying the
 * path from the element down to it. Reads recurse; writes go back out through
 * the owning array's commit callback.
 *
 * READS ARE LIVE. Every write rebuilds the array immutably, so the object the
 * proxy was created over is the PRE-write element for ever after; a held
 * handle that read from it saw its own writes vanish (`line.n += 1` twice
 * gave 2, `line.total = line.qty * 10` used the old `qty`, `'x' in line` was
 * false right after `line.x = 1`). Every trap therefore resolves the element
 * through {@link readInElement} first, and falls back to the captured object
 * only when the path no longer exists (the slot was emptied or the array
 * shrank) — the same read-your-writes the array proxy itself has always had,
 * and the same law the nested and terminal object proxies follow (liveView.ts).
 */
function createElementProxy(
  raw: Record<string, unknown>,
  getCurrent: () => unknown[],
  commit: (next: any[]) => void,
  index: number,
  segments: readonly string[],
  visited: Set<object>,
): unknown {
  const live = () => liveObject(raw, readInElement(getCurrent, index, segments));

  return new Proxy(raw, {
    get(_target, prop) {
      const current = live();
      if (typeof prop === 'symbol') return (current as any)[prop];
      const guard = guardValue(prop);
      if (guard.hit) return guard.value;
      // Law: serializing a proxied value equals serializing the raw value.
      if (prop === 'toJSON') return () => toJSONView(current);

      const value = (current as any)[prop];
      return wrapElementMember(value, getCurrent, commit, index, [...segments, prop], visited);
    },

    set(_target, prop, value) {
      if (typeof prop !== 'string') return true;
      replaceInElement(getCurrent, commit, index, [...segments, prop], unwrapProxy(value));
      return true;
    },

    deleteProperty(_target, prop) {
      if (typeof prop !== 'string') return true;
      removeInElement(getCurrent, commit, index, [...segments, prop]);
      return true;
    },

    ...liveInspectionTraps(live),
  });
}

/**
 * Wrap a value read out of an element: arrays become array proxies whose
 * commits route back through the owning array, plain objects become element
 * proxies one level deeper, everything else is returned as-is. A value already
 * on the access chain (a cycle) is returned raw — the same back-edge the
 * nested-object terminal proxy takes.
 */
function wrapElementMember(
  value: unknown,
  getCurrent: () => unknown[],
  commit: (next: any[]) => void,
  index: number,
  path: readonly string[],
  visited: Set<object>,
): unknown {
  if (!shouldWrapWithProxy(value)) return value;
  if (visited.has(value as object)) return value;
  const branch = new Set(visited);
  branch.add(value as object);

  if (Array.isArray(value)) {
    return createArrayProxy(
      () => (readInElement(getCurrent, index, path) as unknown[]) ?? [],
      (inner) => replaceInElement(getCurrent, commit, index, path, inner),
    );
  }
  return createElementProxy(value as Record<string, unknown>, getCurrent, commit, index, path, branch);
}

/**
 * Creates a Proxy over an array that intercepts mutating operations.
 *
 * @param getCurrent - Returns the current array snapshot from state
 * @param commit - Called with the new array after a mutation (triggers setValue)
 * @returns Proxied array with copy-on-write semantics
 */
export function createArrayProxy<T>(getCurrent: () => T[], commit: (newArray: T[]) => void): T[] {
  // Use the actual current array as the Proxy target. Node.js console.log
  // inspects the target directly (bypasses Proxy traps). By using the real
  // array, console.log shows correct values. The target reference is fixed
  // at creation time — after mutations, the proxy returns a new proxy
  // (via cache invalidation) with the fresh array as target.
  const target = getCurrent() as T[];
  const readCurrent = getCurrent as unknown as () => unknown[];
  const writeCommit = commit as unknown as (next: any[]) => void;
  // Element proxies are cached per index and validated by raw identity — the
  // same bargain the top-level child cache makes. Without it, reading
  // `lines[i].qty` in a loop would allocate one proxy per read; with it,
  // repeated access to an UNCHANGED element is free and `lines[0] === lines[0]`
  // holds within a stage. A commit replaces the array, so the ref check misses
  // and a fresh proxy is built over the new element.
  const elementCache = new Map<number, { ref: unknown; proxy: unknown }>();

  return new Proxy(target, {
    get(_target, prop, receiver) {
      // Intercept mutating methods
      if (typeof prop === 'string' && MUTATING_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          const clone = [...getCurrent()];
          const result = (clone as any)[prop](...args);
          commit(clone);
          return result;
        };
      }

      // Non-mutating access: delegate to the current array snapshot
      const current = getCurrent();

      // 'length' and index access
      if (prop === 'length') return current.length;

      // Numeric index access — the element joins the write chain (see header).
      if (typeof prop === 'string') {
        const index = Number(prop);
        if (Number.isInteger(index) && index >= 0 && index < current.length) {
          const element = current[index];
          if (!shouldWrapWithProxy(element)) return element;
          const cached = elementCache.get(index);
          if (cached && cached.ref === element) return cached.proxy;
          const wrapped = wrapElementMember(element, readCurrent, writeCommit, index, [], new Set<object>());
          elementCache.set(index, { ref: element, proxy: wrapped });
          return wrapped;
        }
      }

      // Node.js util.inspect custom formatting
      if (prop === Symbol.for('nodejs.util.inspect.custom')) {
        return () => current;
      }

      // Symbol.iterator and other built-in symbols
      if (typeof prop === 'symbol') {
        const val = (current as any)[prop];
        if (typeof val === 'function') return val.bind(current);
        return val;
      }

      // All other methods (map, filter, forEach, find, etc.) -- bind to current
      const val = (current as any)[prop];
      if (typeof val === 'function') return val.bind(current);
      return val;
    },

    set(_target, prop, value) {
      // Index assignment: scope.items[2] = 'updated'
      if (typeof prop === 'string') {
        const index = Number(prop);
        if (Number.isInteger(index) && index >= 0) {
          const clone = [...getCurrent()];
          clone[index] = value;
          commit(clone);
          return true;
        }
      }

      // Setting 'length' (e.g., arr.length = 0 to clear)
      if (prop === 'length' && typeof value === 'number') {
        const clone = [...getCurrent()];
        clone.length = value;
        commit(clone);
        return true;
      }

      return true; // ignore other set operations
    },

    // `delete items[2]` — without this trap the default reaches the RAW array
    // captured as the proxy target, mutating committed state with no commit
    // record. Copy-on-write like every other mutation; JS `delete` on an index
    // leaves the slot empty and the length unchanged, and so does this — the
    // emptied slot commits as `null`, JSON's only spelling for an array hole.
    deleteProperty(_target, prop) {
      const clone = [...getCurrent()];
      delete (clone as any)[prop];
      commit(clone);
      return true;
    },

    has(_target, prop) {
      const current = getCurrent();
      return Reflect.has(current, prop);
    },

    ownKeys() {
      const current = getCurrent();
      return Reflect.ownKeys(current);
    },

    getOwnPropertyDescriptor(_target, prop) {
      const current = getCurrent();
      return Object.getOwnPropertyDescriptor(current, prop);
    },
  });
}
