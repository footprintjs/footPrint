/**
 * circular — Dev-mode circular reference detection for scope values.
 *
 * Checks if a value contains circular references using a WeakSet traversal.
 * O(n) where n = total nested objects. Uses WeakSet so no memory leak.
 *
 * Gated by the caller — only called in dev mode to avoid production overhead.
 * Same approach as Immer (detect and warn at runtime).
 *
 * A leaf (imports nothing): it moved here from `scope/detectCircular.ts` so the layers
 * below `scope/` need not import upward for it.
 */

/**
 * Returns true if the value contains circular references.
 * Only checks plain objects and arrays — class instances, Date, Map, etc. are skipped.
 */
export function hasCircularReference(value: unknown, ancestors: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== 'object') return false;

  // Skip non-plain objects (Date, Map, Set, class instances) — same as allowlist logic
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return true;
    ancestors.add(value);
    for (const item of value) {
      if (hasCircularReference(item, ancestors)) return true;
    }
    ancestors.delete(value); // backtrack — allow diamond references
    return false;
  }

  const ctor = (value as Record<string, unknown>).constructor;
  if (ctor !== undefined && ctor !== Object) return false; // class instance — skip

  if (ancestors.has(value)) return true;
  ancestors.add(value);

  for (const v of Object.values(value as Record<string, unknown>)) {
    if (hasCircularReference(v, ancestors)) return true;
  }
  ancestors.delete(value); // backtrack — allow diamond references
  return false;
}
