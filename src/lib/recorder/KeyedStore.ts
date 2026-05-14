/**
 * KeyedStore<T> — concrete, composable 1:1 storage keyed by string id.
 *
 * Pattern: COMPOSITION primitive. Concrete class — instantiate with
 *          `new KeyedStore<T>()` and own it as a field on your
 *          recorder. Replaces the abstract `KeyedRecorder<T>` base
 *          class for the v5 "one purpose per recorder" rule.
 * Role:    1:1 Map keyed by `runtimeStageId` (or any string).
 *          Insertion-ordered iteration.
 *
 * **Contrast with `SequenceStore<T>`:** KeyedStore is 1:1 — one entry
 * per key. Use SequenceStore for 1:N (multiple entries per
 * runtimeStageId, ordering matters).
 *
 * @example
 * ```typescript
 * import { KeyedStore } from 'footprintjs/trace';
 *
 * interface TokenEntry { input: number; output: number; }
 *
 * // ONE PURPOSE: typed-event handler. Storage is composed in.
 * class TokenRecorder {
 *   readonly id = 'tokens';
 *   private readonly store = new KeyedStore<TokenEntry>();
 *
 *   onLLMCall(event: LLMCallEvent) {
 *     this.store.set(event.runtimeStageId, event.usage);
 *   }
 *
 *   getForStep(id: string)    { return this.store.get(id); }
 *   getTotalTokens()           { return this.store.aggregate((s, e) => s + e.input + e.output, 0); }
 *   getTokensUpTo(keys: Set<string>) {
 *     return this.store.accumulate((s, e) => s + e.input + e.output, 0, keys);
 *   }
 *
 *   clear() { this.store.clear(); }
 * }
 * ```
 */
export class KeyedStore<T> {
  private readonly data = new Map<string, T>();

  // ── Write ────────────────────────────────────────────────────────────

  /** Store a single entry. Replaces any existing entry for the same key. */
  set(key: string, entry: T): void {
    this.data.set(key, entry);
  }

  /** Remove an entry. Returns true if the key existed, false otherwise. */
  delete(key: string): boolean {
    return this.data.delete(key);
  }

  // ── Translate (raw per-key) ──────────────────────────────────────────

  /** O(1) lookup. */
  get(key: string): T | undefined {
    return this.data.get(key);
  }

  /** True if a value exists for the key. */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /** All entries as a read-only Map (insertion-ordered). */
  getMap(): ReadonlyMap<string, T> {
    return this.data;
  }

  /** All values as an array (insertion-ordered). */
  values(): T[] {
    return [...this.data.values()];
  }

  /** Number of entries stored. */
  get size(): number {
    return this.data.size;
  }

  // ── Aggregate (reduce all entries) ───────────────────────────────────

  /** Reduce ALL entries to a single value. For dashboards, totals, summaries. */
  aggregate<R>(fn: (acc: R, entry: T, key: string) => R, initial: R): R {
    let acc = initial;
    for (const [key, entry] of this.data) acc = fn(acc, entry, key);
    return acc;
  }

  // ── Accumulate (progressive reduce) ──────────────────────────────────

  /**
   * Reduce entries, optionally filtered by a set of keys.
   * For time-travel progressive view: pass the keys visible at the
   * current slider position. Without keys, reduces all entries (same
   * as `aggregate`).
   */
  accumulate<R>(fn: (acc: R, entry: T, key: string) => R, initial: R, keys?: ReadonlySet<string>): R {
    let acc = initial;
    for (const [key, entry] of this.data) {
      if (keys && !keys.has(key)) continue;
      acc = fn(acc, entry, key);
    }
    return acc;
  }

  // ── Filter (subset by keys) ──────────────────────────────────────────

  /** Return entries whose keys are in the set, preserving insertion order. */
  filterByKeys(keys: ReadonlySet<string>): T[] {
    const result: T[] = [];
    for (const [key, entry] of this.data) {
      if (keys.has(key)) result.push(entry);
    }
    return result;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Clear all stored data. Recorders typically call this from their own
   *  `clear()` method, which the executor invokes before each run. */
  clear(): void {
    this.data.clear();
  }
}
