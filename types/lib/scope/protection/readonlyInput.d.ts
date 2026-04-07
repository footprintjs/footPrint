/**
 * readonlyInput — Utilities for readonly input enforcement.
 *
 * Provides:
 * - assertNotReadonly(): throws if a key belongs to the readonly input
 * - deepFreeze(): recursively freezes a plain object
 * - createFrozenArgs(): creates a cached, deeply frozen copy of input values
 *
 * Used by both ScopeFacade (class-based scopes) and attachScopeMethods
 * (non-class scopes) to enforce input immutability from a single source.
 */
/**
 * Throws if `key` is an own property of `readOnlyValues`.
 * Safe against prototype pollution — uses `hasOwnProperty` on the specific object.
 */
export declare function assertNotReadonly(readOnlyValues: unknown, key: string, operation: 'write' | 'delete'): void;
/**
 * Recursively freezes a plain object and all nested objects/arrays.
 * Safe for POJOs — skips non-plain values (Date, RegExp, etc.).
 */
export declare function deepFreeze<T>(obj: T): T;
/**
 * Creates a deeply frozen shallow copy of readonly input values.
 * Returns a cached copy — call once at construction, reuse on every getArgs().
 */
export declare function createFrozenArgs(readOnlyValues: unknown): Record<string, unknown>;
