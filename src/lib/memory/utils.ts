/**
 * utils.ts — nested-object helpers for the heap, and the memory leaves' one
 * re-export surface.
 *
 * The helpers here (`setNestedValue`, `updateNestedValue`, `updateValue`,
 * `getNestedValue`) walk a nested object by path with
 * prototype-pollution protection. Everything else this file used to hold has an
 * owner of its own and is re-exported, so no importer moved: the path codec
 * (`paths.ts`), structural equality (`equality.ts`) and the union merge
 * (`merge.ts`) at L0, and the verb law (`verbs.ts`) at L1 — `applySmartMerge`,
 * `nextGeneration`, `applySmartMergeInto`, `dryFold`, `supersededByNextSet`.
 * The log's scrub, `redactPatch`, moved to its owner `redaction.ts` in 9.33.0.
 * The writers take an ADDRESS, a path prefix their caller computed, and never
 * name one (C2: the engine decides where a stage writes, `StageContext · address`).
 * Zero external dependencies.
 */

import { nativeGet as _get, nativeHas as _has, nativeSet as _set } from './pathOps.js';
import { DELIM } from './paths.js';
import type { MemoryPatch } from './types.js';

export { deepEqual } from './equality.js';
export { deepSmartMerge } from './merge.js';
export { DELIM, normalisePath, pathSegments } from './paths.js';
export { applySmartMerge, applySmartMergeInto, dryFold, nextGeneration, supersededByNextSet } from './verbs.js';

type NestedObject = { [key: string]: any };

/**
 * The two places a value at `path` can sit: under `address` (`runPath`, absent
 * for the root address `[]`) and at the root (`globalPath`). `address` is a
 * path prefix the caller computed — for the engine, a frame's run namespace
 * (`StageContext · address`, C2).
 */
export function getRunAndGlobalPaths(address: readonly string[] = [], path: (string | number)[] = []) {
  return {
    runPath: address.length > 0 ? [...address, ...path] : undefined,
    globalPath: [...path],
  };
}

/**
 * The container at `address` + `path` inside `obj`, each missing one created
 * on the way: the one AT the address from `defaultValues` when given, every
 * other one empty. The one walk both nested writers share.
 */
function containerAt(
  obj: NestedObject,
  address: readonly string[] = [],
  path: readonly (string | number)[] = [],
  defaultValues?: unknown,
): NestedObject {
  const segments = [...address, ...path];
  let current = obj;
  for (let i = 0; i < segments.length; i++) {
    const key = segments[i];
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = i === address.length - 1 && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }
  return current;
}

/**
 * Sets a value at a nested path under `address`, creating intermediate objects as needed.
 */
export function setNestedValue<T>(
  obj: NestedObject,
  address: readonly string[],
  path: string[],
  field: string,
  value: T,
  defaultValues?: unknown,
): NestedObject {
  containerAt(obj, address, path, defaultValues)[field] = value;
  return obj;
}

/**
 * Deep-merges a value into the object at a nested path under `address`.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
export function updateNestedValue<T>(
  obj: any,
  address: readonly string[],
  path: (string | number)[],
  field: string | number,
  value: T,
  defaultValues?: unknown,
): any {
  updateValue(containerAt(obj, address, path, defaultValues), field, value);
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
