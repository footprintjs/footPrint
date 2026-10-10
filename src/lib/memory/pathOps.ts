/**
 * pathOps.ts — Native nested-path helpers (replaces lodash.get/set/has/mergewith)
 *
 * The DENIED set is the shared rule for three prototype-pollution selector
 * segments (__proto__, constructor, prototype). Each operation's traversal
 * contract is explicit below; merely using this module is not a sandbox.
 *
 * Selector operations read only own fields. Writers preflight the whole path
 * before creating or copying any container, then place through putOwn.
 *   - nativeGet — DENIED check + hasOwnProperty at every step.
 *   - nativeHas — own-property existence only, including own denied names
 *     and own undefined values; it does not use the DENIED rule.
 *   - mergeContextWins — own-enumerable source keys, DENIED check, own-only
 *     destination precedence. Inherited fields are never destination data.
 *
 * Diagnostic writers retain their distinct creation/merge laws in utils.ts,
 * using the same isDeniedSegment predicate and shared own-slot writer.
 *
 * Paths may be dot-notation strings or pre-split (string|number)[] arrays.
 */

import { putOwn } from '../capture/ownData.js';

const DENIED = new Set(['__proto__', 'constructor', 'prototype']);

/** Is `segment` one of the three denied prototype-pollution selector names? */
export function isDeniedSegment(segment: string | number): boolean {
  return DENIED.has(String(segment));
}

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

/**
 * Set an own path in a writer-owned container, creating missing intermediates.
 * A denied selector is a no-op BEFORE any prefix is created. Inherited values
 * and accessors do not participate; existing own accessors keep normal behavior.
 */
export function nativeSet(obj: any, path: string | (string | number)[], value: any): any {
  const segs = toSegments(path);
  if (segs.some(isDeniedSegment)) return obj;
  let curr = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    // Do not read an inherited accessor. For an OWN accessor, retain the
    // original null/type/traversal read sequence (including getter calls).
    if (!Object.prototype.hasOwnProperty.call(curr, k) || curr[k] == null || typeof curr[k] !== 'object') {
      putOwn(curr, k, typeof segs[i + 1] === 'number' ? [] : {});
    }
    curr = curr[k];
  }
  const last = segs[segs.length - 1];
  putOwn(curr, last, value);
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

// ── Copy-on-write primitives (docs/design/2026-10-copy-on-write-commit.md) ──
//
// THE LAW: a committed generation is never edited. A writer copies the root
// and every container on each path it writes, edits only containers it
// created during the current operation (its `owned` set), and shares every
// other subtree with the generation before it. The same law
// `reactive/structuralWrite.ts · setInPath` applies to a single value.

/** A container a writer may own: anything `typeof 'object'` and not null. */
export function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * `parent[key]` when `parent` is a container that OWNS `key` — the slot
 * {@link nativeGet} would read, refusing the same prototype-pollution
 * segments — else `undefined`. One step of a path walk.
 */
export function ownChild(parent: unknown, key: string | number): unknown {
  return isContainer(parent) && !DENIED.has(String(key)) && Object.prototype.hasOwnProperty.call(parent, key)
    ? (parent as Record<string | number, unknown>)[key]
    : undefined;
}

/** True for an own key of an array that is an array INDEX (`'0'`, `'12'`), not a name (`arr.note`). */
function isArrayIndexKey(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key;
}

/**
 * The named (non-index) own keys of an array, in order. Own-key order puts
 * every index first, ascending, and names after them — so the names are the
 * tail of `Object.keys`, and an array without any is told by its last key.
 */
function namedArrayKeys(array: unknown[]): string[] {
  const keys = Object.keys(array);
  let first = keys.length;
  while (first > 0 && !isArrayIndexKey(keys[first - 1])) first--;
  return keys.slice(first);
}

/**
 * A SHALLOW copy of one container that keeps every slot the whole-state
 * `structuredClone` this replaced kept — so a path copy and a deep clone give
 * the same value at every path:
 *   - a plain object (or a null-prototype one): its own enumerable keys, in
 *     order, by spread — an own `__proto__` key stays a key; the result has
 *     `Object.prototype`, as a clone's does;
 *   - an array: its indices, holes and length (`slice`) AND any named
 *     property a nested write hung off it (`slice` alone would drop those);
 *   - anything else — a `Date`, `Map`, `Set`, typed array, a class instance —
 *     is deep-cloned, which is what the whole-state clone did to it; and the
 *     own enumerable properties the clone cannot carry (an expando a nested
 *     write hung on a `Date`) are carried over by reference, so a later write
 *     through it changes exactly its own path. Rare on a write path.
 */
export function shallowCopy<T extends object>(container: T): T {
  if (Array.isArray(container)) {
    const copy = container.slice() as unknown as Record<string, unknown>;
    for (const key of namedArrayKeys(container))
      putOwn(copy, key, (container as unknown as Record<string, unknown>)[key]);
    return copy as unknown as T;
  }
  const proto = Object.getPrototypeOf(container);
  if (proto === Object.prototype || proto === null) return { ...container };
  const copy = structuredClone(container) as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    if (!Object.prototype.hasOwnProperty.call(copy, key))
      putOwn(copy, key, (container as Record<string, unknown>)[key]);
  }
  return copy as T;
}

/**
 * Make the containers on the way to `path`'s LEAF ones the writer owns, so
 * the write that follows (`nativeSet` / `nativeDelete` / a verb arm) edits
 * nothing it did not create.
 *
 * `root` must already be owned. Walking down, every container the writer did
 * not create (`owned` does not hold it) is replaced, in its parent, by its
 * {@link shallowCopy}, which the writer then owns. A denied segment anywhere
 * refuses the entire walk before copying. Otherwise the walk stops at a
 * missing / inherited / primitive intermediate (`nativeSet` makes a fresh
 * own container from that point on). The leaf itself is never copied — the
 * write replaces it.
 *
 * Cost: one shallow copy per container on the path that this writer has not
 * already copied — O(depth × width), independent of everything the write
 * does not pass through. A path of one segment (a root key, the common case)
 * copies nothing here.
 */
export function ownSpine(root: any, path: string | (string | number)[], owned: WeakSet<object>): void {
  const segs = toSegments(path);
  if (segs.some(isDeniedSegment)) return;
  let curr = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    const next = ownChild(curr, k);
    if (!isContainer(next)) return;
    if (owned.has(next)) {
      curr = next;
      continue;
    }
    const copy = shallowCopy(next);
    owned.add(copy);
    putOwn(curr, k, copy);
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
 * Mark EVERY container of a tree the writer just created whole (a
 * `structuredClone` result) as owned, so a later write through any of them
 * edits it in place instead of copying it again. Walks own enumerable keys —
 * the slots a path can address; a `Map`'s or `Set`'s entries are not. O(the
 * tree's containers); a container already owned is not walked twice (a cycle
 * inside the clone ends there).
 */
export function adopt(tree: unknown, owned: WeakSet<object>): void {
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!isContainer(value) || owned.has(value)) continue;
    owned.add(value);
    for (const key of Object.keys(value)) stack.push((value as Record<string, unknown>)[key]);
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
    const dstVal = ownChild(out, key);
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
        putOwn(out, key, mergeContextWins(dstVal, src[key]));
      }
      // else keep dstVal unchanged
    } else {
      putOwn(out, key, src[key]);
    }
  }
  return out;
}
