# CommitRangeIndex — design

Last revised: Phase 5 Layer 1 of v5 migration (footprintjs 5.1).

This document is the canonical reference for the `CommitRangeIndex<TLabel>`
primitive added to `footprintjs/trace`, plus the small companion API
`executor.getCommitCount()`.

Read it before modifying anything in `src/lib/recorder/CommitRangeIndex.ts`
or its tests. Read it FIRST as a downstream consumer (agentfootprint,
agentfootprint-lens, OTel exporter) building on top.

---

## 1. Why this exists

footprintjs already exposes the `commitLog`: an ordered array of
`CommitBundle` entries, one per scope commit, the canonical write-time
axis of a run. Existing trace utilities (`findCommit`, `findCommits`,
`findLastWriter`, `causalChain`) operate on the flat array.

What's missing: the ability to ask **"at commit index N, which logical
boundaries enclose me?"** — and ask it efficiently for long runs.

Boundaries (LLMCall, Agent, Sequence, Parallel, Conditional, Loop, or
any consumer-defined unit) NEST and OVERLAP. Two parallel branches
write to the commit log concurrently — their commit ranges interleave.
Sequence stages chain — their ranges abut. Agent's ReAct loop iterates
— its range encompasses many inner LLMCall ranges.

Consumers (Lens commentary slider, time-travel UIs, OTel exporters,
audit-log diff tools) need to query the boundary structure at any
commit index. A flat-list scan is O(N×M) where N = commits, M = boundaries
— prohibitive for long runs.

`CommitRangeIndex<TLabel>` is the data structure: an interval index over
the commit log, supporting incremental insertion (open during traversal),
late closing (close on boundary exit), and O(log N) queries.

---

## 2. Two laws

### Law 1 — built incrementally during traversal, never post-walked

The index is constructed event-by-event as the engine traverses. A
boundary's `open()` fires on entry; `close()` fires on exit. NEVER walk
the commit log after the fact to build the index — that's the same
post-processing anti-pattern footprintjs's CLAUDE.md forbids.

Consumer pattern:
- Boundary entry observed → `index.open(label, executor.getCommitCount())`
  → store the returned `RangeToken`.
- Boundary exit observed → `index.close(token, executor.getCommitCount())`.

For OPEN boundaries (live mid-run), queries return the range with
`endIdx: undefined`. UIs render in-flight boundaries explicitly.

### Law 2 — generic over `TLabel`, owns ZERO domain knowledge

footprintjs has no concept of LLMs, tools, agents, or any domain.
`CommitRangeIndex<TLabel>` is parameterized over the label type — could
be a string, an object, a class instance, anything the consumer wants
to attach.

Examples:
- agentfootprint BoundaryRecorder uses `CommitRangeIndex<DomainEvent>`.
- An OTel exporter might use `CommitRangeIndex<{ spanId: string; kind: string }>`.
- A simple test uses `CommitRangeIndex<string>` with a name.

The primitive does not validate, parse, or interpret labels. It just
stores them and returns them on queries.

---

## 3. API surface

### `executor.getCommitCount(): number`

O(1) accessor. Returns `executor.getSnapshot().commitLog.length` without
materializing the full snapshot. Use this when stamping `commitIdx` onto
events, or when polling commit progress without snapshot cost.

```ts
const before = executor.getCommitCount();
// ... some work that may write commits ...
const after = executor.getCommitCount();
console.log(`${after - before} commits happened in this slice`);
```

### `CommitRangeIndex<TLabel>`

```ts
export interface RangeToken {
  /** Opaque to consumers — used by close() to identify the range. */
  readonly _id: number;
}

export interface RangeEntry<TLabel> {
  readonly label: TLabel;
  readonly startIdx: number;
  /** Undefined while the range is still open. */
  readonly endIdx?: number;
}

export class CommitRangeIndex<TLabel> {
  /**
   * Open a new range starting at `startIdx`. Returns a token that the
   * consumer MUST hold and pass to `close()` later. Tokens are scoped
   * to this index — using a token from one index in another is a
   * silent no-op.
   */
  open(label: TLabel, startIdx: number): RangeToken;

  /**
   * Close an open range at `endIdx` (inclusive — the range covers
   * commits [startIdx, endIdx]). After close, the range is queryable
   * with both bounds defined. Closing an already-closed token is a
   * no-op. Closing an unknown token is a no-op.
   */
  close(token: RangeToken, endIdx: number): void;

  /**
   * Returns ALL ranges that enclose `commitIdx`, ordered outer→inner
   * by `startIdx` (outermost first). Includes open ranges (their
   * `endIdx` is undefined). For a closed range to enclose `commitIdx`,
   * `startIdx <= commitIdx <= endIdx`. For an open range, only
   * `startIdx <= commitIdx`.
   *
   * Returns a SHALLOW COPY — caller mutations don't leak into the index.
   */
  enclosing(commitIdx: number): readonly RangeEntry<TLabel>[];

  /**
   * Returns all ranges OVERLAPPING the slice `[startIdx, endIdx]`.
   * A range overlaps if it shares at least one commit index with
   * the slice. Use this for parallel-branch detection (multiple
   * ranges sharing the slice).
   */
  overlapping(startIdx: number, endIdx: number): readonly RangeEntry<TLabel>[];

  /** Total number of ranges (open + closed). */
  get size(): number;

  /**
   * Wipe all ranges + reset internal token counter. Call from a
   * consumer's runId guard when a new run starts (same pattern as
   * `SequenceStore.clear()` from Phase 1).
   */
  clear(): void;
}
```

---

## 4. Data structure choice

For the v5.1 first cut: **linear-scan over an unsorted array** for
queries, with O(1) `byId` Map for token lookup on `close()`. Complexity:

| Operation | Current (v5.1) | Future (interval tree) |
|---|---|---|
| `open()` | O(1) array push + Map set | O(log N) tree insert |
| `close()` | O(1) Map lookup + flag flip | O(log N) tree update |
| `enclosing(idx)` | O(N) scan + O(K log K) sort | O(log N + K) tree walk |
| `overlapping(slice)` | O(N) scan + O(K log K) sort | O(log N + K) tree walk |

Linear scan is sufficient at the design target (100-500 boundaries
per run = ~25-125µs per query, well under 16ms for 60fps UIs). The
load-test budget — 20k ranges, single query < 50ms — confirms headroom.

For 100k+ ranges (audit-log diff tools over long-running servers),
the linear scan degrades. Future opportunity (section 9): replace
internal storage with a true **centered-interval tree** for
O(log N + K) queries. The public API does not change — internal swap
only. We deliberately choose a simpler structure first to keep the
code readable; the API contract is what's hard to change.

---

## 5. Concurrency

Single-threaded (Node.js). No locking needed. Two concurrent runs from
the same library use SEPARATE index instances (one per consumer, per
run). Run-isolation is a CONSUMER concern — the index doesn't enforce
it. agentfootprint's BoundaryRecorder calls `index.clear()` from its
existing `observeRunId` guard.

---

## 6. Test contract (Convention 3 — all 7 types)

| Type | Asks |
|---|---|
| Unit | `open + close + enclosing` round-trip; `clear()` empties; `size` accurate; tokens from one index don't affect another |
| Functional | Nested ranges (Sequence > Agent > LLMCall) → `enclosing(N)` returns ordered outer→inner |
| Integration | Wire to a real footprintjs executor's commitLog via a recorder that opens/closes per boundary; verify counts |
| Property | Random insert + random query → invariants hold (range hit count ≤ overlap count; outer ranges always enclose inner ones) |
| Security | `enclosing` / `overlapping` return shallow-immutable arrays; tokens scoped to one index |
| Performance | 10k inserts + 10k queries < 50ms total |
| Load | 1M closed ranges, random queries remain < 1ms each |

---

## 7. Migration impact

Purely additive. No existing trace exports change. No CLAUDE.md
breaking sections.

To CLAUDE.md, add a one-line bullet under the trace section's
"Exports from `footprintjs/trace`" table:

```
| `CommitRangeIndex<TLabel>` | class | Interval index for commit-range queries. Open during traversal, query at any commit position for enclosing/overlapping ranges. Use for time-travel UIs and per-boundary aggregation. |
```

---

## 8. What this does NOT do

- Does NOT compute diffs over a range. Consumer folds `commitLog.slice(start, end + 1)` themselves.
- Does NOT store payloads — only labels (consumer's choice of key).
- Does NOT enforce non-overlapping ranges. Overlap is a real-world
  condition (parallel branches) and the index handles it correctly.
- Does NOT track commit log identity. If the consumer swaps commit logs
  between calls, the index will return stale indices. Consumer's job
  to clear() on commit-log replacement (typically: on run reset).

---

## 9. Future opportunities (not in scope for Layer 1)

- **Run-aware index** that takes a runId and clears automatically on
  change. Skipped because consumers (agentfootprint) already have
  `observeRunId` from Phase 2; layering it again here is duplication.
- **Index over keys/stages** — e.g., "all commits that touched key
  `'systemPrompt'`". Different shape, different access pattern. Could
  be added later as `CommitKeyIndex<TKey>`.
- **Range diff convenience** — `diffRange(commitLog, range)` that folds
  commits' `overwrite + updates` into a net-effect object. Skipped
  because consumers want different fold strategies; expose the fold
  pattern via examples.

---

## 10. Implementation milestones

1. Write `CommitRangeIndex.ts` + `RangeToken` + `RangeEntry` types.
2. Add `executor.getCommitCount()` to FlowChartExecutor.
3. Write 7-pattern tests in `test/lib/recorder/CommitRangeIndex.test.ts`.
4. Add export to `footprintjs/trace`.
5. 7-panel review.
6. Run agentfootprint + lens suites — confirm no breakage (zero new
   failures because additive only).

No external publish. Local-only until Layer 4 lands and playground
validates end-to-end.
