"use strict";
/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySmartMerge = exports.deepSmartMerge = exports.normalisePath = exports.redactPatch = exports.getNestedValue = exports.updateValue = exports.updateNestedValue = exports.setNestedValue = exports.getRunAndGlobalPaths = exports.DELIM = void 0;
const pathOps_js_1 = require("./pathOps.js");
/** ASCII Unit-Separator — cannot appear in JS identifiers, invisible in logs. */
exports.DELIM = '\u001F';
/**
 * Resolves run-namespaced and global paths.
 * Each flowchart execution (run) stores data under `runs/{id}/` to prevent collisions.
 */
function getRunAndGlobalPaths(runId, path = []) {
    return {
        runPath: runId ? ['runs', runId, ...path] : undefined,
        globalPath: [...path],
    };
}
exports.getRunAndGlobalPaths = getRunAndGlobalPaths;
/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 */
function setNestedValue(obj, runId, _path, field, value, defaultValues) {
    const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
    const path = runPath || globalPath;
    const pathCopy = [...path];
    let current = obj;
    while (pathCopy.length > 0) {
        const key = pathCopy.shift();
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
            current[key] = key === runId && defaultValues ? defaultValues : {};
        }
        current = current[key];
    }
    current[field] = value;
    return obj;
}
exports.setNestedValue = setNestedValue;
/**
 * Deep-merges a value into the object at the specified path.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
function updateNestedValue(obj, runId, _path, field, value, defaultValues) {
    const { runPath, globalPath } = getRunAndGlobalPaths(runId, _path);
    const path = runPath || globalPath;
    const pathCopy = [...path];
    let current = obj;
    while (pathCopy.length > 0) {
        const key = pathCopy.shift();
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
            current[key] = key === runId && defaultValues ? defaultValues : {};
        }
        current = current[key];
    }
    updateValue(current, field, value);
    return obj;
}
exports.updateNestedValue = updateNestedValue;
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
function updateValue(object, key, value) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            object[key] = value; // clear: [] replaces whatever was there
        }
        else {
            const cur = object[key];
            object[key] = cur === undefined ? value : [...cur, ...value];
        }
    }
    else if (value && typeof value === 'object' && Object.keys(value).length) {
        const cur = object[key];
        object[key] = cur === undefined ? value : { ...cur, ...value };
    }
    else {
        object[key] = value;
    }
}
exports.updateValue = updateValue;
/**
 * Gets a value at a nested path with prototype-pollution protection.
 */
function getNestedValue(root, path, field) {
    const node = path && path.length > 0 ? (0, pathOps_js_1.nativeGet)(root, path) : root;
    if (field === undefined || node === undefined)
        return node;
    if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
        return node[field];
    }
    return undefined;
}
exports.getNestedValue = getNestedValue;
/**
 * Redacts sensitive values in a patch for logging/debugging.
 */
function redactPatch(patch, redactedSet) {
    const out = structuredClone(patch);
    for (const flat of redactedSet) {
        const pathArr = flat.split(exports.DELIM);
        if ((0, pathOps_js_1.nativeHas)(out, pathArr)) {
            const curr = (0, pathOps_js_1.nativeGet)(out, pathArr);
            if (typeof curr !== 'undefined') {
                (0, pathOps_js_1.nativeSet)(out, pathArr, 'REDACTED');
            }
        }
    }
    return out;
}
exports.redactPatch = redactPatch;
/**
 * Normalises an array path into a stable string key using DELIM.
 */
function normalisePath(path) {
    return path.map(String).join(exports.DELIM);
}
exports.normalisePath = normalisePath;
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
function deepSmartMerge(dst, src) {
    if (src === null || typeof src !== 'object')
        return src;
    if (Array.isArray(src)) {
        if (src.length === 0)
            return []; // empty src = clear, not no-op
        if (Array.isArray(dst))
            return [...new Set([...dst, ...src])];
        return [...src];
    }
    const out = { ...(dst && typeof dst === 'object' ? dst : {}) };
    // Object.keys() is own-enumerable-only by spec — no DENIED check needed here.
    for (const k of Object.keys(src)) {
        out[k] = deepSmartMerge(out[k], src[k]);
    }
    return out;
}
exports.deepSmartMerge = deepSmartMerge;
/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Two-phase: UPDATE (union-merge) then OVERWRITE (direct set).
 * Guarantees "last writer wins" semantics.
 */
function applySmartMerge(base, updates, overwrite, trace) {
    var _a;
    const out = structuredClone(base);
    for (const { path, verb } of trace) {
        const segs = path.split(exports.DELIM);
        if (verb === 'set') {
            (0, pathOps_js_1.nativeSet)(out, segs, structuredClone((0, pathOps_js_1.nativeGet)(overwrite, segs)));
        }
        else {
            const current = (_a = (0, pathOps_js_1.nativeGet)(out, segs)) !== null && _a !== void 0 ? _a : {};
            (0, pathOps_js_1.nativeSet)(out, segs, deepSmartMerge(current, (0, pathOps_js_1.nativeGet)(updates, segs)));
        }
    }
    return out;
}
exports.applySmartMerge = applySmartMerge;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL21lbW9yeS91dGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDZDQUF1RjtBQUd2RixpRkFBaUY7QUFDcEUsUUFBQSxLQUFLLEdBQUcsUUFBUSxDQUFDO0FBSTlCOzs7R0FHRztBQUNILFNBQWdCLG9CQUFvQixDQUFDLEtBQWMsRUFBRSxPQUE0QixFQUFFO0lBQ2pGLE9BQU87UUFDTCxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztRQUNyRCxVQUFVLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQztLQUN0QixDQUFDO0FBQ0osQ0FBQztBQUxELG9EQUtDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixjQUFjLENBQzVCLEdBQWlCLEVBQ2pCLEtBQWEsRUFDYixLQUFlLEVBQ2YsS0FBYSxFQUNiLEtBQVEsRUFDUixhQUF1QjtJQUV2QixNQUFNLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxHQUFHLG9CQUFvQixDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztJQUNuRSxNQUFNLElBQUksR0FBRyxPQUFPLElBQUksVUFBVSxDQUFDO0lBQ25DLE1BQU0sUUFBUSxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQztJQUMzQixJQUFJLE9BQU8sR0FBaUIsR0FBRyxDQUFDO0lBQ2hDLE9BQU8sUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUMzQixNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsS0FBSyxFQUFZLENBQUM7UUFDdkMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUN4RCxPQUFPLENB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RUQ7Ozs7R0FJRztBQUNILFNBQWdCLGVBQWUsQ0FDN0IsSUFBUyxFQUNULE9BQW9CLEVBQ3BCLFNBQXNCLEVBQ3RCLEtBQWdEOztJQUVoRCxNQUFNLEdBQUcsR0FBRyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDbEMsS0FBSyxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEtBQUssRUFBRSxDQUFDO1FBQ25DLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsYUFBSyxDQUFDLENBQUM7UUFDL0IsSUFBSSxJQUFJLEtBQUssS0FBSyxFQUFFLENBQUM7WUFDbkIsSUFBQSxzQkFBSSxFQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsZUFBZSxDQUFDLElBQUEsc0JBQUksRUFBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzFELENBQUM7YUFBTSxDQUFDO1lBQ04sTUFBTSxPQUFPLEdBQUcsTUFBQSxJQUFBLHNCQUFJLEVBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxtQ0FBSSxFQUFFLENBQUM7WUFDdEMsSUFBQSxzQkFBSSxFQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsY0FBYyxDQUFDLE9BQU8sRUFBRSxJQUFBLHNCQUFJLEVBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNoRSxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQWpCRCwwQ0FpQkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHV0aWxzLnRzIOKAlCBIZWxwZXIgZnVuY3Rpb25zIGZvciBuZXN0ZWQgb2JqZWN0IG1hbmlwdWxhdGlvblxuICpcbiAqIFByb3ZpZGVzIGNvbnNpc3RlbnQgcGF0aCB0cmF2ZXJzYWwgYW5kIHZhbHVlIG1hbmlwdWxhdGlvbiBmb3IgdGhlIG1lbW9yeSBzeXN0ZW0uXG4gKiBaZXJvIGV4dGVybmFsIGRlcGVuZGVuY2llcy5cbiAqL1xuXG5pbXBvcnQgeyBuYXRpdmVHZXQgYXMgX2dldCwgbmF0aXZlSGFzIGFzIF9oYXMsIG5hdGl2ZVNldCBhcyBfc2V0IH0gZnJvbSAnLi9wYXRoT3BzLmpzJztcbmltcG9ydCB0eXBlIHsgTWVtb3J5UGF0Y2ggfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLyoqIEFTQ0lJIFVuaXQtU2VwYXJhdG9yIOKAlCBjYW5ub3QgYXBwZWFyIGluIEpTIGlkZW50aWZpZXJzLCBpbnZpc2libGUgaW4gbG9ncy4gKi9cbmV4cG9ydCBjb25zdCBERUxJTSA9ICdcXHUwMDFGJztcblxudHlwZSBOZXN0ZWRPYmplY3QgPSB7IFtrZXk6IHN0cmluZ106IGFueSB9O1xuXG4vKipcbiAqIFJlc29sdmVzIHJ1bi1uYW1lc3BhY2VkIGFuZCBnbG9iYWwgcGF0aHMuXG4gKiBFYWNoIGZsb3djaGFydCBleGVjdXRpb24gKHJ1bikgc3RvcmVzIGRhdGEgdW5kZXIgYHJ1bnMve2lkfS9gIHRvIHByZXZlbnQgY29sbGlzaW9ucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFJ1bkFuZEdsb2JhbFBhdGhzKHJ1bklkPzogc3RyaW5nLCBwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdID0gW10pIHtcbiAgcmV0dXJuIHtcbiAgICBydW5QYXRoOiBydW5JZCA/IFsncnVucycsIHJ1bklkLCAuLi5wYXRoXSA6IHVuZGVmaW5lZCxcbiAgICBnbG9iYWxQYXRoOiBbLi4ucGF0aF0sXG4gIH07XG59XG5cbi8qKlxuICogU2V0cyBhIHZhbHVlIGF0IGEgbmVzdGVkIHBhdGgsIGNyZWF0aW5nIGludGVybWVkaWF0ZSBvYmplY3RzIGFzIG5lZWRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldE5lc3RlZFZhbHVlPFQ+KFxuICBvYmo6IE5lc3RlZE9iamVjdCxcbiAgcnVuSWQ6IHN0cmluZyxcbiAgX3BhdGg6IHN0cmluZ1tdLFxuICBmaWVsZDogc3RyaW5nLFxuICB2YWx1ZTogVCxcbiAgZGVmYXVsdFZhbHVlcz86IHVua25vd24sXG4pOiBOZXN0ZWRPYmplY3Qge1xuICBjb25zdCB7IHJ1blBhdGgsIGdsb2JhbFBhdGggfSA9IGdldFJ1bkFuZEdsb2JhbFBhdGhzKHJ1bklkLCBfcGF0aCk7XG4gIGNvbnN0IHBhdGggPSBydW5QYXRoIHx8IGdsb2JhbFBhdGg7XG4gIGNvbnN0IHBhdGhDb3B5ID0gWy4uLnBhdGhdO1xuICBsZXQgY3VycmVudDogTmVzdGVkT2JqZWN0ID0gb2JqO1xuICB3aGlsZSAocGF0aENvcHkubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGtleSA9IHBhdGhDb3B5LnNoaWZ0KCkgYXMgc3RyaW5nO1xuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGN1cnJlbnQsIGtleSkpIHtcbiAgICAgIGN1cnJlbnRba2V5XSA9IGtleSA9PT0gcnVuSWQgJiYgZGVmYXVsdFZhbHVlcyA/IGRlZmF1bHRWYWx1ZXMgOiB7fTtcbiAgICB9XG4gICAgY3VycmVudCA9IGN1cnJlbnRba2V5XTtcbiAgfVxuICBjdXJyZW50W2ZpZWxkXSA9IHZhbHVlO1xuICByZXR1cm4gb2JqO1xufVxuXG4vKipcbiAqIERlZXAtbWVyZ2VzIGEgdmFsdWUgaW50byB0aGUgb2JqZWN0IGF0IHRoZSBzcGVjaWZpZWQgcGF0aC5cbiAqIC0gQXJyYXlzOiBjb25jYXRlbmF0ZVxuICogLSBPYmplY3RzOiBzaGFsbG93IG1lcmdlIGF0IGVhY2ggbGV2ZWxcbiAqIC0gUHJpbWl0aXZlczogcmVwbGFjZVxuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlTmVzdGVkVmFsdWU8VD4oXG4gIG9iajogYW55LFxuICBydW5JZDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBfcGF0aDogKHN0cmluZyB8IG51bWJlcilbXSxcbiAgZmllbGQ6IHN0cmluZyB8IG51bWJlcixcbiAgdmFsdWU6IFQsXG4gIGRlZmF1bHRWYWx1ZXM/OiB1bmtub3duLFxuKTogYW55IHtcbiAgY29uc3QgeyBydW5QYXRoLCBnbG9iYWxQYXRoIH0gPSBnZXRSdW5BbmRHbG9iYWxQYXRocyhydW5JZCwgX3BhdGgpO1xuICBjb25zdCBwYXRoID0gcnVuUGF0aCB8fCBnbG9iYWxQYXRoO1xuICBjb25zdCBwYXRoQ29weSA9IFsuLi5wYXRoXTtcbiAgbGV0IGN1cnJlbnQ6IE5lc3RlZE9iamVjdCA9IG9iajtcbiAgd2hpbGUgKHBhdGhDb3B5Lmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBrZXkgPSBwYXRoQ29weS5zaGlmdCgpIGFzIHN0cmluZztcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChjdXJyZW50LCBrZXkpKSB7XG4gICAgICBjdXJyZW50W2tleV0gPSBrZXkgPT09IHJ1bklkICYmIGRlZmF1bHRWYWx1ZXMgPyBkZWZhdWx0VmFsdWVzIDoge307XG4gICAgfVxuICAgIGN1cnJlbnQgPSBjdXJyZW50W2tleV07XG4gIH1cbiAgdXBkYXRlVmFsdWUoY3VycmVudCwgZmllbGQsIHZhbHVlKTtcbiAgcmV0dXJuIG9iajtcbn1cblxuLyoqXG4gKiBJbi1wbGFjZSB2YWx1ZSB1cGRhdGUgd2l0aCBtZXJnZSBzZW1hbnRpY3MuXG4gKiAtIEFycmF5cyAobm9uLWVtcHR5KTogY29uY2F0ZW5hdGUgb250byBleGlzdGluZ1xuICogLSBBcnJheXMgKGVtcHR5KTogICAgIGRpcmVjdCByZXBsYWNlIOKAlCB3cml0aW5nIGBbXWAgY2xlYXJzIHRoZSBmaWVsZFxuICogLSBPYmplY3RzIChub24tZW1wdHkpOiBzaGFsbG93IG1lcmdlIChzcHJlYWQpXG4gKiAtIE9iamVjdHMgKGVtcHR5KTogICAgZGlyZWN0IHJlcGxhY2Ug4oCUIHdyaXRpbmcgYHt9YCBjbGVhcnMgdGhlIGZpZWxkXG4gKiAtIFByaW1pdGl2ZXM6IGRpcmVjdCBhc3NpZ25tZW50XG4gKlxuICogTm90ZSBvbiBlbXB0eSBhcnJheXM6IGJvdGggYHZhbHVlICYmIEFycmF5LmlzQXJyYXkodmFsdWUpYCBhbmRcbiAqIGBBcnJheS5pc0FycmF5KHZhbHVlKWAgZXZhbHVhdGUgdGhlIHNhbWUgZm9yIGFycmF5cyDigJQgYFtdYCBpcyB0cnV0aHkgaW5cbiAqIEphdmFTY3JpcHQsIHNvIHRoZSBgJiZgIGd1YXJkIHdhcyBuZXZlciB0aGUgaXNzdWUuIFRoZSBhY3R1YWwgYnVnIHdhcyB0aGVcbiAqIGNvbmNhdCBwYXRoOiBgWy4uLmN1ciwgLi4uW11dYCBzaWxlbnRseSByZXR1cm5lZCBgY3VyYCB1bmNoYW5nZWQgd2hlbiBgdmFsdWVgXG4gKiB3YXMgYFtdYCwgbWFraW5nIGB1cGRhdGVWYWx1ZShvYmosICd0YWdzJywgW10pYCBhIG5vLW9wIGluc3RlYWQgb2YgYSBjbGVhci5cbiAqIFRoZSBmaXggaXMgdGhlIGV4cGxpY2l0IGB2YWx1ZS5sZW5ndGggPT09IDBgIGVhcmx5LXJldHVybiBicmFuY2guXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVWYWx1ZShvYmplY3Q6IGFueSwga2V5OiBzdHJpbmcgfCBudW1iZXIsIHZhbHVlOiBhbnkpOiB2b2lkIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgb2JqZWN0W2tleV0gPSB2YWx1ZTsgLy8gY2xlYXI6IFtdIHJlcGxhY2VzIHdoYXRldmVyIHdhcyB0aGVyZVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBjdXIgPSBvYmplY3Rba2V5XSBhcyBhbnk7XG4gICAgICBvYmplY3Rba2V5XSA9IGN1ciA9PT0gdW5kZWZpbmVkID8gdmFsdWUgOiBbLi4uY3VyLCAuLi52YWx1ZV07XG4gICAgfVxuICB9IGVsc2UgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aCkge1xuICAgIGNvbnN0IGN1ciA9IG9iamVjdFtrZXldIGFzIGFueTtcbiAgICBvYmplY3Rba2V5XSA9IGN1ciA9PT0gdW5kZWZpbmVkID8gdmFsdWUgOiB7IC4uLmN1ciwgLi4udmFsdWUgfTtcbiAgfSBlbHNlIHtcbiAgICBvYmplY3Rba2V5XSA9IHZhbHVlO1xuICB9XG59XG5cbi8qKlxuICogR2V0cyBhIHZhbHVlIGF0IGEgbmVzdGVkIHBhdGggd2l0aCBwcm90b3R5cGUtcG9sbHV0aW9uIHByb3RlY3Rpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXROZXN0ZWRWYWx1ZShyb290OiBhbnksIHBhdGg6IChzdHJpbmcgfCBudW1iZXIpW10sIGZpZWxkPzogc3RyaW5nIHwgbnVtYmVyKTogYW55IHtcbiAgY29uc3Qgbm9kZSA9IHBhdGggJiYgcGF0aC5sZW5ndGggPiAwID8gX2dldChyb290LCBwYXRoKSA6IHJvb3Q7XG4gIGlmIChmaWVsZCA9PT0gdW5kZWZpbmVkIHx8IG5vZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vZGU7XG4gIGlmIChub2RlICE9PSBudWxsICYmIHR5cGVvZiBub2RlID09PSAnb2JqZWN0JyAmJiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwobm9kZSwgZmllbGQpKSB7XG4gICAgcmV0dXJuIG5vZGVbZmllbGRdO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmVkYWN0cyBzZW5zaXRpdmUgdmFsdWVzIGluIGEgcGF0Y2ggZm9yIGxvZ2dpbmcvZGVidWdnaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVkYWN0UGF0Y2gocGF0Y2g6IE1lbW9yeVBhdGNoLCByZWRhY3RlZFNldDogU2V0PHN0cmluZz4pOiBNZW1vcnlQYXRjaCB7XG4gIGNvbnN0IG91dCA9IHN0cnVjdHVyZWRDbG9uZShwYXRjaCk7XG4gIGZvciAoY29uc3QgZmxhdCBvZiByZWRhY3RlZFNldCkge1xuICAgIGNvbnN0IHBhdGhBcnIgPSBmbGF0LnNwbGl0KERFTElNKTtcbiAgICBpZiAoX2hhcyhvdXQsIHBhdGhBcnIpKSB7XG4gICAgICBjb25zdCBjdXJyID0gX2dldChvdXQsIHBhdGhBcnIpO1xuICAgICAgaWYgKHR5cGVvZiBjdXJyICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICBfc2V0KG91dCwgcGF0aEFyciwgJ1JFREFDVEVEJyk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogTm9ybWFsaXNlcyBhbiBhcnJheSBwYXRoIGludG8gYSBzdGFibGUgc3RyaW5nIGtleSB1c2luZyBERUxJTS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGlzZVBhdGgocGF0aDogKHN0cmluZyB8IG51bWJlcilbXSk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoLm1hcChTdHJpbmcpLmpvaW4oREVMSU0pO1xufVxuXG4vKipcbiAqIERlZXAgdW5pb24gbWVyZ2UgaGVscGVyLlxuICogLSBBcnJheXMgKG5vbi1lbXB0eSk6IHVuaW9uIHdpdGhvdXQgZHVwbGljYXRlcyAoZW5jb3VudGVyIG9yZGVyIHByZXNlcnZlZClcbiAqIC0gQXJyYXlzIChlbXB0eSk6ICAgICByZXBsYWNlIOKAlCBzcmMgYFtdYCBjbGVhcnMgdGhlIGRlc3RpbmF0aW9uIGFycmF5LlxuICogICBSYXRpb25hbGU6IHdyaXRpbmcgYHNjb3BlLnRhZ3MgPSBbXWAgbWVhbnMgXCJjbGVhciB0YWdzXCIsIG5vdCBcImFwcGVuZCBub3RoaW5nXCIuXG4gKiAgIFdpdGhvdXQgdGhpcyBydWxlLCBhbiBlbXB0eS1hcnJheSB3cml0ZSBzaWxlbnRseSBiZWNvbWVzIGEgbm8tb3Agd2hpY2ggaXNcbiAqICAgaW1wb3NzaWJsZSB0byBkaXN0aW5ndWlzaCBmcm9tIGEgYnVnLlxuICogLSBPYmplY3RzOiByZWN1cnNpdmUgbWVyZ2VcbiAqIC0gUHJpbWl0aXZlczogc291cmNlIHdpbnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZXBTbWFydE1lcmdlKGRzdDogYW55LCBzcmM6IGFueSk6IGFueSB7XG4gIGlmIChzcmMgPT09IG51bGwgfHwgdHlwZW9mIHNyYyAhPT0gJ29iamVjdCcpIHJldHVybiBzcmM7XG5cbiAgaWYgKEFycmF5LmlzQXJyYXkoc3JjKSkge1xuICAgIGlmIChzcmMubGVuZ3RoID09PSAwKSByZXR1cm4gW107IC8vIGVtcHR5IHNyYyA9IGNsZWFyLCBub3Qgbm8tb3BcbiAgICBpZiAoQXJyYXkuaXNBcnJheShkc3QpKSByZXR1cm4gWy4uLm5ldyBTZXQoWy4uLmRzdCwgLi4uc3JjXSldO1xuICAgIHJldHVybiBbLi4uc3JjXTtcbiAgfVxuXG4gIGNvbnN0IG91dDogYW55ID0geyAuLi4oZHN0ICYmIHR5cGVvZiBkc3QgPT09ICdvYmplY3QnID8gZHN0IDoge30pIH07XG4gIC8vIE9iamVjdC5rZXlzKCkgaXMgb3duLWVudW1lcmFibGUtb25seSBieSBzcGVjIOKAlCBubyBERU5JRUQgY2hlY2sgbmVlZGVkIGhlcmUuXG4gIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhzcmMpKSB7XG4gICAgb3V0W2tdID0gZGVlcFNtYXJ0TWVyZ2Uob3V0W2tdLCBzcmNba10pO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICogQXBwbGllcyBhIGNvbW1pdCBidW5kbGUgdG8gYSBiYXNlIHN0YXRlIGJ5IHJlcGxheWluZyBvcGVyYXRpb25zIGluIG9yZGVyLlxuICogVHdvLXBoYXNlOiBVUERBVEUgKHVuaW9uLW1lcmdlKSB0aGVuIE9WRVJXUklURSAoZGlyZWN0IHNldCkuXG4gKiBHdWFyYW50ZWVzIFwibGFzdCB3cml0ZXIgd2luc1wiIHNlbWFudGljcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5U21hcnRNZXJnZShcbiAgYmFzZTogYW55LFxuICB1cGRhdGVzOiBNZW1vcnlQYXRjaCxcbiAgb3ZlcndyaXRlOiBNZW1vcnlQYXRjaCxcbiAgdHJhY2U6IHsgcGF0aDogc3RyaW5nOyB2ZXJiOiAnc2V0JyB8ICdtZXJnZScgfVtdLFxuKTogYW55IHtcbiAgY29uc3Qgb3V0ID0gc3RydWN0dXJlZENsb25lKGJhc2UpO1xuICBmb3IgKGNvbnN0IHsgcGF0aCwgdmVyYiB9IG9mIHRyYWNlKSB7XG4gICAgY29uc3Qgc2VncyA9IHBhdGguc3BsaXQoREVMSU0pO1xuICAgIGlmICh2ZXJiID09PSAnc2V0Jykge1xuICAgICAgX3NldChvdXQsIHNlZ3MsIHN0cnVjdHVyZWRDbG9uZShfZ2V0KG92ZXJ3cml0ZSwgc2VncykpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgY3VycmVudCA9IF9nZXQob3V0LCBzZWdzKSA/PyB7fTtcbiAgICAgIF9zZXQob3V0LCBzZWdzLCBkZWVwU21hcnRNZXJnZShjdXJyZW50LCBfZ2V0KHVwZGF0ZXMsIHNlZ3MpKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG4iXX0=