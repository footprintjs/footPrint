/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */

import { nativeDelete, nativeGet as _get, nativeHas as _has, nativeSet as _set } from './pathOps.js';
import type { MemoryPatch, TraceEntry } from './types.js';

/** ASCII Unit-Separator — cannot appear in JS identifiers, invisible in logs. */
export const DELIM = '\u001F';

type NestedObject = { [key: string]: any };

/**
 * Resolves run-namespaced and global paths.
 * Each flowchart execution (run) stores data under `runs/{id}/` to prevent collisions.
 */
export function getRunAndGlobalPaths(runId?: string, path: (string | number)[] = []) {
  return {
    runPath: runId ? ['runs', runId, ...path] : undefined,
    globalPath: [...path],
  };
}

/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 */
export function setNestedValue<T>(
  obj: NestedObject,
  runId: string,
  _path: string[],
  field: string,
  value: T,
  defaultValues?: unknown,
): NestedObject {
  const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
  const path = runPath || globalPath;
  const pathCopy = [...path];
  let current: NestedObject = obj;
  while (pathCopy.length > 0) {
    const key = pathCopy.shift() as string;
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = key === runId && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }
  current[field] = value;
  return obj;
}

/**
 * Deep-merges a value into the object at the specified path.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
export function updateNestedValue<T>(
  obj: any,
  runId: string | undefined,
  _path: (string | number)[],
  field: string | number,
  value: T,
  defaultValues?: unknown,
): any {
  const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
  const path = runPath || globalPath;
  const pathCopy = [...path];
  let current: NestedObject = obj;
  while (pathCopy.length > 0) {
    const key = pathCopy.shift() as string;
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = key === runId && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }
  updateValue(current, field, value);
  return obj;
}

/**
 * In-place value update with merge semantics.
 * - Arrays (non-empty): concatenate onto existing
 * - Arrays (empty):     direct replace — writing `[]` clears the field
 * - Objects (non-empty): shallow merge (spread)
 * - Objects (empty):    direct replace — writing `{}` clears the field
 * - Primitives: direct assignment
 *
 * Note on empty arrays: both `value && Array.isArray(value)` and
 * `Array.isArray(value)` evaluate the same for arrays — `[]` is truthy in
 * JavaScript, so the `&&` guard was never the issue. The actual bug was the
 * concat path: `[...cur, ...[]]` silently returned `cur` unchanged when `value`
 * was `[]`, making `updateValue(obj, 'tags', [])` a no-op instead of a clear.
 * The fix is the explicit `value.length === 0` early-return branch.
 */
export function updateValue(object: any, key: string | number, value: any): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      object[key] = value; // clear: [] replaces whatever was there
    } else {
      const cur = object[key] as any;
      object[key] = cur === undefined ? value : [...cur, ...value];
    }
  } else if (value && typeof value === 'object' && Object.keys(value).length) {
    const cur = object[key] as any;
    object[key] = cur === undefined ? value : { ...cur, ...value };
  } else {
    object[key] = value;
  }
}

/**
 * Gets a value at a nested path with prototype-pollution protection.
 */
export function getNestedValue(root: any, path: (string | number)[], field?: string | number): any {
  const node = path && path.length > 0 ? _get(root, path) : root;
  if (field === undefined || node === undefined) return node;
  if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
    return node[field];
  }
  return undefined;
}

/**
 * Redacts sensitive values in a patch for logging/debugging.
 */
export function redactPatch(patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch {
  const out = structuredClone(patch);
  for (const flat of redactedSet) {
    const pathArr = flat.split(DELIM);
    if (_has(out, pathArr)) {
      const curr = _get(out, pathArr);
      if (typeof curr !== 'undefined') {
        _set(out, pathArr, 'REDACTED');
      }
    }
  }
  return out;
}

/**
 * Normalises an array path into a stable string key using DELIM.
 */
export function normalisePath(path: (string | number)[]): string {
  return path.map(String).join(DELIM);
}

/**
 * Structural deep equality for committed-state values.
 *
 * Used by {@link TransactionBuffer} to decide whether a stage actually CHANGED
 * a path or merely re-wrote / reverted it to the value it already held (a
 * "no-op write"). Committed state is JSON-shaped — it must survive
 * `structuredClone` — so this only needs to handle the shapes that can reach a
 * commit: primitives, arrays, and plain objects.
 *
 * Semantics:
 *   - reference / identical-primitive short-circuits first (cheap fast path)
 *   - `NaN` equals `NaN` (primitive compare falls back to `Object.is`)
 *   - arrays: equal length AND deep-equal element-wise (order-sensitive)
 *   - objects: identical set of keys that HOLD a value AND deep-equal per key.
 *     An own key whose value is `undefined` counts as ABSENT: it is this
 *     library's other spelling of a deleted key (`'full'` mode flattens
 *     `delete` into `key: undefined`; `'delta'` mode's `delete` verb removes
 *     the key), and every consumer — JSON, the fold, `commitValueAt`, the
 *     mirror — reads the two spellings as one state. So must the net-change
 *     filter (9.19.1): `{}` and `{ k: undefined }` are not a change. Arrays
 *     are untouched — a slot holding `undefined` is still a slot.
 *   - mismatched kinds (array vs object, object vs null) → not equal
 *
 * Cost & safety:
 *   - Allocates NOTHING but transient `Object.keys` arrays — no clones. It is
 *     strictly cheaper than the `structuredClone` the commit already performs.
 *   - Primitive comparisons (the bulk of state) are O(1) via the `===` /
 *     `Object.is` fast paths; only nested objects/arrays incur a walk, bounded
 *     by the value's own size.
 *   - Terminates on CYCLIC values (9.18.1): a state value must survive
 *     `structuredClone`, and `structuredClone` preserves cycles — so a
 *     self-referencing value is a legal value, not an out-of-contract one. A
 *     pair of objects already under comparison is treated as equal (the
 *     structural answer, lodash `isEqual` semantics); acyclic inputs see no
 *     change. Dev mode still warns about cycles at write time
 *     (`ScopeFacade.setValue`) because they surprise narrative and JSON.
 */
export function deepEqual(a: any, b: any): boolean {
  return equalPairs(a, b, undefined);
}

/**
 * Object pairs met so far, keyed `a → the b's it has been paired with`. Created
 * lazily by the first object pair, so primitive compares allocate nothing.
 * Never pruned: every `false` returns straight up to the caller (each recursive
 * call short-circuits on it), so nothing is looked up after a mismatch — a
 * stored pair is either still under comparison or already known equal.
 */
type SeenPairs = WeakMap<object, WeakSet<object>>;

function equalPairs(a: any, b: any, seen: SeenPairs | undefined): boolean {
  if (a === b) return true; // same reference or identical primitive
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b; // one is null, the other isn't
  if (typeof a !== 'object') return Object.is(a, b); // NaN-safe primitive compare

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false; // array vs plain object

  // Cycle guard — a pair we are already inside is equal by assumption.
  seen ??= new WeakMap();
  let partners = seen.get(a);
  if (partners?.has(b)) return true;
  if (!partners) seen.set(a, (partners = new WeakSet()));
  partners.add(b);

  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalPairs(a[i], b[i], seen)) return false;
    }
    return true;
  }

  // Objects: only keys that HOLD a value take part — an own `undefined` is a
  // deleted key, the same state as an absent one (see the contract above).
  let aHeld = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    aHeld++;
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!equalPairs(a[key], b[key], seen)) return false;
  }
  let bHeld = 0;
  for (const key of Object.keys(b)) if (b[key] !== undefined) bHeld++;
  return aHeld === bHeld;
}

/**
 * Deep union merge helper.
 * - Arrays (non-empty): union without duplicates (encounter order preserved)
 * - Arrays (empty):     replace — src `[]` clears the destination array.
 *   Rationale: writing `scope.tags = []` means "clear tags", not "append nothing".
 *   Without this rule, an empty-array write silently becomes a no-op which is
 *   impossible to distinguish from a bug.
 * - Objects: recursive merge
 * - Primitives: source wins
 *
 * Terminates on a CYCLIC `src` (9.18.1, same law as {@link deepEqual}: a
 * state value survives `structuredClone`, which preserves cycles). A `src`
 * object re-entered while it is still being merged higher up the stack hands
 * back the output being built for it, so the merged value mirrors the cycle
 * instead of unrolling it forever. Only the ancestors on the stack are
 * guarded — a shared (acyclic) `src` reference met again at a different
 * `dst` merges against THAT `dst`, exactly as before.
 */
export function deepSmartMerge(dst: any, src: any): any {
  return mergeGuarded(dst, src, undefined);
}

function mergeGuarded(dst: any, src: any, inFlight: WeakMap<object, any> | undefined): any {
  if (src === null || typeof src !== 'object') return src;

  if (Array.isArray(src)) {
    if (src.length === 0) return []; // empty src = clear, not no-op
    if (Array.isArray(dst)) return [...new Set([...dst, ...src])];
    return [...src];
  }

  if (inFlight?.has(src)) return inFlight.get(src); // cycle — re-enter the value being built

  const out: any = { ...(dst && typeof dst === 'object' ? dst : {}) };
  (inFlight ??= new WeakMap()).set(src, out);
  // Object.keys() is own-enumerable-only by spec — no DENIED check needed here.
  for (const k of Object.keys(src)) {
    out[k] = mergeGuarded(out[k], src[k], inFlight);
  }
  inFlight.delete(src);
  return out;
}

/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Guarantees "last writer wins" semantics.
 *
 * The single replay primitive — three consumers inherit every verb from it:
 * live state (`SharedMemory.applyPatch`), time travel
 * (`EventLog.materialise`), and the redacted mirror
 * (`StageContext.commit`'s second `applyPatch`).
 *
 * Verb arms:
 *   - `'set'`    — overwrite with `overwrite[path]` (the full final value).
 *   - `'merge'`  — `deepSmartMerge` the accumulated `updates[path]` delta in.
 *   - `'append'` — (#13c-B delta mode) `overwrite[path]` holds ONLY the tail;
 *     reconstruct by concatenating it onto the current array. When the
 *     current value or the recorded tail is not an array (out-of-order
 *     replay base, or a REDACTED tail — `redactPatch` replaces matched
 *     payloads with the `'REDACTED'` string), degrade to a direct set of the
 *     recorded value — the same terminal value a redacted/corrupt `'set'`
 *     produces.
 *   - `'delete'` — (#13c-B delta mode) remove the key (`nativeDelete`,
 *     prototype-pollution-safe). The path stays enumerated in `overwrite`
 *     (value `undefined`) for key-set consumers; replay ignores that value.
 */
export function applySmartMerge(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  const out = structuredClone(base);
  for (const { path, verb } of trace) {
    const segs = path.split(DELIM);
    if (verb === 'set') {
      _set(out, segs, structuredClone(_get(overwrite, segs)));
    } else if (verb === 'append') {
      const tail = structuredClone(_get(overwrite, segs));
      const current = _get(out, segs);
      _set(out, segs, Array.isArray(current) && Array.isArray(tail) ? [...current, ...tail] : tail);
    } else if (verb === 'delete') {
      nativeDelete(out, segs);
    } else {
      const current = _get(out, segs) ?? {};
      _set(out, segs, deepSmartMerge(current, _get(updates, segs)));
    }
  }
  return out;
}
