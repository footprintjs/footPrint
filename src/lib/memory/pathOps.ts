/**
 * pathOps.ts — Native nested-path helpers (replaces lodash.get/set/has/mergewith)
 *
 * Security contract: all functions guard against prototype-pollution and
 * prototype-chain-read attacks. The DENIED set blocks the three canonical
 * pollution vectors (__proto__, constructor, prototype) on every function.
 *
 * Intentional asymmetry:
 *   - nativeSet  — DENIED check only at each segment. No hasOwnProperty
 *     check is needed because writing always creates an OWN property on `curr`,
 *     which cannot pollute the prototype chain.
 *   - nativeGet / nativeHas — DENIED check + hasOwnProperty at every step.
 *     Reads follow the prototype chain by default (bracket notation), so the
 *     hasOwnProperty guard is required to prevent leaking inherited values
 *     (e.g. Object.prototype, Object constructor, toString).
 *   - mergeContextWins — DENIED check only; Object.keys() is own-enumerable-only
 *     by spec so prototype keys never appear in the iteration.
 *
 * Do NOT "fix" the nativeSet asymmetry by adding hasOwnProperty — it is
 * intentional and would break path creation for new intermediate nodes.
 *
 * Paths may be dot-notation strings or pre-split (string|number)[] arrays.
 */

const DENIED = new Set(['__proto__', 'constructor', 'prototype']);

function toSegments(path: string | (string | number)[]): (string | number)[] {
  return Array.isArray(path) ? path : path.split('.');
}

/**
 * Get the value at `path` in `obj`, returning `defaultValue` if absent.
 *
 * Security: each path segment is checked against the DENIED list and requires
 * an own property at every step, preventing prototype-chain reads.
 * e.g. nativeGet({}, '__proto__') and nativeGet({}, 'constructor') both return
 * `defaultValue` instead of leaking Object.prototype / the Object constructor.
 */
export function nativeGet(obj: any, path: string | (string | number)[], defaultValue?: any): any {
  const segs = toSegments(path);
  let curr = obj;
  for (const seg of segs) {
    if (curr == null) return defaultValue;
    if (DENIED.has(String(seg))) return defaultValue;
    if (!Object.prototype.hasOwnProperty.call(curr, seg)) return defaultValue;
    curr = curr[seg];
  }
  return curr === undefined ? defaultValue : curr;
}

/** Mutate `obj`, setting `value` at `path` (creates intermediate objects). Returns `obj`. */
export function nativeSet(obj: any, path: string | (string | number)[], value: any): any {
  const segs = toSegments(path);
  let curr = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (DENIED.has(String(k))) return obj;
    if (curr[k] == null || typeof curr[k] !== 'object') {
      curr[k] = typeof segs[i + 1] === 'number' ? [] : {};
    }
    curr = curr[k];
  }
  const last = segs[segs.length - 1];
  if (DENIED.has(String(last))) return obj;
  curr[last] = value;
  return obj;
}

/**
 * Remove the own property at `path` in `obj` (the replay primitive for the
 * `delete` commit verb, #13c-B). No-op when any intermediate segment is
 * missing — deleting an absent key has nothing to remove.
 *
 * Security: same DENIED + hasOwnProperty discipline as nativeGet — every
 * segment is checked, so `nativeDelete(obj, '__proto__x')` and
 * prototype-chain walks are inert.
 */
export function nativeDelete(obj: any, path: string | (string | number)[]): void {
  const segs = toSegments(path);
  let curr = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (DENIED.has(String(seg))) return;
    if (curr == null || typeof curr !== 'object' || !Object.prototype.hasOwnProperty.call(curr, seg)) return;
    curr = curr[seg];
  }
  const last = segs[segs.length - 1];
  if (DENIED.has(String(last))) return;
  if (curr != null && typeof curr === 'object') {
    delete curr[last];
  }
}

/**
 * PROTOTYPE instrumentation (design 2026-10-copy-on-write-commit): how many
 * containers the path copier copied and how many slots those copies held.
 * Read by `bench/commit-clones.ts`; not part of the design.
 */
const pathCopyStats = { containers: 0, slots: 0 };
(globalThis as { __fpPathCopyStats?: typeof pathCopyStats }).__fpPathCopyStats = pathCopyStats;

/** A container a writer may own: anything `typeof 'object'` and not null. */
function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** True for the own keys of an array that are not indices (`arr.note = …`). */
function isArrayIndexKey(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && String(n) === key;
}

/**
 * A SHALLOW copy of one container that keeps every slot a deep clone keeps:
 * a plain object's own enumerable keys in their order (spread, so an own
 * `__proto__` key stays a key); an array's indices, holes, length AND any
 * named property a nested write hung off it (`slice` alone would drop those).
 * Anything else — a `Date`, `Map`, `Set`, typed array, a caller's class
 * instance — is deep-cloned, which is exactly what the whole-state clone did
 * to it before; such a container on a write path is rare.
 */
export function shallowCopy<T extends object>(container: T): T {
  if (Array.isArray(container)) {
    const copy = container.slice() as unknown as Record<string, unknown>;
    const keys = Object.keys(container);
    if (keys.length !== container.length) {
      for (const key of keys)
        if (!isArrayIndexKey(key)) copy[key] = (container as unknown as Record<string, unknown>)[key];
    }
    pathCopyStats.containers += 1;
    pathCopyStats.slots += container.length;
    return copy as unknown as T;
  }
  const proto = Object.getPrototypeOf(container);
  if (proto === Object.prototype || proto === null) {
    const copy = proto === null ? Object.assign(Object.create(null), container) : { ...container };
    pathCopyStats.containers += 1;
    pathCopyStats.slots += Object.keys(copy).length;
    return copy as T;
  }
  pathCopyStats.containers += 1;
  return structuredClone(container);
}

/**
 * Make the containers on the way to `path`'s LEAF ones the writer owns, so
 * the write that follows (`nativeSet` / `nativeDelete` / a verb arm) edits
 * nothing it did not create.
 *
 * `root` must already be owned. Walking down, every container the writer did
 * not create (`owned` does not hold it) is replaced, in its parent, by its
 * {@link shallowCopy}, which the writer then owns. The walk stops where
 * `nativeSet` would stop or create: a DENIED segment (the write is refused
 * there anyway), or a missing / primitive intermediate (`nativeSet` makes a
 * fresh container from that point on). The leaf itself is never copied — the
 * write replaces it.
 *
 * Cost: one shallow copy per container on the path that this writer has not
 * already copied — O(depth × width), independent of everything the write
 * does not pass through. A path of one segment (a root key, the common case)
 * copies nothing here.
 */
export function ownSpine(root: any, path: string | (string | number)[], owned: WeakSet<object>): void {
  const segs = toSegments(path);
  let curr = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (DENIED.has(String(k))) return;
    const next = curr[k];
    if (!isContainer(next)) return;
    if (owned.has(next)) {
      curr = next;
      continue;
    }
    const copy = shallowCopy(next);
    owned.add(copy);
    curr[k] = copy;
    curr = copy;
  }
}

/**
 * The root of a new generation: a shallow copy of `base` when it is a
 * container (owned by the writer), else the historical deep clone of a
 * non-container base (`undefined`, a primitive) so the callers' behaviour on
 * such a base is unchanged.
 */
export function ownedRootOf(base: any, owned?: WeakSet<object>): any {
  if (!isContainer(base)) return structuredClone(base);
  const root = shallowCopy(base);
  owned?.add(root);
  return root;
}

/** Mark a value the writer just created (a fresh clone, a merge result) as owned. */
export function own(value: unknown, owned: WeakSet<object> | undefined): void {
  if (owned !== undefined && isContainer(value)) owned.add(value);
}

/**
 * Freeze every container of a committed generation that is not frozen yet —
 * the containers THIS commit created; everything it shares with the previous
 * generation was frozen when that generation was committed, so the walk stops
 * there and costs O(new containers), not O(state). Dev-mode guard (design
 * 2026-10): an in-place mutation of committed state then throws at the
 * mutation site. `Map`/`Set` entries and `Date` internals cannot be frozen —
 * the borrowed-mutation warning stays the guard for those.
 */
export function freezeNew(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (!isContainer(v) || Object.isFrozen(v)) continue;
    // A typed array / DataView with elements cannot be frozen (Object.freeze
    // throws) — and it holds no containers, so there is nothing below it.
    if (ArrayBuffer.isView(v)) continue;
    Object.freeze(v);
    if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x);
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
    } else {
      for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key]);
    }
  }
}

/** Returns true if `obj` has an own property at every segment of `path`. */
export function nativeHas(obj: any, path: string | (string | number)[]): boolean {
  const segs = toSegments(path);
  let curr = obj;
  for (let i = 0; i < segs.length; i++) {
    if (curr == null || !Object.prototype.hasOwnProperty.call(curr, segs[i])) return false;
    if (i < segs.length - 1) curr = curr[segs[i]];
  }
  return true;
}

/**
 * Deep merge where destination wins for any defined value.
 * Fills missing keys from `src`, but never overwrites defined keys in `dst`.
 * Arrays are not recursed — dst array always wins when present.
 *
 * Replaces: `mergeWith(dst, src, (objValue) => objValue !== undefined ? objValue : undefined)`
 */
export function mergeContextWins(dst: any, src: any): any {
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return dst !== undefined ? dst : src;
  }
  const out: any = dst != null && typeof dst === 'object' ? { ...dst } : {};
  for (const key of Object.keys(src)) {
    if (DENIED.has(key)) continue;
    const dstVal = out[key];
    if (dstVal !== undefined) {
      // dst wins; recurse only if both sides are plain objects
      if (
        dstVal !== null &&
        typeof dstVal === 'object' &&
        !Array.isArray(dstVal) &&
        src[key] !== null &&
        typeof src[key] === 'object' &&
        !Array.isArray(src[key])
      ) {
        out[key] = mergeContextWins(dstVal, src[key]);
      }
      // else keep dstVal unchanged
    } else {
      out[key] = src[key];
    }
  }
  return out;
}
