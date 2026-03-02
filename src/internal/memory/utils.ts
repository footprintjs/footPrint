/**
 * Memory Utilities - Helper functions for nested object manipulation
 * 
 * WHY: The memory system needs to read/write deeply nested paths efficiently.
 * These utilities provide consistent path traversal and value manipulation.
 * 
 * DESIGN: Uses lodash for reliable deep operations while adding pipeline-aware
 * path resolution (pipelines are namespaced under 'pipelines/{pipelineId}/').
 * 
 * RELATED:
 * - {@link WriteBuffer} - Uses these for patch operations
 * - {@link GlobalStore} - Uses these for state access
 */

import _get from 'lodash.get';
import _has from 'lodash.has';
import _set from 'lodash.set';

import { DELIM, MemoryPatch } from './WriteBuffer';

type NestedObject = { [key: string]: any };

/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 * WHY: Enables writing to arbitrary depth without manual object creation.
 * 
 * @param obj - Root object to modify
 * @param pipelineId - Pipeline namespace (values stored under pipelines/{id}/)
 * @param _path - Path segments to the target location
 * @param field - Final field name to set
 * @param value - Value to set
 * @param defaultValues - Default object structure for new pipeline namespaces
 */
export function setNestedValue<T>(
  obj: NestedObject,
  pipelineId: string,
  _path: string[],
  field: string,
  value: T,
  defaultValues?: unknown,
): NestedObject {
  const { pipelinePath, globalPath } = getPipelineAndGlobalPaths(pipelineId, _path);
  // If pipelineID is present update in pipeline else in global
  const path = pipelinePath || globalPath;
  const pathCopy = [...path];
  let current: NestedObject = obj;
  while (pathCopy.length > 0) {
    const key = pathCopy.shift() as string;
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = key === pipelineId && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }

  current[field] = value;
  return obj;
}

/**
 * Deep-merges a value into the object at the specified path.
 * WHY: Enables additive updates without losing existing nested data.
 * 
 * DESIGN: Uses customMerge semantics:
 * - Arrays: Concatenate (not replace)
 * - Objects: Shallow merge at each level
 * - Primitives: Replace
 */
export function updateNestedValue<T>(
  obj: any,
  pipelineId: string | undefined,
  _path: (string | number)[],
  field: string | number,
  value: T,
  defaultValues?: unknown,
): any {
  const { pipelinePath, globalPath } = getPipelineAndGlobalPaths(pipelineId, _path);
  // If pipelineID is present update in pipeline else in global
  const path = pipelinePath || globalPath;
  const pathCopy = [...path];
  let current: NestedObject = obj;
  while (pathCopy.length > 0) {
    const key = pathCopy.shift() as string;
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = key === pipelineId && defaultValues ? defaultValues : {};
    }
    current = current[key];
  }

  updateValue(current, field, value);
  return obj;
}

/**
 * In-place value update with merge semantics.
 * WHY: Provides consistent merge behavior for direct object references.
 * 
 * DESIGN DECISIONS:
 * - Arrays: Concatenate to preserve all values
 * - Objects: Shallow merge (spread operator)
 * - Primitives: Direct assignment
 */
export function updateValue(object: any, key: string | number, value: any): void {
  if (value && Array.isArray(value)) {
    const currentValue = object[key] as any;
    object[key] = currentValue === undefined ? value : [...currentValue, ...value];
  } else if (value && typeof value === 'object' && Object.keys(value).length) {
    const currentValue = object[key] as any;
    object[key] =
      currentValue === undefined
        ? value
        : {
            ...currentValue,
            ...value,
          };
  } else {
    object[key] = value;
  }
}

/**
 * Gets a value at a nested path, optionally accessing a specific field.
 * WHY: Provides safe deep access with prototype pollution protection.
 * 
 * DESIGN: Uses hasOwnProperty check to avoid returning inherited prototype
 * properties like 'constructor', 'toString', etc. This prevents security
 * issues when user-controlled keys are used.
 */
export function getNestedValue(root: any, path: (string | number)[], field?: string | number): any {
  const node = path && path.length > 0 ? _get(root, path) : root;
  if (field === undefined || node === undefined) {
    return node;
  }
  // Check if the field is an own property to avoid prototype pollution
  // (e.g., returning Object.prototype.constructor for key "constructor")
  if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
    return node[field];
  }
  return undefined;
}

/**
 * Resolves pipeline-namespaced and global paths.
 * WHY: Pipelines store data under 'pipelines/{id}/' to prevent collisions.
 * 
 * @returns Both pipeline-scoped and global paths for the given segments
 */
export function getPipelineAndGlobalPaths(pipelineId?: string, path: (string | number)[] = []) {
  return {
    pipelinePath: pipelineId ? ['pipelines', pipelineId, ...path] : undefined,
    globalPath: [...path],
  };
}

/**
 * Redacts sensitive values in a patch for logging/debugging.
 * WHY: Some data (credentials, PII) shouldn't appear in debug output.
 * 
 * DESIGN: Only redacts paths that actually exist in the patch to preserve
 * the patch structure for debugging while hiding sensitive values.
 */
export const redactPatch = (patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch => {
  const out = structuredClone(patch);
  for (const flat of redactedSet) {
    const pathArr = flat.split(DELIM);
    // Redact only if the key actually exists in this patch bundle
    if (_has(out, pathArr)) {
      // Keep "undefined overwrite" semantics: only replace non-undefined
      const curr = _get(out, pathArr);
      if (typeof curr !== 'undefined') {
        _set(out, pathArr, 'REDACTED');
      }
    }
  }
  return out;
};
