/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */
import { nativeGet as _get, nativeHas as _has, nativeSet as _set } from './pathOps.js';
/** ASCII Unit-Separator — cannot appear in JS identifiers, invisible in logs. */
export const DELIM = '\u001F';
/**
 * Resolves run-namespaced and global paths.
 * Each flowchart execution (run) stores data under `runs/{id}/` to prevent collisions.
 */
export function getRunAndGlobalPaths(runId, path = []) {
    return {
        runPath: runId ? ['runs', runId, ...path] : undefined,
        globalPath: [...path],
    };
}
/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 */
export function setNestedValue(obj, runId, _path, field, value, defaultValues) {
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
/**
 * Deep-merges a value into the object at the specified path.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
export function updateNestedValue(obj, runId, _path, field, value, defaultValues) {
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
export function updateValue(object, key, value) {
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
/**
 * Gets a value at a nested path with prototype-pollution protection.
 */
export function getNestedValue(root, path, field) {
    const node = path && path.length > 0 ? _get(root, path) : root;
    if (field === undefined || node === undefined)
        return node;
    if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
        return node[field];
    }
    return undefined;
}
/**
 * Redacts sensitive values in a patch for logging/debugging.
 */
export function redactPatch(patch, redactedSet) {
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
export function normalisePath(path) {
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
export function deepSmartMerge(dst, src) {
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
/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Two-phase: UPDATE (union-merge) then OVERWRITE (direct set).
 * Guarantees "last writer wins" semantics.
 */
export function applySmartMerge(base, updates, overwrite, trace) {
    var _a;
    const out = structuredClone(base);
    for (const { path, verb } of trace) {
        const segs = path.split(DELIM);
        if (verb === 'set') {
            _set(out, segs, structuredClone(_get(overwrite, segs)));
        }
        else {
            const current = (_a = _get(out, segs)) !== null && _a !== void 0 ? _a : {};
            _set(out, segs, deepSmartMerge(current, _get(updates, segs)));
        }
    }
    return out;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXRpbHMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS91dGlscy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7R0FLRztBQUVILE9BQU8sRUFBRSxTQUFTLElBQUksSUFBSSxFQUFFLFNBQVMsSUFBSSxJQUFJLEVBQUUsU0FBUyxJQUFJLElBQUksRUFBRSxNQUFNLGNBQWMsQ0FBQztBQUd2RixpRkFBaUY7QUFDakYsTUFBTSxDQUFDLE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQztBQUk5Qjs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsb0JBQW9CLENBQUMsS0FBYyxFQUFFLE9BQTRCLEVBQUU7SUFDakYsT0FBTztRQUNMLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTO1FBQ3JELFVBQVUsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDO0tBQ3RCLENBQUM7QUFDSixDQUFDO0FBRUQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsY0FBYyxDQUM1QixHQUFpQixFQUNqQixLQUFhLEVBQ2IsS0FBZSxFQUNmLEtBQWEsRUFDYixLQUFRLEVBQ1IsYUFBdUI7SUFFdkIsTUFBTSxFQUFFLE9BQU8sRUFBRSxVQUFVLEVBQUUsR0FBRyxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDbkUsTUFBTSxJQUFJLEdBQUcsT0FBTyxJQUFJLFVBQVUsQ0FBQztJQUNuQyxNQUFNLFFBQVEsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFDM0IsSUFBSSxPQUFPLEdBQWlCLEdBQUcsQ0FBQztJQUNoQyxPQUFPLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDM0IsTUFBTSxHQUFHLEdBQUcsUUFBUSxDQUFDLEtBQUssRUFBWSxDQUFDO1FBQ3ZDLElBQUksQ0FB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QztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLFVBQVUsZUFBZSxDQUM3QixJQUFTLEVBQ1QsT0FBb0IsRUFDcEIsU0FBc0IsRUFDdEIsS0FBZ0Q7O0lBRWhELE1BQU0sR0FBRyxHQUFHLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNsQyxLQUFLLE1BQU0sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksS0FBSyxFQUFFLENBQUM7UUFDbkMsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMvQixJQUFJLElBQUksS0FBSyxLQUFLLEVBQUUsQ0FBQztZQUNuQixJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxlQUFlLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDMUQsQ0FBQzthQUFNLENBQUM7WUFDTixNQUFNLE9BQU8sR0FBRyxNQUFBLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLG1DQUFJLEVBQUUsQ0FBQztZQUN0QyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxjQUFjLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2hFLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxHQUFHLENBQUM7QUFDYixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiB1dGlscy50cyDigJQgSGVscGVyIGZ1bmN0aW9ucyBmb3IgbmVzdGVkIG9iamVjdCBtYW5pcHVsYXRpb25cbiAqXG4gKiBQcm92aWRlcyBjb25zaXN0ZW50IHBhdGggdHJhdmVyc2FsIGFuZCB2YWx1ZSBtYW5pcHVsYXRpb24gZm9yIHRoZSBtZW1vcnkgc3lzdGVtLlxuICogWmVybyBleHRlcm5hbCBkZXBlbmRlbmNpZXMuXG4gKi9cblxuaW1wb3J0IHsgbmF0aXZlR2V0IGFzIF9nZXQsIG5hdGl2ZUhhcyBhcyBfaGFzLCBuYXRpdmVTZXQgYXMgX3NldCB9IGZyb20gJy4vcGF0aE9wcy5qcyc7XG5pbXBvcnQgdHlwZSB7IE1lbW9yeVBhdGNoIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8qKiBBU0NJSSBVbml0LVNlcGFyYXRvciDigJQgY2Fubm90IGFwcGVhciBpbiBKUyBpZGVudGlmaWVycywgaW52aXNpYmxlIGluIGxvZ3MuICovXG5leHBvcnQgY29uc3QgREVMSU0gPSAnXFx1MDAxRic7XG5cbnR5cGUgTmVzdGVkT2JqZWN0ID0geyBba2V5OiBzdHJpbmddOiBhbnkgfTtcblxuLyoqXG4gKiBSZXNvbHZlcyBydW4tbmFtZXNwYWNlZCBhbmQgZ2xvYmFsIHBhdGhzLlxuICogRWFjaCBmbG93Y2hhcnQgZXhlY3V0aW9uIChydW4pIHN0b3JlcyBkYXRhIHVuZGVyIGBydW5zL3tpZH0vYCB0byBwcmV2ZW50IGNvbGxpc2lvbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRSdW5BbmRHbG9iYWxQYXRocyhydW5JZD86IHN0cmluZywgcGF0aDogKHN0cmluZyB8IG51bWJlcilbXSA9IFtdKSB7XG4gIHJldHVybiB7XG4gICAgcnVuUGF0aDogcnVuSWQgPyBbJ3J1bnMnLCBydW5JZCwgLi4ucGF0aF0gOiB1bmRlZmluZWQsXG4gICAgZ2xvYmFsUGF0aDogWy4uLnBhdGhdLFxuICB9O1xufVxuXG4vKipcbiAqIFNldHMgYSB2YWx1ZSBhdCBhIG5lc3RlZCBwYXRoLCBjcmVhdGluZyBpbnRlcm1lZGlhdGUgb2JqZWN0cyBhcyBuZWVkZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXROZXN0ZWRWYWx1ZTxUPihcbiAgb2JqOiBOZXN0ZWRPYmplY3QsXG4gIHJ1bklkOiBzdHJpbmcsXG4gIF9wYXRoOiBzdHJpbmdbXSxcbiAgZmllbGQ6IHN0cmluZyxcbiAgdmFsdWU6IFQsXG4gIGRlZmF1bHRWYWx1ZXM/OiB1bmtub3duLFxuKTogTmVzdGVkT2JqZWN0IHtcbiAgY29uc3QgeyBydW5QYXRoLCBnbG9iYWxQYXRoIH0gPSBnZXRSdW5BbmRHbG9iYWxQYXRocyhydW5JZCwgX3BhdGgpO1xuICBjb25zdCBwYXRoID0gcnVuUGF0aCB8fCBnbG9iYWxQYXRoO1xuICBjb25zdCBwYXRoQ29weSA9IFsuLi5wYXRoXTtcbiAgbGV0IGN1cnJlbnQ6IE5lc3RlZE9iamVjdCA9IG9iajtcbiAgd2hpbGUgKHBhdGhDb3B5Lmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBrZXkgPSBwYXRoQ29weS5zaGlmdCgpIGFzIHN0cmluZztcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChjdXJyZW50LCBrZXkpKSB7XG4gICAgICBjdXJyZW50W2tleV0gPSBrZXkgPT09IHJ1bklkICYmIGRlZmF1bHRWYWx1ZXMgPyBkZWZhdWx0VmFsdWVzIDoge307XG4gICAgfVxuICAgIGN1cnJlbnQgPSBjdXJyZW50W2tleV07XG4gIH1cbiAgY3VycmVudFtmaWVsZF0gPSB2YWx1ZTtcbiAgcmV0dXJuIG9iajtcbn1cblxuLyoqXG4gKiBEZWVwLW1lcmdlcyBhIHZhbHVlIGludG8gdGhlIG9iamVjdCBhdCB0aGUgc3BlY2lmaWVkIHBhdGguXG4gKiAtIEFycmF5czogY29uY2F0ZW5hdGVcbiAqIC0gT2JqZWN0czogc2hhbGxvdyBtZXJnZSBhdCBlYWNoIGxldmVsXG4gKiAtIFByaW1pdGl2ZXM6IHJlcGxhY2VcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZU5lc3RlZFZhbHVlPFQ+KFxuICBvYmo6IGFueSxcbiAgcnVuSWQ6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgX3BhdGg6IChzdHJpbmcgfCBudW1iZXIpW10sXG4gIGZpZWxkOiBzdHJpbmcgfCBudW1iZXIsXG4gIHZhbHVlOiBULFxuICBkZWZhdWx0VmFsdWVzPzogdW5rbm93bixcbik6IGFueSB7XG4gIGNvbnN0IHsgcnVuUGF0aCwgZ2xvYmFsUGF0aCB9ID0gZ2V0UnVuQW5kR2xvYmFsUGF0aHMocnVuSWQsIF9wYXRoKTtcbiAgY29uc3QgcGF0aCA9IHJ1blBhdGggfHwgZ2xvYmFsUGF0aDtcbiAgY29uc3QgcGF0aENvcHkgPSBbLi4ucGF0aF07XG4gIGxldCBjdXJyZW50OiBOZXN0ZWRPYmplY3QgPSBvYmo7XG4gIHdoaWxlIChwYXRoQ29weS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qga2V5ID0gcGF0aENvcHkuc2hpZnQoKSBhcyBzdHJpbmc7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoY3VycmVudCwga2V5KSkge1xuICAgICAgY3VycmVudFtrZXldID0ga2V5ID09PSBydW5JZCAmJiBkZWZhdWx0VmFsdWVzID8gZGVmYXVsdFZhbHVlcyA6IHt9O1xuICAgIH1cbiAgICBjdXJyZW50ID0gY3VycmVudFtrZXldO1xuICB9XG4gIHVwZGF0ZVZhbHVlKGN1cnJlbnQsIGZpZWxkLCB2YWx1ZSk7XG4gIHJldHVybiBvYmo7XG59XG5cbi8qKlxuICogSW4tcGxhY2UgdmFsdWUgdXBkYXRlIHdpdGggbWVyZ2Ugc2VtYW50aWNzLlxuICogLSBBcnJheXMgKG5vbi1lbXB0eSk6IGNvbmNhdGVuYXRlIG9udG8gZXhpc3RpbmdcbiAqIC0gQXJyYXlzIChlbXB0eSk6ICAgICBkaXJlY3QgcmVwbGFjZSDigJQgd3JpdGluZyBgW11gIGNsZWFycyB0aGUgZmllbGRcbiAqIC0gT2JqZWN0cyAobm9uLWVtcHR5KTogc2hhbGxvdyBtZXJnZSAoc3ByZWFkKVxuICogLSBPYmplY3RzIChlbXB0eSk6ICAgIGRpcmVjdCByZXBsYWNlIOKAlCB3cml0aW5nIGB7fWAgY2xlYXJzIHRoZSBmaWVsZFxuICogLSBQcmltaXRpdmVzOiBkaXJlY3QgYXNzaWdubWVudFxuICpcbiAqIE5vdGUgb24gZW1wdHkgYXJyYXlzOiBib3RoIGB2YWx1ZSAmJiBBcnJheS5pc0FycmF5KHZhbHVlKWAgYW5kXG4gKiBgQXJyYXkuaXNBcnJheSh2YWx1ZSlgIGV2YWx1YXRlIHRoZSBzYW1lIGZvciBhcnJheXMg4oCUIGBbXWAgaXMgdHJ1dGh5IGluXG4gKiBKYXZhU2NyaXB0LCBzbyB0aGUgYCYmYCBndWFyZCB3YXMgbmV2ZXIgdGhlIGlzc3VlLiBUaGUgYWN0dWFsIGJ1ZyB3YXMgdGhlXG4gKiBjb25jYXQgcGF0aDogYFsuLi5jdXIsIC4uLltdXWAgc2lsZW50bHkgcmV0dXJuZWQgYGN1cmAgdW5jaGFuZ2VkIHdoZW4gYHZhbHVlYFxuICogd2FzIGBbXWAsIG1ha2luZyBgdXBkYXRlVmFsdWUob2JqLCAndGFncycsIFtdKWAgYSBuby1vcCBpbnN0ZWFkIG9mIGEgY2xlYXIuXG4gKiBUaGUgZml4IGlzIHRoZSBleHBsaWNpdCBgdmFsdWUubGVuZ3RoID09PSAwYCBlYXJseS1yZXR1cm4gYnJhbmNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlVmFsdWUob2JqZWN0OiBhbnksIGtleTogc3RyaW5nIHwgbnVtYmVyLCB2YWx1ZTogYW55KTogdm9pZCB7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIGlmICh2YWx1ZS5sZW5ndGggPT09IDApIHtcbiAgICAgIG9iamVjdFtrZXldID0gdmFsdWU7IC8vIGNsZWFyOiBbXSByZXBsYWNlcyB3aGF0ZXZlciB3YXMgdGhlcmVcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgY3VyID0gb2JqZWN0W2tleV0gYXMgYW55O1xuICAgICAgb2JqZWN0W2tleV0gPSBjdXIgPT09IHVuZGVmaW5lZCA/IHZhbHVlIDogWy4uLmN1ciwgLi4udmFsdWVdO1xuICAgIH1cbiAgfSBlbHNlIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGgpIHtcbiAgICBjb25zdCBjdXIgPSBvYmplY3Rba2V5XSBhcyBhbnk7XG4gICAgb2JqZWN0W2tleV0gPSBjdXIgPT09IHVuZGVmaW5lZCA/IHZhbHVlIDogeyAuLi5jdXIsIC4uLnZhbHVlIH07XG4gIH0gZWxzZSB7XG4gICAgb2JqZWN0W2tleV0gPSB2YWx1ZTtcbiAgfVxufVxuXG4vKipcbiAqIEdldHMgYSB2YWx1ZSBhdCBhIG5lc3RlZCBwYXRoIHdpdGggcHJvdG90eXBlLXBvbGx1dGlvbiBwcm90ZWN0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TmVzdGVkVmFsdWUocm9vdDogYW55LCBwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdLCBmaWVsZD86IHN0cmluZyB8IG51bWJlcik6IGFueSB7XG4gIGNvbnN0IG5vZGUgPSBwYXRoICYmIHBhdGgubGVuZ3RoID4gMCA/IF9nZXQocm9vdCwgcGF0aCkgOiByb290O1xuICBpZiAoZmllbGQgPT09IHVuZGVmaW5lZCB8fCBub2RlID09PSB1bmRlZmluZWQpIHJldHVybiBub2RlO1xuICBpZiAobm9kZSAhPT0gbnVsbCAmJiB0eXBlb2Ygbm9kZSA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG5vZGUsIGZpZWxkKSkge1xuICAgIHJldHVybiBub2RlW2ZpZWxkXTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJlZGFjdHMgc2Vuc2l0aXZlIHZhbHVlcyBpbiBhIHBhdGNoIGZvciBsb2dnaW5nL2RlYnVnZ2luZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdFBhdGNoKHBhdGNoOiBNZW1vcnlQYXRjaCwgcmVkYWN0ZWRTZXQ6IFNldDxzdHJpbmc+KTogTWVtb3J5UGF0Y2gge1xuICBjb25zdCBvdXQgPSBzdHJ1Y3R1cmVkQ2xvbmUocGF0Y2gpO1xuICBmb3IgKGNvbnN0IGZsYXQgb2YgcmVkYWN0ZWRTZXQpIHtcbiAgICBjb25zdCBwYXRoQXJyID0gZmxhdC5zcGxpdChERUxJTSk7XG4gICAgaWYgKF9oYXMob3V0LCBwYXRoQXJyKSkge1xuICAgICAgY29uc3QgY3VyciA9IF9nZXQob3V0LCBwYXRoQXJyKTtcbiAgICAgIGlmICh0eXBlb2YgY3VyciAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgX3NldChvdXQsIHBhdGhBcnIsICdSRURBQ1RFRCcpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIE5vcm1hbGlzZXMgYW4gYXJyYXkgcGF0aCBpbnRvIGEgc3RhYmxlIHN0cmluZyBrZXkgdXNpbmcgREVMSU0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpc2VQYXRoKHBhdGg6IChzdHJpbmcgfCBudW1iZXIpW10pOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5tYXAoU3RyaW5nKS5qb2luKERFTElNKTtcbn1cblxuLyoqXG4gKiBEZWVwIHVuaW9uIG1lcmdlIGhlbHBlci5cbiAqIC0gQXJyYXlzIChub24tZW1wdHkpOiB1bmlvbiB3aXRob3V0IGR1cGxpY2F0ZXMgKGVuY291bnRlciBvcmRlciBwcmVzZXJ2ZWQpXG4gKiAtIEFycmF5cyAoZW1wdHkpOiAgICAgcmVwbGFjZSDigJQgc3JjIGBbXWAgY2xlYXJzIHRoZSBkZXN0aW5hdGlvbiBhcnJheS5cbiAqICAgUmF0aW9uYWxlOiB3cml0aW5nIGBzY29wZS50YWdzID0gW11gIG1lYW5zIFwiY2xlYXIgdGFnc1wiLCBub3QgXCJhcHBlbmQgbm90aGluZ1wiLlxuICogICBXaXRob3V0IHRoaXMgcnVsZSwgYW4gZW1wdHktYXJyYXkgd3JpdGUgc2lsZW50bHkgYmVjb21lcyBhIG5vLW9wIHdoaWNoIGlzXG4gKiAgIGltcG9zc2libGUgdG8gZGlzdGluZ3Vpc2ggZnJvbSBhIGJ1Zy5cbiAqIC0gT2JqZWN0czogcmVjdXJzaXZlIG1lcmdlXG4gKiAtIFByaW1pdGl2ZXM6IHNvdXJjZSB3aW5zXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWVwU21hcnRNZXJnZShkc3Q6IGFueSwgc3JjOiBhbnkpOiBhbnkge1xuICBpZiAoc3JjID09PSBudWxsIHx8IHR5cGVvZiBzcmMgIT09ICdvYmplY3QnKSByZXR1cm4gc3JjO1xuXG4gIGlmIChBcnJheS5pc0FycmF5KHNyYykpIHtcbiAgICBpZiAoc3JjLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdOyAvLyBlbXB0eSBzcmMgPSBjbGVhciwgbm90IG5vLW9wXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZHN0KSkgcmV0dXJuIFsuLi5uZXcgU2V0KFsuLi5kc3QsIC4uLnNyY10pXTtcbiAgICByZXR1cm4gWy4uLnNyY107XG4gIH1cblxuICBjb25zdCBvdXQ6IGFueSA9IHsgLi4uKGRzdCAmJiB0eXBlb2YgZHN0ID09PSAnb2JqZWN0JyA/IGRzdCA6IHt9KSB9O1xuICAvLyBPYmplY3Qua2V5cygpIGlzIG93bi1lbnVtZXJhYmxlLW9ubHkgYnkgc3BlYyDigJQgbm8gREVOSUVEIGNoZWNrIG5lZWRlZCBoZXJlLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMoc3JjKSkge1xuICAgIG91dFtrXSA9IGRlZXBTbWFydE1lcmdlKG91dFtrXSwgc3JjW2tdKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIEFwcGxpZXMgYSBjb21taXQgYnVuZGxlIHRvIGEgYmFzZSBzdGF0ZSBieSByZXBsYXlpbmcgb3BlcmF0aW9ucyBpbiBvcmRlci5cbiAqIFR3by1waGFzZTogVVBEQVRFICh1bmlvbi1tZXJnZSkgdGhlbiBPVkVSV1JJVEUgKGRpcmVjdCBzZXQpLlxuICogR3VhcmFudGVlcyBcImxhc3Qgd3JpdGVyIHdpbnNcIiBzZW1hbnRpY3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVNtYXJ0TWVyZ2UoXG4gIGJhc2U6IGFueSxcbiAgdXBkYXRlczogTWVtb3J5UGF0Y2gsXG4gIG92ZXJ3cml0ZTogTWVtb3J5UGF0Y2gsXG4gIHRyYWNlOiB7IHBhdGg6IHN0cmluZzsgdmVyYjogJ3NldCcgfCAnbWVyZ2UnIH1bXSxcbik6IGFueSB7XG4gIGNvbnN0IG91dCA9IHN0cnVjdHVyZWRDbG9uZShiYXNlKTtcbiAgZm9yIChjb25zdCB7IHBhdGgsIHZlcmIgfSBvZiB0cmFjZSkge1xuICAgIGNvbnN0IHNlZ3MgPSBwYXRoLnNwbGl0KERFTElNKTtcbiAgICBpZiAodmVyYiA9PT0gJ3NldCcpIHtcbiAgICAgIF9zZXQob3V0LCBzZWdzLCBzdHJ1Y3R1cmVkQ2xvbmUoX2dldChvdmVyd3JpdGUsIHNlZ3MpKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBfZ2V0KG91dCwgc2VncykgPz8ge307XG4gICAgICBfc2V0KG91dCwgc2VncywgZGVlcFNtYXJ0TWVyZ2UoY3VycmVudCwgX2dldCh1cGRhdGVzLCBzZWdzKSkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIl19