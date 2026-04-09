/**
 * KeyedRecorder<T> — base class for Map-based recorders keyed by runtimeStageId.
 *
 * Provides typed key-value storage with O(1) lookup, insertion-ordered iteration,
 * and common accessors. Recorder implementations extend this and call store()
 * from their event hooks.
 *
 * @example
 * ```typescript
 * class TokenRecorder extends KeyedRecorder<LLMCallEntry> {
 *   onLLMCall(event: LLMCallEvent) {
 *     this.store(event.runtimeStageId, { model: event.model, ... });
 *   }
 *   getStats() { return aggregate(this.values()); }
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

  /** Clear all stored data. Called by executor before each run(). */
  clear(): void {
    this.data.clear();
  }
}
