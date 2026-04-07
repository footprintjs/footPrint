/**
 * utils.ts — Helper functions for nested object manipulation
 *
 * Provides consistent path traversal and value manipulation for the memory system.
 * Zero external dependencies.
 */
import type { MemoryPatch } from './types.js';
/** ASCII Unit-Separator — cannot appear in JS identifiers, invisible in logs. */
export declare const DELIM = "\u001F";
type NestedObject = {
    [key: string]: any;
};
/**
 * Resolves run-namespaced and global paths.
 * Each flowchart execution (run) stores data under `runs/{id}/` to prevent collisions.
 */
export declare function getRunAndGlobalPaths(runId?: string, path?: (string | number)[]): {
    runPath: (string | number)[] | undefined;
    globalPath: (string | number)[];
};
/**
 * Sets a value at a nested path, creating intermediate objects as needed.
 */
export declare function setNestedValue<T>(obj: NestedObject, runId: string, _path: string[], field: string, value: T, defaultValues?: unknown): NestedObject;
/**
 * Deep-merges a value into the object at the specified path.
 * - Arrays: concatenate
 * - Objects: shallow merge at each level
 * - Primitives: replace
 */
export declare function updateNestedValue<T>(obj: any, runId: string | undefined, _path: (string | number)[], field: string | number, value: T, defaultValues?: unknown): any;
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
export declare function updateValue(object: any, key: string | number, value: any): void;
/**
 * Gets a value at a nested path with prototype-pollution protection.
 */
export declare function getNestedValue(root: any, path: (string | number)[], field?: string | number): any;
/**
 * Redacts sensitive values in a patch for logging/debugging.
 */
export declare function redactPatch(patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch;
/**
 * Normalises an array path into a stable string key using DELIM.
 */
export declare function normalisePath(path: (string | number)[]): string;
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
export declare function deepSmartMerge(dst: any, src: any): any;
/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Two-phase: UPDATE (union-merge) then OVERWRITE (direct set).
 * Guarantees "last writer wins" semantics.
 */
export declare function applySmartMerge(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: {
    path: string;
    verb: 'set' | 'merge';
}[]): any;
export {};
