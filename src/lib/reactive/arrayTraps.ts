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
 * ── Only the ASSIGNED value is unwrapped (9.23.0) ────────────────────────
 * Landmine 1 says the set trap JSON-round-trips the value the caller handed
 * in. For an array that is the index-assigned element, a mutating method's
 * arguments (`push(x)`, `splice(i, n, ...items)`, `fill(x)`), or the leaf an
 * element proxy writes — and it is unwrapped HERE, at the trap that receives
 * it. The rebuilt array is handed to `commit` as it is: every sibling the
 * caller did not touch passes through by reference, `Date`s and `Map`s
 * intact. Until 9.23.0 the commit callbacks round-tripped the WHOLE rebuilt
 * array, which stringified untouched siblings and was O(N) per element write.
 * The one thing the round-trip used to do for the array's own shape — an
 * emptied or skipped slot became `null`, JSON's only spelling for a hole —
 * is now done explicitly by the traps that can create one (`delete arr[i]`,
 * `arr[i] = v` past the end, `arr.length = n` growth).
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
 * immutably (`structuralWrite.setInPath`, behind `writeTraps.elementSink`)
 * and hands the whole new array to `commit` — the same funnel `push` already
 * used. One write path for the whole array, whatever depth it is addressed at.
 *
 * ── What is still NOT seen (by design) ───────────────────────────────────
 * Elements reached WITHOUT an index — `find()`, `filter()`, `for…of`,
 * `forEach`, destructuring — are handed back raw, because wrapping them would
 * mean returning proxies out of every read method (`map` would build an array
 * of proxies) for a cost the library should not pay. Mutating one of those is
 * not lost in silence either: `StageContext` compares what a stage READ with
 * what the value holds at commit and, in dev mode, warns with the exact path.
 * See src/lib/reactive/README.md.
 *
 * ── Shape (9.23.1) ───────────────────────────────────────────────────────
 * `createArrayProxy` and `createElementProxy` are ORCHESTRATORS: they wire
 * traps and hold the caches. Every trap body is a named leaf below — one
 * concern each — and the element proxy's set/delete/get traps are the SAME
 * leaves the nested and terminal object proxies use (`writeTraps.ts`,
 * `liveView.ts`), over an {@link elementSink}. A fix lands in a leaf once.
 */

import { shouldWrapWithProxy } from './allowlist.js';
import { rememberHandle, unwrapHandles } from './handles.js';
import { liveGetTrap, liveInspectionTraps, liveObject, MemberCache } from './liveView.js';
import {
  type WriteSink,
  elementSink,
  isAssignmentDescriptor,
  refuseDoor,
  sinkDeleteTrap,
  sinkDoorTraps,
  sinkSetTrap,
} from './writeTraps.js';

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

type Read = () => unknown[];
type Write = (next: unknown[]) => void;

// -- Leaves: reads ------------------------------------------------------------

/** WHY `Number(prop)`: the historical reading of an index name — `'01'` and
 *  `''` address slots 1 and 0, as they always have. In range only. */
function indexIn(current: unknown[], prop: string | symbol): number | undefined {
  if (typeof prop !== 'string') return undefined;
  const index = Number(prop);
  return Number.isInteger(index) && index >= 0 && index < current.length ? index : undefined;
}

/** A non-negative integer index named by `prop` (any range — a write past the end grows the array). */
function indexNamed(prop: string | symbol): number | undefined {
  if (typeof prop !== 'string') return undefined;
  const index = Number(prop);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** WHY: a non-mutating read answers from the CURRENT array, never the
 *  creation-time target — a method is bound to it, anything else read off it. */
function boundMember(current: unknown[], prop: string | symbol): unknown {
  const val = (current as any)[prop];
  return typeof val === 'function' ? val.bind(current) : val;
}

type ElementCache = Map<number, { ref: unknown; proxy: unknown }>;

/** WHY the cache: reading `lines[i].qty` in a loop must not allocate a proxy
 *  per read, and `lines[0] === lines[0]` must hold within a stage. Validated by
 *  raw identity — a commit replaces the array, the ref check misses, and a
 *  fresh proxy is built over the new element. A primitive is handed back raw. */
function cachedElement(
  cache: ElementCache,
  element: unknown,
  index: number,
  read: Read,
  forWrite: Read,
  write: Write,
  name: string,
): unknown {
  if (!shouldWrapWithProxy(element)) return element;
  const cached = cache.get(index);
  if (cached && cached.ref === element) return cached.proxy;
  const wrapped = wrapElementMember(element, elementSink(read, write, index, name, forWrite), [], new Set<object>());
  cache.set(index, { ref: element, proxy: wrapped });
  return wrapped;
}

// -- Leaves: writes -----------------------------------------------------------

/** Slots from the current end up to (not including) `upTo` become `null` —
 *  the JSON spelling of a hole, which is what the whole-array round-trip used
 *  to produce for them. No-op when `upTo` is within the array. */
function fillHoles(arr: unknown[], upTo: number): void {
  for (let i = arr.length; i < upTo; i++) arr[i] = null;
}

/** WHY: a mutating method runs on a COPY, with its arguments taken as values
 *  (a handle becomes what it stands for; a number or a comparator passes
 *  through), and the copy is committed whole. The array in state is never
 *  touched. */
function mutatingMethod(read: Read, write: Write, name: string): (...args: unknown[]) => unknown {
  return (...args) => {
    const clone = [...read()];
    const result = (clone as any)[name](...args.map(unwrapHandles));
    write(clone);
    return result;
  };
}

/** `arr[i] = v`: copy, `null` the slots a write past the end skips, place the value as assigned, commit. */
function setIndex(read: Read, write: Write, index: number, value: unknown): void {
  const clone = [...read()];
  fillHoles(clone, index);
  clone[index] = unwrapHandles(value);
  write(clone);
}

/** `arr.length = n`: copy, `null` the slots growth adds, truncate or extend, commit. */
function setLength(read: Read, write: Write, length: number): void {
  const clone = [...read()];
  fillHoles(clone, length);
  clone.length = length;
  write(clone);
}

/** WHY: without this trap `delete items[2]` reaches the RAW array captured
 *  as the proxy target — committed state, no commit record. JS `delete` on an
 *  index leaves the slot empty and the length unchanged, and so does this:
 *  the emptied slot commits as `null`, JSON's only spelling for a hole.
 *  A delete that changes nothing (an index out of range, a property the
 *  array does not own) writes nothing: no row, no onWrite. */
function deleteSlot(read: Read, write: Write, prop: string | symbol): void {
  const current = read();
  const index = typeof prop === 'string' ? Number(prop) : NaN;
  const inRange = Number.isInteger(index) && index >= 0 && index < current.length;
  if (!inRange && !Object.prototype.hasOwnProperty.call(current, prop)) return;
  const clone = [...current];
  if (inRange) clone[index] = null;
  else delete (clone as any)[prop];
  write(clone);
}

// -- Leaves: the chain below an element --------------------------------------

/**
 * WHY: an array anywhere below a sink's root is ONE write path — it reads
 * through the sink and commits the WHOLE new array back through it, so
 * `push` three levels down and `arr[i].x = v` at the top share a funnel.
 */
export function arrayProxyAt(sink: WriteSink, path: readonly string[], captured: unknown[]): unknown[] {
  return createArrayProxy(
    () => sink.readAt(path) as unknown[],
    (next) => sink.put(path, next),
    sink.nameOf(path),
    captured,
  );
}

/**
 * WHY TWO READERS: an array handle can outlive the array it was built over.
 * After `scope.list = 'xy'` (or `delete scope.list`) in the same stage, a held
 * `list` handle used to treat the new value as if it were an array: `push`
 * spread the string into `["x","y","z"]`, a removed key became `[]`, and
 * `length` answered the string's length.
 *
 * THE DECISION is the one a held OBJECT handle already follows (`liveView.ts ·
 * liveObject`): READS answer from the current value while the key holds an
 * array, and from the array the handle was made over once it does not. So
 * `const items = scope.items; scope.items = undefined; for (const i of items)`
 * walks the items the author took, and a held object answers its array
 * members the same way its JSON does. WRITES have nothing to change once the
 * key holds no array, and committing one would put old items back or lose the
 * new value, so they are refused ({@link writableArray}).
 *
 * NOT DONE: refusing reads too. The first cut of this fix did; it made a plain
 * read of a member of a held object throw, where that object's own fields
 * still answered.
 */
function liveArray(getCurrent: () => unknown, captured: unknown[]): Read {
  return () => {
    const current = getCurrent();
    return Array.isArray(current) ? current : captured;
  };
}

/** The current array, for a WRITE: refused once the key no longer holds an array ({@link liveArray} says why). */
function writableArray(getCurrent: () => unknown, name: string): Read {
  return () => {
    const current = getCurrent();
    if (Array.isArray(current)) return current;
    throw new TypeError(
      (name
        ? `Cannot write through the array handle for '${name}': the key no longer holds an array.`
        : 'Cannot write through this array handle: its value is no longer an array.') +
        ' The handle still reads the array as it was. Read the key from the scope again to change it.',
    );
  };
}

/**
 * Wrap a value read out of an element: arrays become array proxies whose
 * commits route back through the owning array, plain objects become element
 * proxies one level deeper, everything else is returned as-is. A value already
 * on the access chain (a cycle) is returned raw — the same back-edge the
 * nested-object terminal proxy takes.
 */
function wrapElementMember(value: unknown, sink: WriteSink, path: string[], visited: Set<object>): unknown {
  if (!shouldWrapWithProxy(value)) return value;
  if (visited.has(value as object)) return value;
  const branch = new Set(visited);
  branch.add(value as object);
  if (Array.isArray(value)) return arrayProxyAt(sink, path, value);
  return createElementProxy(value as Record<string, unknown>, sink, path, branch);
}

// -- Orchestrators ------------------------------------------------------------

/**
 * Proxy over one OBJECT element (or an object nested inside one), carrying the
 * path from the element down to it. Reads recurse; writes go back out through
 * the owning array's commit callback (the {@link elementSink}).
 *
 * READS ARE LIVE. Every write rebuilds the array immutably, so the object the
 * proxy was created over is the PRE-write element for ever after; a held
 * handle that read from it saw its own writes vanish (`line.n += 1` twice
 * gave 2, `line.total = line.qty * 10` used the old `qty`, `'x' in line` was
 * false right after `line.x = 1`). Every trap therefore resolves the element
 * through the sink first, and falls back to the captured object only when
 * the path no longer exists (the slot was emptied or the array shrank) — the
 * same read-your-writes the array proxy itself has always had, and the same
 * law the nested and terminal object proxies follow (liveView.ts).
 */
function createElementProxy(
  raw: Record<string, unknown>,
  sink: WriteSink,
  segments: readonly string[],
  visited: Set<object>,
): unknown {
  const members = new MemberCache();
  const live = () => liveObject(raw, sink.readAt(segments));
  return rememberHandle(
    new Proxy(raw, {
      get: liveGetTrap(live, segments, (value, path) => wrapElementMember(value, sink, path, visited), members),
      set: sinkSetTrap(sink, segments),
      deleteProperty: sinkDeleteTrap(sink, segments),
      ...sinkDoorTraps(sink, segments),
      ...liveInspectionTraps(live),
    }),
    live,
  );
}

/**
 * Creates a Proxy over an array that intercepts mutating operations.
 *
 * The actual current array is the Proxy target: Node.js console.log inspects
 * the target directly (bypasses Proxy traps), so the real array shows correct
 * values. The target reference is fixed at creation time — after mutations,
 * the proxy returns a new proxy (via cache invalidation) with the fresh array
 * as target.
 *
 * READS are live while the key holds an array and answer from the array the
 * handle was made over once it does not; WRITES are refused then, with a
 * `TypeError` that names the key (see {@link liveArray}).
 *
 * @param getCurrent - Returns the current array snapshot from state
 * @param commit - Called with the new array after a mutation (triggers setValue)
 * @param name - The value's name in state, used in error messages
 * @param captured - The array the handle is made over, when the caller already
 *   holds it (a member read off a captured object whose path is gone). Default:
 *   what `getCurrent` returns now.
 * @returns Proxied array with copy-on-write semantics
 */
export function createArrayProxy<T>(
  getCurrent: () => T[],
  commit: (newArray: T[]) => void,
  name = '',
  captured?: T[],
): T[] {
  const target = (captured ?? writableArray(getCurrent, name)()) as T[];
  const read = liveArray(getCurrent, target);
  const forWrite = writableArray(getCurrent, name);
  const write = commit as unknown as Write;
  const elements: ElementCache = new Map();

  // The array handle's value is the array it reads (handles.ts).
  return rememberHandle(
    new Proxy(target, {
      get(_target, prop) {
        if (typeof prop === 'string' && MUTATING_METHODS.has(prop)) return mutatingMethod(forWrite, write, prop);
        const current = read();
        if (prop === 'length') return current.length;
        const index = indexIn(current, prop);
        if (index !== undefined) return cachedElement(elements, current[index], index, read, forWrite, write, name);
        if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => current;
        return boundMember(current, prop);
      },
      set(_target, prop, value) {
        const index = indexNamed(prop);
        if (index !== undefined) setIndex(forWrite, write, index, value);
        else if (prop === 'length' && typeof value === 'number') setLength(forWrite, write, value);
        return true; // any other set is ignored (an expando on an array is out of contract — README)
      },
      deleteProperty(_target, prop) {
        deleteSlot(forWrite, write, prop);
        return true;
      },
      // The other write doors (writeTraps.ts): an index or `length` define that is an assignment is one.
      defineProperty(target, prop, descriptor) {
        if (typeof prop !== 'string') return Reflect.defineProperty(target, prop, descriptor);
        const index = indexNamed(prop);
        const exists = Object.prototype.hasOwnProperty.call(forWrite(), prop);
        const assignable = index !== undefined || (prop === 'length' && typeof descriptor.value === 'number');
        if (!assignable || !isAssignmentDescriptor(descriptor, exists)) {
          refuseDoor('define a property with special attributes', prop);
        }
        if (index !== undefined) setIndex(forWrite, write, index, descriptor.value);
        else setLength(forWrite, write, descriptor.value as number);
        return true;
      },
      setPrototypeOf() {
        return refuseDoor('change the prototype of an array', '');
      },
      preventExtensions() {
        return refuseDoor('freeze, seal or lock an array', '');
      },
      has: (_target, prop) => Reflect.has(read(), prop),
      ownKeys: () => Reflect.ownKeys(read()),
      getOwnPropertyDescriptor: (_target, prop) => Object.getOwnPropertyDescriptor(read(), prop),
    }),
    read,
  );
}
