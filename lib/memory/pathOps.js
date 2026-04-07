"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeContextWins = exports.nativeHas = exports.nativeSet = exports.nativeGet = void 0;
const DENIED = new Set(['__proto__', 'constructor', 'prototype']);
function toSegments(path) {
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
function nativeGet(obj, path, defaultValue) {
    const segs = toSegments(path);
    let curr = obj;
    for (const seg of segs) {
        if (curr == null)
            return defaultValue;
        if (DENIED.has(String(seg)))
            return defaultValue;
        if (!Object.prototype.hasOwnProperty.call(curr, seg))
            return defaultValue;
        curr = curr[seg];
    }
    return curr === undefined ? defaultValue : curr;
}
exports.nativeGet = nativeGet;
/** Mutate `obj`, setting `value` at `path` (creates intermediate objects). Returns `obj`. */
function nativeSet(obj, path, value) {
    const segs = toSegments(path);
    let curr = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i];
        if (DENIED.has(String(k)))
            return obj;
        if (curr[k] == null || typeof curr[k] !== 'object') {
            curr[k] = typeof segs[i + 1] === 'number' ? [] : {};
        }
        curr = curr[k];
    }
    const last = segs[segs.length - 1];
    if (DENIED.has(String(last)))
        return obj;
    curr[last] = value;
    return obj;
}
exports.nativeSet = nativeSet;
/** Returns true if `obj` has an own property at every segment of `path`. */
function nativeHas(obj, path) {
    const segs = toSegments(path);
    let curr = obj;
    for (let i = 0; i < segs.length; i++) {
        if (curr == null || !Object.prototype.hasOwnProperty.call(curr, segs[i]))
            return false;
        if (i < segs.length - 1)
            curr = curr[segs[i]];
    }
    return true;
}
exports.nativeHas = nativeHas;
/**
 * Deep merge where destination wins for any defined value.
 * Fills missing keys from `src`, but never overwrites defined keys in `dst`.
 * Arrays are not recursed — dst array always wins when present.
 *
 * Replaces: `mergeWith(dst, src, (objValue) => objValue !== undefined ? objValue : undefined)`
 */
function mergeContextWins(dst, src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
        return dst !== undefined ? dst : src;
    }
    const out = dst != null && typeof dst === 'object' ? { ...dst } : {};
    for (const key of Object.keys(src)) {
        if (DENIED.has(key))
            continue;
        const dstVal = out[key];
        if (dstVal !== undefined) {
            // dst wins; recurse only if both sides are plain objects
            if (dstVal !== null &&
                typeof dstVal === 'object' &&
                !Array.isArray(dstVal) &&
                src[key] !== null &&
                typeof src[key] === 'object' &&
                !Array.isArray(src[key])) {
                out[key] = mergeContextWins(dstVal, src[key]);
            }
            // else keep dstVal unchanged
        }
        else {
            out[key] = src[key];
        }
    }
    return out;
}
exports.mergeContextWins = mergeContextWins;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aE9wcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvbWVtb3J5L3BhdGhPcHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBc0JHOzs7QUFFSCxNQUFNLE1BQU0sR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxhQUFhLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQztBQUVsRSxTQUFTLFVBQVUsQ0FBQyxJQUFrQztJQUNwRCxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN0RCxDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILFNBQWdCLFNBQVMsQ0FBQyxHQUFRLEVBQUUsSUFBa0MsRUFBRSxZQUFrQjtJQUN4RixNQUFNLElBQUksR0FBRyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDOUIsSUFBSSxJQUFJLEdBQUcsR0FBRyxDQUFDO0lBQ2YsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUN2QixJQUFJLElBQUksSUFBSSxJQUFJO1lBQUUsT0FBTyxZQUFZLENBQUM7UUFDdEMsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUFFLE9BQU8sWUFBWSxDQUFDO1FBQ2pELElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQztZQUFFLE9BQU8sWUFBWSxDQUFDO1FBQzFFLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDbkIsQ0FBQztJQUNELE9BQU8sSUFBSSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbEQsQ0FBQztBQVZELDhCQVVDO0FBRUQsNkZBQTZGO0FBQzdGLFNBQWdCLFNBQVMsQ0FBQyxHQUFRLEVBQUUsSUFBa0MsRUFBRSxLQUFVO0lBQ2hGLE1BQU0sSUFBSSxHQUFHLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM5QixJQUFJLElBQUksR0FBRyxHQUFHLENBQUM7SUFDZixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUN6QyxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEIsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUFFLE9BQU8sR0FBRyxDQUFDO1FBQ3RDLElBQUksSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLElBQUksSUFBSSxPQUFPLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNuRCxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDdEQsQ0FBQztRQUNELElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDakIsQ0FBQztJQUNELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ25DLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7UUFBRSxPQUFPLEdBQUcsQ0FBQztJQUN6QyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsS0FBSyxDQUFDO0lBQ25CLE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQWZELDhCQWVDO0FBRUQsNEVBQTRFO0FBQzVFLFNBQWdCLFNBQVMsQ0FBQyxHQUFRLEVBQUUsSUFBa0M7SUFDcEUsTUFBTSxJQUFJLEdBQUcsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzlCLElBQUksSUFBSSxHQUFHLEdBQUcsQ0FBQztJQUNmLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDckMsSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUN2RixJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUM7WUFBRSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUM7QUFSRCw4QkFRQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQWdCLGdCQUFnQixDQUFDLEdBQVEsRUFBRSxHQUFRO0lBQ2pELElBQUksQ0FBQyxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUMxRCxPQUFPLEdBQUcsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0lBQ3ZDLENBQUM7SUFDRCxNQUFNLEdBQUcsR0FBUSxHQUFHLElBQUksSUFBSSxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDMUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDbkMsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztZQUFFLFNBQVM7UUFDOUIsTUFBTSxNQUFNLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3hCLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLHlEQUF5RDtZQUN6RCxJQUNFLE1BQU0sS0FBSyxJQUFJO2dCQUNmLE9BQU8sTUFBTSxLQUFLLFFBQVE7Z0JBQzFCLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7Z0JBQ3RCLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSyxJQUFJO2dCQUNqQixPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSyxRQUFRO2dCQUM1QixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQ3hCLENBQUM7Z0JBQ0QsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztZQUNoRCxDQUFDO1lBQ0QsNkJBQTZCO1FBQy9CLENBQUM7YUFBTSxDQUFDO1lBQ04sR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN0QixDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQTFCRCw0Q0EwQkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHBhdGhPcHMudHMg4oCUIE5hdGl2ZSBuZXN0ZWQtcGF0aCBoZWxwZXJzIChyZXBsYWNlcyBsb2Rhc2guZ2V0L3NldC9oYXMvbWVyZ2V3aXRoKVxuICpcbiAqIFNlY3VyaXR5IGNvbnRyYWN0OiBhbGwgZnVuY3Rpb25zIGd1YXJkIGFnYWluc3QgcHJvdG90eXBlLXBvbGx1dGlvbiBhbmRcbiAqIHByb3RvdHlwZS1jaGFpbi1yZWFkIGF0dGFja3MuIFRoZSBERU5JRUQgc2V0IGJsb2NrcyB0aGUgdGhyZWUgY2Fub25pY2FsXG4gKiBwb2xsdXRpb24gdmVjdG9ycyAoX19wcm90b19fLCBjb25zdHJ1Y3RvciwgcHJvdG90eXBlKSBvbiBldmVyeSBmdW5jdGlvbi5cbiAqXG4gKiBJbnRlbnRpb25hbCBhc3ltbWV0cnk6XG4gKiAgIC0gbmF0aXZlU2V0ICDigJQgREVOSUVEIGNoZWNrIG9ubHkgYXQgZWFjaCBzZWdtZW50LiBObyBoYXNPd25Qcm9wZXJ0eVxuICogICAgIGNoZWNrIGlzIG5lZWRlZCBiZWNhdXNlIHdyaXRpbmcgYWx3YXlzIGNyZWF0ZXMgYW4gT1dOIHByb3BlcnR5IG9uIGBjdXJyYCxcbiAqICAgICB3aGljaCBjYW5ub3QgcG9sbHV0ZSB0aGUgcHJvdG90eXBlIGNoYWluLlxuICogICAtIG5hdGl2ZUdldCAvIG5hdGl2ZUhhcyDigJQgREVOSUVEIGNoZWNrICsgaGFzT3duUHJvcGVydHkgYXQgZXZlcnkgc3RlcC5cbiAqICAgICBSZWFkcyBmb2xsb3cgdGhlIHByb3RvdHlwZSBjaGFpbiBieSBkZWZhdWx0IChicmFja2V0IG5vdGF0aW9uKSwgc28gdGhlXG4gKiAgICAgaGFzT3duUHJvcGVydHkgZ3VhcmQgaXMgcmVxdWlyZWQgdG8gcHJldmVudCBsZWFraW5nIGluaGVyaXRlZCB2YWx1ZXNcbiAqICAgICAoZS5nLiBPYmplY3QucHJvdG90eXBlLCBPYmplY3QgY29uc3RydWN0b3IsIHRvU3RyaW5nKS5cbiAqICAgLSBtZXJnZUNvbnRleHRXaW5zIOKAlCBERU5JRUQgY2hlY2sgb25seTsgT2JqZWN0LmtleXMoKSBpcyBvd24tZW51bWVyYWJsZS1vbmx5XG4gKiAgICAgYnkgc3BlYyBzbyBwcm90b3R5cGUga2V5cyBuZXZlciBhcHBlYXIgaW4gdGhlIGl0ZXJhdGlvbi5cbiAqXG4gKiBEbyBOT1QgXCJmaXhcIiB0aGUgbmF0aXZlU2V0IGFzeW1tZXRyeSBieSBhZGRpbmcgaGFzT3duUHJvcGVydHkg4oCUIGl0IGlzXG4gKiBpbnRlbnRpb25hbCBhbmQgd291bGQgYnJlYWsgcGF0aCBjcmVhdGlvbiBmb3IgbmV3IGludGVybWVkaWF0ZSBub2Rlcy5cbiAqXG4gKiBQYXRocyBtYXkgYmUgZG90LW5vdGF0aW9uIHN0cmluZ3Mgb3IgcHJlLXNwbGl0IChzdHJpbmd8bnVtYmVyKVtdIGFycmF5cy5cbiAqL1xuXG5jb25zdCBERU5JRUQgPSBuZXcgU2V0KFsnX19wcm90b19fJywgJ2NvbnN0cnVjdG9yJywgJ3Byb3RvdHlwZSddKTtcblxuZnVuY3Rpb24gdG9TZWdtZW50cyhwYXRoOiBzdHJpbmcgfCAoc3RyaW5nIHwgbnVtYmVyKVtdKTogKHN0cmluZyB8IG51bWJlcilbXSB7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KHBhdGgpID8gcGF0aCA6IHBhdGguc3BsaXQoJy4nKTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHZhbHVlIGF0IGBwYXRoYCBpbiBgb2JqYCwgcmV0dXJuaW5nIGBkZWZhdWx0VmFsdWVgIGlmIGFic2VudC5cbiAqXG4gKiBTZWN1cml0eTogZWFjaCBwYXRoIHNlZ21lbnQgaXMgY2hlY2tlZCBhZ2FpbnN0IHRoZSBERU5JRUQgbGlzdCBhbmQgcmVxdWlyZXNcbiAqIGFuIG93biBwcm9wZXJ0eSBhdCBldmVyeSBzdGVwLCBwcmV2ZW50aW5nIHByb3RvdHlwZS1jaGFpbiByZWFkcy5cbiAqIGUuZy4gbmF0aXZlR2V0KHt9LCAnX19wcm90b19fJykgYW5kIG5hdGl2ZUdldCh7fSwgJ2NvbnN0cnVjdG9yJykgYm90aCByZXR1cm5cbiAqIGBkZWZhdWx0VmFsdWVgIGluc3RlYWQgb2YgbGVha2luZyBPYmplY3QucHJvdG90eXBlIC8gdGhlIE9iamVjdCBjb25zdHJ1Y3Rvci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUdldChvYmo6IGFueSwgcGF0aDogc3RyaW5nIHwgKHN0cmluZyB8IG51bWJlcilbXSwgZGVmYXVsdFZhbHVlPzogYW55KTogYW55IHtcbiAgY29uc3Qgc2VncyA9IHRvU2VnbWVudHMocGF0aCk7XG4gIGxldCBjdXJyID0gb2JqO1xuICBmb3IgKGNvbnN0IHNlZyBvZiBzZWdzKSB7XG4gICAgaWYgKGN1cnIgPT0gbnVsbCkgcmV0dXJuIGRlZmF1bHRWYWx1ZTtcbiAgICBpZiAoREVOSUVELmhhcyhTdHJpbmcoc2VnKSkpIHJldHVybiBkZWZhdWx0VmFsdWU7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY3Vyciwgc2VnKSkgcmV0dXJuIGRlZmF1bHRWYWx1ZTtcbiAgICBjdXJyID0gY3VycltzZWddO1xuICB9XG4gIHJldHVybiBjdXJyID09PSB1bmRlZmluZWQgPyBkZWZhdWx0VmFsdWUgOiBjdXJyO1xufVxuXG4vKiogTXV0YXRlIGBvYmpgLCBzZXR0aW5nIGB2YWx1ZWAgYXQgYHBhdGhgIChjcmVhdGVzIGludGVybWVkaWF0ZSBvYmplY3RzKS4gUmV0dXJucyBgb2JqYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVTZXQob2JqOiBhbnksIHBhdGg6IHN0cmluZyB8IChzdHJpbmcgfCBudW1iZXIpW10sIHZhbHVlOiBhbnkpOiBhbnkge1xuICBjb25zdCBzZWdzID0gdG9TZWdtZW50cyhwYXRoKTtcbiAgbGV0IGN1cnIgPSBvYmo7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc2Vncy5sZW5ndGggLSAxOyBpKyspIHtcbiAgICBjb25zdCBrID0gc2Vnc1tpXTtcbiAgICBpZiAoREVOSUVELmhhcyhTdHJpbmcoaykpKSByZXR1cm4gb2JqO1xuICAgIGlmIChjdXJyW2tdID09IG51bGwgfHwgdHlwZW9mIGN1cnJba10gIT09ICdvYmplY3QnKSB7XG4gICAgICBjdXJyW2tdID0gdHlwZW9mIHNlZ3NbaSArIDFdID09PSAnbnVtYmVyJyA/IFtdIDoge307XG4gICAgfVxuICAgIGN1cnIgPSBjdXJyW2tdO1xuICB9XG4gIGNvbnN0IGxhc3QgPSBzZWdzW3NlZ3MubGVuZ3RoIC0gMV07XG4gIGlmIChERU5JRUQuaGFzKFN0cmluZyhsYXN0KSkpIHJldHVybiBvYmo7XG4gIGN1cnJbbGFzdF0gPSB2YWx1ZTtcbiAgcmV0dXJuIG9iajtcbn1cblxuLyoqIFJldHVybnMgdHJ1ZSBpZiBgb2JqYCBoYXMgYW4gb3duIHByb3BlcnR5IGF0IGV2ZXJ5IHNlZ21lbnQgb2YgYHBhdGhgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUhhcyhvYmo6IGFueSwgcGF0aDogc3RyaW5nIHwgKHN0cmluZyB8IG51bWJlcilbXSk6IGJvb2xlYW4ge1xuICBjb25zdCBzZWdzID0gdG9TZWdtZW50cyhwYXRoKTtcbiAgbGV0IGN1cnIgPSBvYmo7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc2Vncy5sZW5ndGg7IGkrKykge1xuICAgIGlmIChjdXJyID09IG51bGwgfHwgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChjdXJyLCBzZWdzW2ldKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpIDwgc2Vncy5sZW5ndGggLSAxKSBjdXJyID0gY3VycltzZWdzW2ldXTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBEZWVwIG1lcmdlIHdoZXJlIGRlc3RpbmF0aW9uIHdpbnMgZm9yIGFueSBkZWZpbmVkIHZhbHVlLlxuICogRmlsbHMgbWlzc2luZyBrZXlzIGZyb20gYHNyY2AsIGJ1dCBuZXZlciBvdmVyd3JpdGVzIGRlZmluZWQga2V5cyBpbiBgZHN0YC5cbiAqIEFycmF5cyBhcmUgbm90IHJlY3Vyc2VkIOKAlCBkc3QgYXJyYXkgYWx3YXlzIHdpbnMgd2hlbiBwcmVzZW50LlxuICpcbiAqIFJlcGxhY2VzOiBgbWVyZ2VXaXRoKGRzdCwgc3JjLCAob2JqVmFsdWUpID0+IG9ialZhbHVlICE9PSB1bmRlZmluZWQgPyBvYmpWYWx1ZSA6IHVuZGVmaW5lZClgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUNvbnRleHRXaW5zKGRzdDogYW55LCBzcmM6IGFueSk6IGFueSB7XG4gIGlmICghc3JjIHx8IHR5cGVvZiBzcmMgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoc3JjKSkge1xuICAgIHJldHVybiBkc3QgIT09IHVuZGVmaW5lZCA/IGRzdCA6IHNyYztcbiAgfVxuICBjb25zdCBvdXQ6IGFueSA9IGRzdCAhPSBudWxsICYmIHR5cGVvZiBkc3QgPT09ICdvYmplY3QnID8geyAuLi5kc3QgfSA6IHt9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhzcmMpKSB7XG4gICAgaWYgKERFTklFRC5oYXMoa2V5KSkgY29udGludWU7XG4gICAgY29uc3QgZHN0VmFsID0gb3V0W2tleV07XG4gICAgaWYgKGRzdFZhbCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBkc3Qgd2luczsgcmVjdXJzZSBvbmx5IGlmIGJvdGggc2lkZXMgYXJlIHBsYWluIG9iamVjdHNcbiAgICAgIGlmIChcbiAgICAgICAgZHN0VmFsICE9PSBudWxsICYmXG4gICAgICAgIHR5cGVvZiBkc3RWYWwgPT09ICdvYmplY3QnICYmXG4gICAgICAgICFBcnJheS5pc0FycmF5KGRzdFZhbCkgJiZcbiAgICAgICAgc3JjW2tleV0gIT09IG51bGwgJiZcbiAgICAgICAgdHlwZW9mIHNyY1trZXldID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAhQXJyYXkuaXNBcnJheShzcmNba2V5XSlcbiAgICAgICkge1xuICAgICAgICBvdXRba2V5XSA9IG1lcmdlQ29udGV4dFdpbnMoZHN0VmFsLCBzcmNba2V5XSk7XG4gICAgICB9XG4gICAgICAvLyBlbHNlIGtlZXAgZHN0VmFsIHVuY2hhbmdlZFxuICAgIH0gZWxzZSB7XG4gICAgICBvdXRba2V5XSA9IHNyY1trZXldO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIl19