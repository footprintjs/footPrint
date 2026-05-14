/**
 * SequenceStore<T> — concrete, composable storage for ordered sequence data.
 *
 * Pattern: COMPOSITION primitive. Concrete class — instantiate with
 *          `new SequenceStore<T>()` and own it as a field on your
 *          recorder. Replaces the abstract `SequenceRecorder<T>` base
 *          class for the v5 "one purpose per recorder" rule:
 *          stores ARE storage; recorders ARE event handlers; consumers
 *          COMPOSE.
 * Role:    Dual-indexed append-only sequence: a flat array preserving
 *          insertion order plus a `Map<runtimeStageId, T[]>` for O(1)
 *          per-step lookup. Plus a precomputed range index for time-
 *          travel scrubbing.
 *
 * @example
 * ```typescript
 * import { SequenceStore } from 'footprintjs/trace';
 * import type { ScopeRecorder } from 'footprintjs';
 *
 * interface AuditEntry {
 *   runtimeStageId?: string;
 *   type: 'read' | 'write' | 'decision';
 *   detail: string;
 * }
 *
 * // ONE PURPOSE: scope-event handler. Storage is composed in.
 * class AuditRecorder implements ScopeRecorder {
 *   readonly id = 'audit';
 *   private readonly store = new SequenceStore<AuditEntry>();
 *
 *   onRead(event: ReadEvent) {
 *     this.store.push({
 *       runtimeStageId: event.runtimeStageId,
 *       type: 'read',
 *       detail: event.key,
 *     });
 *   }
 *   onWrite(event: WriteEvent) {
 *     this.store.push({
 *       runtimeStageId: event.runtimeStageId,
 *       type: 'write',
 *       detail: event.key,
 *     });
 *   }
 *
 *   getAudit() { return this.store.getAll(); }
 *   getAuditUpTo(ids: ReadonlySet<string>) {
 *     return this.store.getEntriesUpTo(ids);
 *   }
 *
 *   clear() { this.store.clear(); }
 * }
 * ```
 *
 * **Contrast with `KeyedStore<T>`:** SequenceStore stores 1:N entries
 * per runtimeStageId in insertion order. Use KeyedStore for 1:1
 * (one record per step — token counts, metric snapshots).
 */
export class SequenceStore<T extends { runtimeStageId?: string }> {
  /** Ordered sequence of all entries (insertion order). */
  private readonly entries: T[] = [];
  /** Per-step index: runtimeStageId → entries for that step. Same objects as `entries[]`. */
  private readonly byRuntimeStageId = new Map<string, T[]>();
  /** Per-step range index: runtimeStageId → [firstIdx, endIdx) in entries array.
   *  endIdx includes trailing keyless entries (structural markers). Maintained during push(). */
  private readonly entryRanges = new Map<string, { firstIdx: number; endIdx: number }>();
  /** The runtimeStageId of the most recently emitted keyed entry. Used to extend
   *  ranges for trailing markers (entries without runtimeStageId attached after a step). */
  private lastEmittedId: string | undefined;

  // ── Write ────────────────────────────────────────────────────────────

  /**
   * Append an entry to both the ordered sequence, keyed index, and range index.
   * All three reference the SAME entry object — no duplication.
   */
  push(entry: T): void {
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
      // Structural marker (no runtimeStageId) — extend the preceding step's range.
      this.entryRanges.get(this.lastEmittedId)!.endIdx = idx + 1;
    }
  }

  // ── Ordered access ───────────────────────────────────────────────────

  /** All entries in insertion order. Returns a shallow copy — entry objects are shared. */
  getAll(): T[] {
    return [...this.entries];
  }

  /** Number of entries in the sequence. */
  get size(): number {
    return this.entries.length;
  }

  /** Zero-copy iteration. Avoids the `getAll()` spread when the caller just needs
   *  to walk the entries (e.g., aggregating, rendering). */
  forEach(fn: (entry: T) => void): void {
    for (const entry of this.entries) fn(entry);
  }

  // ── Keyed access ─────────────────────────────────────────────────────

  /** O(1) lookup: all entries for a specific execution step. Returns a copy. */
  getByKey(runtimeStageId: string): T[] {
    return [...(this.byRuntimeStageId.get(runtimeStageId) ?? [])];
  }

  /** Number of distinct execution steps that have at least one entry. */
  get keyCount(): number {
    return this.byRuntimeStageId.size;
  }

  /**
   * Pre-built range index: runtimeStageId → half-open `[firstIdx, endIdx)`
   * range in the entries array. Maintained during `push()` — no rebuild
   * needed. Use for O(1) per-step lookups during time-travel scrubbing.
   * `endIdx` includes trailing keyless entries (structural markers
   * following a step).
   */
  getEntryRanges(): ReadonlyMap<string, { readonly firstIdx: number; readonly endIdx: number }> {
    return this.entryRanges;
  }

  // ── Aggregate (reduce all entries) ───────────────────────────────────

  /** Reduce ALL entries to a single value. For dashboards, totals, summaries. */
  aggregate<R>(fn: (acc: R, entry: T) => R, initial: R): R {
    let acc = initial;
    for (const entry of this.entries) acc = fn(acc, entry);
    return acc;
  }

  // ── Accumulate (progressive reduce) ──────────────────────────────────

  /**
   * Reduce entries, optionally filtered by a set of `runtimeStageIds`.
   * For time-travel progressive view: pass the runtimeStageIds visible
   * at the current slider position. Entries without `runtimeStageId`
   * (structural markers) are excluded when keys are provided. Without
   * keys, reduces all entries (same as `aggregate`).
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

  // ── Time-travel ──────────────────────────────────────────────────────

  /**
   * Progressive reveal: entries whose `runtimeStageId` is in the visible
   * set. Preserves insertion order. Entries without `runtimeStageId`
   * (structural markers) are buffered and included only when surrounded
   * by visible steps on both sides — trailing markers after the last
   * visible step are discarded.
   */
  getEntriesUpTo(visibleIds: ReadonlySet<string>): T[] {
    const result: T[] = [];
    let pendingMarkers: T[] = [];
    for (const entry of this.entries) {
      const id = entry.runtimeStageId;
      if (!id) {
        if (result.length > 0) pendingMarkers.push(entry);
      } else if (visibleIds.has(id)) {
        if (pendingMarkers.length > 0) {
          result.push(...pendingMarkers);
          pendingMarkers = [];
        }
        result.push(entry);
      }
    }
    return result;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Clear all stored data. Recorders typically call this from their own
   *  `clear()` method, which the executor invokes before each run. */
  clear(): void {
    this.entries.length = 0;
    this.byRuntimeStageId.clear();
    this.entryRanges.clear();
    this.lastEmittedId = undefined;
  }
}
