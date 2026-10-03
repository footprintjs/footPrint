/**
 * readonlyInput — Utilities for readonly input enforcement.
 *
 * Provides:
 * - assertNotReadonly(): throws if a key belongs to the readonly input
 * - createFrozenArgs(): creates a cached, deeply frozen copy of input values
 *
 * Used by both ScopeFacade (class-based scopes) and attachScopeMethods
 * (non-class scopes) to enforce input immutability from a single source.
 * The freeze itself is `capture/freeze.ts · deepFreeze` — the one walk args,
 * the fold base, the dev-mode snapshot and the commit log all use.
 */

import { deepFreeze } from '../../capture/freeze.js';

/**
 * Throws if `key` is an own property of `readOnlyValues`.
 * Safe against prototype pollution — uses `hasOwnProperty` on the specific object.
 */
export function assertNotReadonly(readOnlyValues: unknown, key: string, operation: 'write' | 'delete'): void {
  if (
    readOnlyValues &&
    typeof readOnlyValues === 'object' &&
    Object.prototype.hasOwnProperty.call(readOnlyValues, key)
  ) {
    if (operation === 'delete') {
      throw new Error(`Cannot delete readonly input key "${key}" — input values are immutable`);
    }
    throw new Error(`Cannot write to readonly input key "${key}" — use getArgs() to read input values`);
  }
}

/**
 * Creates a deeply frozen shallow copy of readonly input values.
 * Returns a cached copy — call once at construction, reuse on every getArgs().
 */
export function createFrozenArgs(readOnlyValues: unknown): Record<string, unknown> {
  if (!readOnlyValues || typeof readOnlyValues !== 'object') {
    return Object.freeze({});
  }
  return deepFreeze({ ...(readOnlyValues as Record<string, unknown>) });
}
