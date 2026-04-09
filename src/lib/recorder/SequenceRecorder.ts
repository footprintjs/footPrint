/**
 * SequenceRecorder<T> — base class for ordered sequence recorders with keyed index.
 *
 * Provides dual-indexed storage: a flat array preserving insertion order plus a
 * Map<runtimeStageId, T[]> for O(1) per-step lookup. One entry type, multiple entries
 * per step. Designed for recorders that implement BOTH Recorder and FlowRecorder
 * (merging data ops and control flow into a single interleaved sequence).
 *
 * **Contrast with KeyedRecorder<T>:**
 * - `KeyedRecorder<T>` — 1:1 Map. One entry per runtimeStageId. For single-value recorders
 *   like MetricRecorder (one StepMetrics per stage execution).
 * - `SequenceRecorder<T>` — 1:N sequence + Map. Multiple entries per runtimeStageId,
 *   plus ordering matters. For recorders that produce a prose narrative or event log
 *   where a single step generates stage + data + decision entries.
 *
 * **How to choose:**
 * - If each step produces exactly one record → extend `KeyedRecorder<T>`
 * - If each step produces multiple records or ordering matters → extend `SequenceRecorder<T>`
 *
 * @example
 * ```typescript
 * import { SequenceRecorder } from 'footprintjs/trace';
 *
 * interface AuditEntry {
 *   runtimeStageId?: string;
 *   type: 'read' | 'write' | 'decision';
 *   detail: string;
 * }
 *
 * class AuditRecorder extends SequenceRecorder<AuditEntry> {
 *   readonly id = 'audit';
 *
 *   // Scope hooks (fires during stage execution)
 *   onRead(event: ReadEvent) {
 *     this.emit({ runtimeStageId: event.runtimeStageId, type: 'read', detail: event.key });
 *   }
 *   onWrite(event: WriteEvent) {
 *     this.emit({ runtimeStageId: event.runtimeStageId, type: 'write', detail: event.key });
 *   }
 *
 *   // Flow hooks (fires after stage execution)
 *   onDecision(event: FlowDecisionEvent) {
 *     this.emit({
 *       runtimeStageId: event.traversalContext?.runtimeStageId,
 *       type: 'decision',
 *       detail: `${event.decider} chose ${event.chosen}`,
 *     });
 *   }
 *
 *   // Time-travel: entries up to slider position
 *   getAuditUpTo(visibleIds: ReadonlySet<string>) {
 *     return this.getEntriesUpTo(visibleIds);
 *   }
 * }
 * ```
 */
export abstract class SequenceRecorder<T extends { runtimeStageId?: string }> {
  abstract readonly id: string;

  /** Ordered sequence of all entries (insertion order). */
  private readonly entries: T[] = [];
  /** Per-step index: runtimeStageId → entries for that step. Same objects as entries[]. */
  private readonly byRuntimeStageId = new Map<string, T[]>();
  /** Per-step range index: runtimeStageId → [firstIdx, endIdx) in entries array.
   *  endIdx includes trailing keyless entries (structural markers). Maintained during emit(). */
  private readonly entryRanges = new Map<string, { firstIdx: number; endIdx: number }>();
  /** The runtimeStageId of the most recently emitted keyed entry. Used to extend ranges for trailing markers. */
  private lastEmittedId: string | undefined;

  // ── Write ─────────────────────────────────────────────────────────────

  /**
   * Append an entry to both the ordered sequence, keyed index, and range index.
   * All reference the same entry object — no duplication.
   */
  protected emit(entry: T): void {
    const idx = this.entries.length;
    this.entries.push(entry);
    const id = entry.runtimeStageId;
    if (id) {
      let arr = this.byRuntimeStageId.get(id);
      if (!arr) {
        arr = [];
        this.byRuntimeStageId.set(id, arr);
        this.entryRanges.set(id, { firstIdx: idx, endIdx: idx + 1 });
      } else {
        this.entryRanges.get(id)!.endIdx = idx + 1;
      }
      arr.push(entry);
      this.lastEmittedId = id;
    } else if (this.lastEmittedId) {
      // Structural marker (no runtimeStageId) — extend the preceding step's range
      this.entryRanges.get(this.lastEmittedId)!.endIdx = idx + 1;
    }
  }

  // ── Ordered access ────────────────────────────────────────────────────

  /** All entries in insertion order (returns a shallow copy — entry objects are shared). */
  getEntries(): T[] {
    return [...this.entries];
  }

  /** Number of entries in the sequence. */
  get entryCount(): number {
    return this.entries.length;
  }

  /** Zero-copy iteration for subclass rendering methods (avoids getEntries() spread). */
  protected forEachEntry(fn: (entry: T) => void): void {
    for (const entry of this.entries) {
      fn(entry);
    }
  }

  // ── Keyed access ──────────────────────────────────────────────────────

  /** O(1) lookup: all entries for a specific execution step (returns a copy). */
  getEntriesForStep(runtimeStageId: string): T[] {
    return [...(this.byRuntimeStageId.get(runtimeStageId) ?? [])];
  }

  /** Number of unique execution steps that have entries. */
  get stepCount(): number {
    return this.byRuntimeStageId.size;
  }

  /**
   * Pre-built range index: runtimeStageId → half-open range [firstIdx, endIdx) in entries array.
   * Maintained during emit() — no rebuild needed. Use for O(1) per-step lookups during time-travel.
   * endIdx includes trailing keyless entries (structural markers following a step).
   */
  getEntryRanges(): ReadonlyMap<string, { readonly firstIdx: number; readonly endIdx: number }> {
    return this.entryRanges;
  }

  // ── Aggregate (reduce all entries) ────────────────────────────────────

  /** Reduce ALL entries to a single value. For dashboards, totals, summaries. */
  aggregate<R>(fn: (acc: R, entry: T) => R, initial: R): R {
    let acc = initial;
    for (const entry of this.entries) {
      acc = fn(acc, entry);
    }
    return acc;
  }

  // ── Accumulate (progressive reduce) ─────────────────────────────────

  /**
   * Reduce entries, optionally filtered by a set of runtimeStageIds.
   * For time-travel progressive view: pass the runtimeStageIds visible at the current slider position.
   * Entries without runtimeStageId (structural markers) are excluded when keys are provided.
   * Without keys, reduces all entries (same as aggregate).
   */
  accumulate<R>(fn: (acc: R, entry: T) => R, initial: R, keys?: ReadonlySet<string>): R {
    let acc = initial;
    for (const entry of this.entries) {
      if (keys) {
        if (!entry.runtimeStageId || !keys.has(entry.runtimeStageId)) continue;
      }
      acc = fn(acc, entry);
    }
    return acc;
  }

  // ── Time-travel queries ───────────────────────────────────────────────

  /**
   * Progressive reveal: entries whose runtimeStageId is in the visible set.
   * Preserves insertion order. Entries without runtimeStageId (structural markers)
   * are buffered and included only when surrounded by visible steps on both sides —
   * trailing markers after the last visible step are discarded.
   */
  getEntriesUpTo(visibleIds: ReadonlySet<string>): T[] {
    const result: T[] = [];
    let pendingMarkers: T[] = [];
    for (const entry of this.entries) {
      const id = entry.runtimeStageId;
      if (!id) {
        // Structural marker — buffer until next visible keyed entry confirms it's between visible steps.
        if (result.length > 0) pendingMarkers.push(entry);
      } else if (visibleIds.has(id)) {
        // Flush buffered markers — they sit between a previous visible step and this one.
        if (pendingMarkers.length > 0) {
          result.push(...pendingMarkers);
          pendingMarkers = [];
        }
        result.push(entry);
      }
      // Non-visible keyed entries: don't discard pending markers — a later visible entry
      // may still flush them. Markers are only discarded at the end (trailing).
    }
    // Discard remaining pendingMarkers — they trail the last visible step.
    return result;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Clear all stored data. Called by executor before each run(). */
  clear(): void {
    this.entries.length = 0;
    this.byRuntimeStageId.clear();
    this.entryRanges.clear();
    this.lastEmittedId = undefined;
  }
}
