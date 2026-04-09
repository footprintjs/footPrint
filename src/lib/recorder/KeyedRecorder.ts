/**
 * KeyedRecorder<T> — base class for Map-based recorders keyed by runtimeStageId.
 *
 * Provides typed key-value storage with O(1) lookup, insertion-ordered iteration,
 * and three standard operations on auto-collected traversal data:
 *
 *   - **Translate** (raw): `getByKey(id)` — per-step value
 *   - **Accumulate** (progressive): `accumulate(fn, initial, keys?)` — running total up to a point
 *   - **Aggregate** (summary): `aggregate(fn, initial)` — reduce all entries
 *
 * Data is automatically collected during the single DFS traversal.
 * The consumer chooses the operation at read time.
 *
 * @example
 * ```typescript
 * class TokenRecorder extends KeyedRecorder<LLMCallEntry> {
 *   readonly id = 'tokens';
 *   onLLMCall(event) { this.store(event.runtimeStageId, { tokens: event.usage }); }
 *
 *   // Translate: per-step
 *   getForStep(id: string) { return this.getByKey(id); }
 *
 *   // Aggregate: total
 *   getTotalTokens() { return this.aggregate((sum, e) => sum + e.tokens, 0); }
 *
 *   // Accumulate: progressive up to slider position
 *   getTokensUpTo(keys: Set<string>) { return this.accumulate((sum, e) => sum + e.tokens, 0, keys); }
 * }
 * ```
 */
export abstract class KeyedRecorder<T> {
  abstract readonly id: string;

  private readonly data = new Map<string, T>();

  /** Store an entry keyed by runtimeStageId. */
  protected store(runtimeStageId: string, entry: T): void {
    this.data.set(runtimeStageId, entry);
  }

  // ── Translate (raw per-step) ──────────────────────────────

  /** O(1) lookup by runtimeStageId. */
  getByKey(runtimeStageId: string): T | undefined {
    return this.data.get(runtimeStageId);
  }

  /** All entries as a read-only Map (insertion-ordered). */
  getMap(): ReadonlyMap<string, T> {
    return this.data;
  }

  /** All entries as an array (insertion-ordered). */
  values(): T[] {
    return [...this.data.values()];
  }

  /** Number of entries stored. */
  get size(): number {
    return this.data.size;
  }

  // ── Aggregate (reduce all entries) ────────────────────────

  /** Reduce ALL entries to a single value. For dashboards, totals, summaries. */
  aggregate<R>(fn: (acc: R, entry: T, key: string) => R, initial: R): R {
    return this.accumulate(fn, initial);
  }

  // ── Accumulate (progressive reduce) ───────────────────────

  /**
   * Reduce entries, optionally filtered by a set of keys.
   * For time-travel progressive view: pass the runtimeStageIds visible at the current slider position.
   * Without keys, reduces all entries (same as aggregate).
   */
  accumulate<R>(fn: (acc: R, entry: T, key: string) => R, initial: R, keys?: ReadonlySet<string>): R {
    let acc = initial;
    for (const [key, entry] of this.data) {
      if (keys && !keys.has(key)) continue;
      acc = fn(acc, entry, key);
    }
    return acc;
  }

  // ── Filter (subset by keys) ───────────────────────────────

  /** Return entries whose keys are in the set, preserving insertion order. */
  filterByKeys(keys: ReadonlySet<string>): T[] {
    const result: T[] = [];
    for (const [key, entry] of this.data) {
      if (keys.has(key)) result.push(entry);
    }
    return result;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Clear all stored data. Called by executor before each run(). */
  clear(): void {
    this.data.clear();
  }
}
