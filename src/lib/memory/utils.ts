/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */

import { nativeGet as _get, nativeHas as _has, nativeSet as _set } from './pathOps.js';
import type { MemoryPatch } from './types.js';

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
 * Deep union merge helper.
 * - Arrays (non-empty): union without duplicates (encounter order preserved)
 * - Arrays (empty):     replace — src `[]` clears the destination array.
 *   Rationale: writing `scope.tags = []` means "clear tags", not "append nothing".
 *   Without this rule, an empty-array write silently becomes a no-op which is
 *   impossible to distinguish from a bug.
 * - Objects: recursive merge
 * - Primitives: source wins
 */
export function deepSmartMerge(dst: any, src: any): any {
  if (src === null || typeof src !== 'object') return src;

  if (Array.isArray(src)) {
    if (src.length === 0) return []; // empty src = clear, not no-op
    if (Array.isArray(dst)) return [...new Set([...dst, ...src])];
    return [...src];
  }

  const out: any = { ...(dst && typeof dst === 'object' ? dst : {}) };
  // Object.keys() is own-enumerable-only by spec — no DENIED check needed here.
  for (const k of Object.keys(src)) {
    out[k] = deepSmartMerge(out[k], src[k]);
  }
  return out;
}

/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Two-phase: UPDATE (union-merge) then OVERWRITE (direct set).
 * Guarantees "last writer wins" semantics.
 */
export function applySmartMerge(
  base: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: { path: string; verb: 'set' | 'merge' }[],
): any {
  const out = structuredClone(base);
  for (const { path, verb } of trace) {
    const segs = path.split(DELIM);
    if (verb === 'set') {
      _set(out, segs, structuredClone(_get(overwrite, segs)));
    } else {
      const current = _get(out, segs) ?? {};
      _set(out, segs, deepSmartMerge(current, _get(updates, segs)));
    }
  }
  return out;
}
