/**
 * utils.ts — nested-object helpers for the heap, and the memory leaves' one
 * re-export surface.
 *
 * The helpers here (`setNestedValue`, `updateNestedValue`, `updateValue`,
 * `getNestedValue`, `redactPatch`) walk a nested object by path with
 * prototype-pollution protection. Everything else this file used to hold has an
 * owner of its own and is re-exported, so no importer moved: the path codec
 * (`paths.ts`), structural equality (`equality.ts`) and the union merge
 * (`merge.ts`) at L0, and the verb law (`verbs.ts`) at L1 — `applySmartMerge`,
 * `nextGeneration`, `applySmartMergeInto`, `dryFold`, `supersededByNextSet`.
 * Zero external dependencies.
 */

import { nativeGet as _get, nativeHas as _has, nativeSet as _set } from './pathOps.js';
import { DELIM } from './paths.js';
import { LOG_PLACEHOLDER } from './placeholders.js';
import type { MemoryPatch } from './types.js';

export { deepEqual } from './equality.js';
export { deepSmartMerge } from './merge.js';
export { DELIM, normalisePath, pathSegments } from './paths.js';
export { applySmartMerge, applySmartMergeInto, dryFold, nextGeneration, supersededByNextSet } from './verbs.js';

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
        _set(out, pathArr, LOG_PLACEHOLDER);
      }
    }
  }
  return out;
}
