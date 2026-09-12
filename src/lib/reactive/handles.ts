/**
 * reactive/handles — which objects are the scope's HANDLES, and the value
 * behind each.
 *
 * Every object the typed scope hands back is a Proxy bound to its stage
 * (reactive/README.md, "A handle is bound to its stage"): inside the stage
 * that is what makes a deep write commit and a held read stay live. A handle
 * can also TRAVEL out of the stage in the library's own hands — an
 * `addParallelForEach` items selector returns the array handle and its
 * elements become the generated branch inputs; a subflow `inputMapper` or
 * `outputMapper` hands one on; `$setValue('copy', scope.customer)` hands one
 * back. Wherever the engine RECORDS a value it clones it (`structuredClone`,
 * at commit since 9.23.0), and a Proxy cannot be cloned: `DataCloneError`,
 * the stage's writes lost. 9.22.0–9.23.2 lost every child of a fan-out over
 * object items that way (9.23.3).
 *
 * LAW: a handle the scope handed out is a value the engine accepts back.
 * Each proxy factory registers its handle here with the same live reader its
 * get trap uses, so the value behind a handle is what a read of it would
 * return NOW — and the engine asks {@link unwrapHandles} at every boundary
 * where app code hands it a value to record. O(1) for a handle (a WeakMap
 * lookup, no walk, no JSON round-trip: a `Date` stays a `Date`); a walk only
 * for a plain container the app built around handles, copy-on-write so a
 * handle-free value comes back as the SAME reference.
 *
 * The value behind a handle is BORROWED — the same reference a read hands
 * back, cloned by the buffer at commit. Never mutate it (the reads law).
 */

/** Every handle the four proxy factories built, mapped to its live reader. */
const LIVE = new WeakMap<object, () => unknown>();

/** Register `handle` as a scope handle whose current value `live` returns. Returns the handle. */
export function rememberHandle<T extends object>(handle: T, live: () => unknown): T {
  LIVE.set(handle, live);
  return handle;
}

/** Is `value` a handle the scope handed out? */
export function isHandle(value: unknown): value is object {
  return value !== null && typeof value === 'object' && LIVE.has(value);
}

/** The live value behind a handle; `value` itself when it is not one. O(1). */
export function valueBehind(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const live = LIVE.get(value);
  return live === undefined ? value : live();
}

/** A plain object or array — the only containers the walk enters (a `Date`, `Map` or class instance is a leaf). */
function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `value` with every handle inside it replaced by the value behind it.
 *
 * A handle is replaced in O(1) and NOT entered (the state behind it holds no
 * handles — they are built on read, never stored). A plain container is
 * walked and copied ONLY when something inside it changed, so a handle-free
 * value is returned as the same reference and a hand-built `{ item, index }`
 * around one handle costs one object. Anything else (a `Date`, a `Map`, a
 * class instance, a primitive) is a leaf. A cycle among plain containers is
 * left as it is — `structuredClone` handles cycles; only a Proxy stops it.
 */
export function unwrapHandles<T>(value: T): T {
  return walk(value, new Set()) as T;
}

function walk(value: unknown, onPath: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const live = LIVE.get(value);
  if (live !== undefined) return live();
  if (!isPlainContainer(value) || onPath.has(value)) return value;
  onPath.add(value);
  const out = Array.isArray(value) ? walkArray(value, onPath) : walkObject(value, onPath);
  onPath.delete(value);
  return out;
}

function walkArray(value: unknown[], onPath: Set<object>): unknown[] {
  let copy: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const next = walk(value[i], onPath);
    if (next === value[i]) continue;
    copy ??= [...value];
    copy[i] = next;
  }
  return copy ?? value;
}

function walkObject(value: Record<string, unknown>, onPath: Set<object>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const next = walk(value[key], onPath);
    if (next === value[key]) continue;
    copy ??= { ...value };
    copy[key] = next;
  }
  return copy ?? value;
}
