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
/**
 * Get the value at `path` in `obj`, returning `defaultValue` if absent.
 *
 * Security: each path segment is checked against the DENIED list and requires
 * an own property at every step, preventing prototype-chain reads.
 * e.g. nativeGet({}, '__proto__') and nativeGet({}, 'constructor') both return
 * `defaultValue` instead of leaking Object.prototype / the Object constructor.
 */
export declare function nativeGet(obj: any, path: string | (string | number)[], defaultValue?: any): any;
/** Mutate `obj`, setting `value` at `path` (creates intermediate objects). Returns `obj`. */
export declare function nativeSet(obj: any, path: string | (string | number)[], value: any): any;
/** Returns true if `obj` has an own property at every segment of `path`. */
export declare function nativeHas(obj: any, path: string | (string | number)[]): boolean;
/**
 * Deep merge where destination wins for any defined value.
 * Fills missing keys from `src`, but never overwrites defined keys in `dst`.
 * Arrays are not recursed — dst array always wins when present.
 *
 * Replaces: `mergeWith(dst, src, (objValue) => objValue !== undefined ? objValue : undefined)`
 */
export declare function mergeContextWins(dst: any, src: any): any;
