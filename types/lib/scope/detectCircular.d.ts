/**
 * detectCircular — Dev-mode circular reference detection for scope values.
 *
 * Checks if a value contains circular references using a WeakSet traversal.
 * O(n) where n = total nested objects. Uses WeakSet so no memory leak.
 *
 * Gated by the caller — only called in dev mode to avoid production overhead.
 * Same approach as Immer (detect and warn at runtime).
 */
/**
 * Returns true if the value contains circular references.
 * Only checks plain objects and arrays — class instances, Date, Map, etc. are skipped.
 */
export declare function hasCircularReference(value: unknown, ancestors?: WeakSet<object>): boolean;
/** Enable dev-mode circular reference detection. Call once at app startup. */
export declare function enableDevMode(): void;
/** Disable dev-mode detection (default). */
export declare function disableDevMode(): void;
/** Returns whether dev-mode detection is enabled. */
export declare function isDevMode(): boolean;
