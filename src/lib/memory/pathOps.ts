/**
 * pathOps.ts — Native nested-path helpers (replaces lodash.get/set/has/mergewith)
 *
 * All functions guard against prototype-pollution attacks.
 * Paths may be dot-notation strings or pre-split (string|number)[] arrays.
 */

const DENIED = new Set(['__proto__', 'constructor', 'prototype']);

function toSegments(path: string | (string | number)[]): (string | number)[] {
  return Array.isArray(path) ? path : path.split('.');
}

/** Get the value at `path` in `obj`, returning `defaultValue` if absent. */
export function nativeGet(obj: any, path: string | (string | number)[], defaultValue?: any): any {
  const segs = toSegments(path);
  let curr = obj;
  for (const seg of segs) {
    if (curr == null) return defaultValue;
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
