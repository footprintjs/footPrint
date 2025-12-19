import _cloneDeep from 'lodash.clonedeep';
import _get from 'lodash.get';
import _has from 'lodash.has';
import _set from 'lodash.set';

import { DELIM, MemoryPatch } from './PatchedMemoryContext';

type NestedObject = { [key: string]: any };
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
 updateNestedValue
 -----------------
 Deep‑merges *value* into the object located at *absPath* using `customMerge`.
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
 updateValue (in‑place helper) – expects you already have the target object
 reference. Mirrors the same `customMerge` semantics.
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
 getNestedValue – returns the object at *path* or the specific *field* when
 provided. Undefined is returned when the path does not exist.
 */
export function getNestedValue(root: any, path: (string | number)[], field?: string | number): any {
  const node = path && path.length > 0 ? _get(root, path) : root;
  return field === undefined || node === undefined ? node : node[field];
}
/**
 Convenience helper that returns the pipeline and global paths used by legacy
 code. Kept for backward compatibility.
 */
export function getPipelineAndGlobalPaths(pipelineId?: string, path: (string | number)[] = []) {
  return {
    pipelinePath: pipelineId ? ['pipelines', pipelineId, ...path] : undefined,
    globalPath: [...path],
  };
}

export const redactPatch = (patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch => {
  const out = _cloneDeep(patch);
  for (const flat of redactedSet) {
    const pathArr = flat.split(DELIM);
    // redact only if the key *actually* exists in this patch bundle
    if (_has(out, pathArr)) {
      // keep “undefined overwrite” semantics: only replace non-undefined
      const curr = _get(out, pathArr);
      if (typeof curr !== 'undefined') {
        _set(out, pathArr, 'REDACTED');
      }
    }
  }
  return out;
};
