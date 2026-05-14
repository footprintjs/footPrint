/**
 * CommitRangeIndex<TLabel> — interval index over commit indices.
 *
 * Built incrementally during traversal: `open(label, startIdx)` when a
 * boundary begins, `close(token, endIdx)` when it ends. Query at any
 * commit position with `enclosing(idx)` (returns ranges containing
 * that index, ordered outer→inner) or `overlapping(start, end)`
 * (returns ranges intersecting a slice).
 *
 * See `docs/design/commit-range-index.md` for the full contract. In
 * one paragraph: this is a generic interval data structure for
 * commit-range queries. footprintjs owns ZERO knowledge of what
 * labels mean — consumers (agentfootprint, lens, OTel exporters)
 * pick their own `TLabel` type. Open ranges (mid-run, no end yet)
 * are first-class — query results carry `endIdx: undefined` for them.
 *
 * Pattern: incremental builder + interval query. Same "collect during
 *          traversal, never post-process" rule footprintjs's CLAUDE.md
 *          requires of every observer.
 * Role:    structural primitive for time-travel UIs and per-boundary
 *          aggregation.
 * Channel: consumer-driven (no engine subscription).
 *
 * @example
 * ```typescript
 * import { CommitRangeIndex } from 'footprintjs/trace';
 *
 * const idx = new CommitRangeIndex<string>();
 * const t = idx.open('LLMCall', executor.getCommitCount());
 * // ... LLM call runs, scope writes happen ...
 * idx.close(t, executor.getCommitCount());
 *
 * idx.enclosing(50);  // → ranges containing commit 50, outer→inner
 * idx.overlapping(40, 60);  // → ranges sharing the slice [40,60]
 * idx.clear();        // wipe (e.g., on new run)
 * ```
 *
 * REDACTION NOTE: labels are stored verbatim and returned verbatim in
 * query results — the index does NOT redact `TLabel` content. If a
 * consumer attaches a label containing PII (user email, scope reads
 * with sensitive keys, etc.) and then serializes the index for
 * logging or telemetry, that data leaves the trust boundary. Use
 * `RedactionPolicy` (or your own scrubbing) on the consumer side
 * BEFORE attaching labels. The index follows the same contract as
 * other footprintjs storage primitives (SequenceStore, KeyedStore):
 * storage is verbatim; redaction is the caller's responsibility.
 */

/** Opaque token identifying an open range. Hold onto it; pass to `close()`.
 *  Index-scoped — using a token from one CommitRangeIndex on another is
 *  a silent no-op (verified by the per-index `_owner` symbol).
 *
 *  SECURITY NOTE: the `_owner` symbol is enumerable on the token object
 *  via `Object.getOwnPropertySymbols(token)`. This means tokens are NOT
 *  adversary-safe — a malicious caller with access to ANY token from
 *  this index can recover the owner symbol and forge new tokens. The
 *  index is designed for in-process trust boundaries (cooperative
 *  recorders sharing one runner), not for hostile-input scenarios.
 *  If adversary-safety becomes a requirement, switch to a WeakMap-
 *  scoped token model (see security panel review Y2). */
export interface RangeToken {
  /** Per-index sequential id. Opaque to consumers — they shouldn't read it. */
  readonly _id: number;
  /** Per-index identity — prevents accidental cross-index token misuse. */
  readonly _owner: symbol;
}

/** A single range as returned by query methods. Frozen-shape — readonly fields. */
export interface RangeEntry<TLabel> {
  readonly label: TLabel;
  readonly startIdx: number;
  /** Undefined while the range is still open (mid-run boundary). */
  readonly endIdx?: number;
}

/**
 * Internal storage shape. Mutable while the range is open; once
 * closed, `endIdx` is set and never changes. Tokens reference these
 * by their position in the `entries` array (the `_id`).
 */
interface InternalEntry<TLabel> {
  label: TLabel;
  startIdx: number;
  endIdx: number | undefined;
  /** Internal cursor — assigned on `open()`, used to identify by token. */
  id: number;
  /** True after `close()` runs. Prevents double-close mutation. */
  closed: boolean;
}

export class CommitRangeIndex<TLabel> {
  private entries: InternalEntry<TLabel>[] = [];
  private byId = new Map<number, InternalEntry<TLabel>>();
  private nextId = 0;
  /** Identity for token scoping — each index gets a fresh symbol so
   *  tokens from one index can't accidentally close ranges in another.
   *  ROTATED on `clear()` to invalidate stale tokens that survived a
   *  run reset (would otherwise hit a recycled id and silently mutate
   *  a different range — see DS+logic panel review RED #1). */
  private owner = Symbol('CommitRangeIndex');

  /**
   * Open a new range. Returns a token the caller MUST hold and pass
   * to `close()` later. Each `open()` gets a fresh token; tokens
   * cannot be reused or shared across indices (silent no-op if
   * misused — see Law 2 in the design doc). Tokens from BEFORE
   * the most recent `clear()` are also invalid (owner symbol
   * rotates on clear).
   */
  open(label: TLabel, startIdx: number): RangeToken {
    const id = this.nextId++;
    const entry: InternalEntry<TLabel> = {
      label,
      startIdx,
      endIdx: undefined,
      id,
      closed: false,
    };
    this.entries.push(entry);
    this.byId.set(id, entry);
    return { _id: id, _owner: this.owner };
  }

  /**
   * Close an open range at `endIdx` (inclusive). After close, the
   * range is queryable with both bounds. Closing an already-closed
   * token is a no-op. Closing an unknown token (from another index,
   * or fabricated) is a no-op.
   */
  close(token: RangeToken, endIdx: number): void {
    if (token._owner !== this.owner) return; // cross-index misuse — silent no-op
    const entry = this.findById(token._id);
    if (!entry || entry.closed) return;
    entry.endIdx = endIdx;
    entry.closed = true;
  }

  /**
   * Returns ALL ranges enclosing `commitIdx`, ordered outer→inner.
   * Includes both closed and open ranges. For a closed range to
   * enclose: `startIdx <= commitIdx <= endIdx`. For an open range:
   * `startIdx <= commitIdx` (no upper bound check).
   *
   * Ordering rule: ascending by `startIdx`, with TIES BROKEN BY
   * descending `endIdx` (wider range = outer). Open ranges (endIdx
   * undefined) are treated as `+Infinity` for tie-break — they
   * always sort outer of any closed range starting at the same idx.
   * This is the only deterministic outer→inner ordering when two
   * boundaries open at the same commit (e.g., Parallel root +
   * its first branch).
   *
   * Returns a SHALLOW IMMUTABLE COPY — caller mutations don't affect
   * internal state.
   */
  enclosing(commitIdx: number): readonly RangeEntry<TLabel>[] {
    const matches: RangeEntry<TLabel>[] = [];
    for (const e of this.entries) {
      if (e.startIdx > commitIdx) continue;
      if (e.endIdx === undefined || e.endIdx >= commitIdx) {
        matches.push(toEntry(e));
      }
    }
    matches.sort(outerToInnerComparator);
    return matches;
  }

  /**
   * Returns all ranges OVERLAPPING the slice `[startIdx, endIdx]`. A
   * range overlaps if it shares at least one commit position with the
   * slice. Use for parallel-branch detection, time-window queries,
   * or "what boundaries fired during this slice."
   *
   * Sorted by the SAME outer→inner comparator as `enclosing()`:
   * ascending by `startIdx`, ties broken by descending `endIdx`
   * (wider = outer; open ranges treated as +Infinity).
   *
   * Returns a SHALLOW IMMUTABLE COPY.
   */
  overlapping(startIdx: number, endIdx: number): readonly RangeEntry<TLabel>[] {
    const matches: RangeEntry<TLabel>[] = [];
    for (const e of this.entries) {
      // Overlap test:
      //   range starts after slice ends → no overlap
      //   range ends (closed) before slice starts → no overlap
      //   otherwise → overlap (open ranges always overlap if they start <= endIdx)
      if (e.startIdx > endIdx) continue;
      if (e.endIdx !== undefined && e.endIdx < startIdx) continue;
      matches.push(toEntry(e));
    }
    matches.sort(outerToInnerComparator);
    return matches;
  }

  /** Total range count (open + closed). */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Wipe all ranges + reset the token counter AND rotate the owner
   * symbol so any token from before this clear becomes invalid.
   * Critical: without rotating the owner, a stale token whose `_id`
   * happens to match a recycled id after clear would silently mutate
   * the wrong entry. Owner rotation makes stale-token close a no-op
   * via the `_owner !== this.owner` guard.
   *
   * Call from a consumer's runId guard when a new run starts (e.g.,
   * agentfootprint's `observeRunId(onNewRun)` from Phase 2).
   */
  clear(): void {
    this.entries.length = 0;
    this.byId.clear();
    this.nextId = 0;
    this.owner = Symbol('CommitRangeIndex');
  }

  // ─── Internals ────────────────────────────────────────────────────

  /** O(1) lookup by token id. Always returns the entry that the token
   *  references (or undefined if the id was never opened in this index). */
  private findById(id: number): InternalEntry<TLabel> | undefined {
    return this.byId.get(id);
  }
}

/** Project the internal mutable shape into the public readonly entry.
 *  The OUTER object is a fresh allocation per query (so caller array
 *  mutations don't leak). The `label` field is a REFERENCE COPY —
 *  if `TLabel` is an object, mutating its fields will affect the
 *  internal entry too. Consumers MUST treat labels as immutable
 *  (or pass primitives). Documented in the class JSDoc as the
 *  "labels are stored verbatim" contract. */
function toEntry<TLabel>(e: InternalEntry<TLabel>): RangeEntry<TLabel> {
  return e.endIdx === undefined
    ? { label: e.label, startIdx: e.startIdx }
    : { label: e.label, startIdx: e.startIdx, endIdx: e.endIdx };
}

/**
 * Shared outer→inner comparator for both `enclosing()` and
 * `overlapping()`. Primary key: `startIdx` ascending. Tie-break:
 * `endIdx` descending (wider range is outer). Open ranges (undefined
 * `endIdx`) sort as +Infinity → outermost when tied. Deterministic
 * ordering required so consumers (Lens breadcrumb, time-travel UIs)
 * never see flicker on equal-start boundaries (e.g., a Parallel
 * root and its first branch opening at the same commit).
 */
function outerToInnerComparator<TLabel>(a: RangeEntry<TLabel>, b: RangeEntry<TLabel>): number {
  if (a.startIdx !== b.startIdx) return a.startIdx - b.startIdx;
  const ae = a.endIdx ?? Number.POSITIVE_INFINITY;
  const be = b.endIdx ?? Number.POSITIVE_INFINITY;
  return be - ae;
}
