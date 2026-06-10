# Design memo — #13c-B: the `append` commit verb (delta commits, lossless)

> Status: **DRAFT — decisions pending** (see §8). Audience: library
> maintainers + downstream consumers (agentfootprint, lens, explainable-ui).
> Base: footprintjs v9.5.0.
> Related: [`commit-change-semantics.md`](commit-change-semantics.md) (the
> change-only contract this extends),
> [`rfc-001-deferred-observers.md`](rfc-001-deferred-observers.md) (the
> envelope/wire-format sibling — designed jointly, §6),
> [`TransactionBuffer`](../../src/lib/memory/TransactionBuffer.ts),
> [`applySmartMerge`](../../src/lib/memory/utils.ts),
> [`EventLog`](../../src/lib/memory/EventLog.ts), `bench/BASELINE.md` §E.

## Executive summary

The commit log stores the **full final value** of every changed path. For a
growing tracked array (the agent `history` — one ~1KB message appended per
iteration) that means bundle *i* stores an *i*-element array: the log retains
`N(N+1)/2` messages — the **last O(N²) retained-heap term** after #13b/#13c-A
(measured ≈18MB at N=200; the agentfootprint stack still OOMs a default 2GB
Node heap at N=1000 even with `readTracking`+`writeTracking: 'summary'`).
This memo adds an **`append` verb** to the commit `trace`: when a stage's net
change to an array is "the old array plus a tail", the bundle records **only
the tail**, and replay (`applySmartMerge`) reconstructs the full array by
concatenation. It also absorbs the long-documented **`delete` verb** (B8) so
the bundle contract evolves **once**. The change is **lossless by
construction** — any step's full state remains exactly reconstructable by
replaying deltas (the invariant in §3, property-tested) — and, under the
recommended encoding (§2.3), the `CommitBundle` **field set does not change**:
only the `TraceEntry.verb` union widens. The verified consumer matrix (§4)
shows every shipped consumer either reads only `trace.path`/indices
(unaffected) or sits on the event tier, not the bundle tier (audit chain #20,
OTel #19, narrative, eui CommitFlow — all unaffected). The one real semantic
break is "read `bundle.overwrite[key]` as *the full value written*", which
gets a replacement helper. Recommended path: opt-in
`commitVerbs: 'v2'` in a minor release, agentfootprint opts in immediately,
default flips at the next major (§5).

---

## 1. Problem — the history-append snowball

### 1.1 The mechanism, file by file

A TypedScope array write is **copy-on-write into a `set`**:
`scope.history.push(msg)` and `$batchArray` both end in `setValue(key,
newFullArray)` ([`createTypedScope.ts:331`](../../src/lib/reactive/createTypedScope.ts),
`:366`, `:67-75`). That `set` then pays for the full array three times per
stage:

1. **Write time** — `TransactionBuffer.set()` stores
   `structuredClone(value)` into `overwritePatch`
   ([`TransactionBuffer.ts:42`](../../src/lib/memory/TransactionBuffer.ts)):
   one full-array clone, O(i).
2. **Commit time** — `toChangeOnlyPayload()` deep-compares base vs final
   (`deepEqual` length-check fast-fails in O(1) for a grown array,
   [`utils.ts:187`](../../src/lib/memory/utils.ts)), then clones the **full
   final array again** into the bundle
   ([`TransactionBuffer.ts:172`](../../src/lib/memory/TransactionBuffer.ts)):
   a second O(i) clone — and this one is **retained forever** by
   `EventLog.record()` ([`EventLog.ts:35-38`](../../src/lib/memory/EventLog.ts),
   exposed as `snapshot.commitLog` via
   [`ExecutionRuntime.ts:153`](../../src/lib/runner/ExecutionRuntime.ts)).
3. **Apply time** — `SharedMemory.applyPatch` → `applySmartMerge` clones the
   **whole state** and the set-value once more
   ([`SharedMemory.ts:59-60`](../../src/lib/memory/SharedMemory.ts),
   [`utils.ts:242,246`](../../src/lib/memory/utils.ts)). (Wall cost only —
   the old generation is dropped; this is the immutable-after-swap mechanism.)

Cost (1) and (3) are transient (GC-able); cost (2) is the **retained**
quadratic: `commitLog` heap = Σᵢ O(i) = O(N²).

### 1.2 Measured numbers (backlog #18 + bench §E)

| Measurement | Value | Source |
|---|---|---|
| af full-feature agent, N=200, pre-#13b | 563.8MB retained; heap ≈ 0.0145·i² MB, wall ≈ 0.14·i² ms | #18 verdict |
| af N=500 pre-#13b | OOM, default 2GB Node heap | #18 |
| af N=1000 pre-#13b | ~14GB projected | #18 |
| fp-only probe N=200 post-#13b | 137.2 → **59.7MB** | bench §E |
| fp-only N=500 post-#13b | 849 → **365.9MB** | bench §E |
| — of which **commitLog** @ N=200 | **≈18MB** — "each bundle records the full changed array, by design" | bench §E Finding 5 |
| — of which `stageReads`+`stageWrites` clones @ N=200 | ≈36MB → addressed by #14 + #13c-A dials | bench §E Findings 5–6 |
| af N=200 post-#13b + `summary` dials | 132MB | #13c-A re-measure |
| af N=500 post-#13b + dials | 748MB (was OOM) | #13c-A re-measure |
| **af N=1000 post-everything-shipped** | **still OOM @ 2GB** — the #13c-B target | #13c-A re-measure |

### 1.3 What #13c-A's dial deliberately did NOT cover — and why

`writeTracking: 'full'|'summary'|'off'` gates **only** the `_stageWrites`
snapshot bookkeeping (and the `onCommit` observer's mutations payload). The
commit log was **explicitly excluded**:
[`types.ts:106-108`](../../src/lib/memory/types.ts) — *"The writes themselves
still commit to shared state and **still appear in the commit log** — only
the per-stage snapshot bookkeeping is affected."* The reason is principled,
not an oversight: the commit log is the **audit substrate** — it feeds
`findLastWriter`, `causalChain`, time-travel `materialise()`, and the
explainability brand's "reconstruct why" claim. A lossy dial there
(`'summary'` markers instead of values) would destroy the reconstruction
guarantee. The commit log can only be shrunk **losslessly** — by changing the
*encoding* (deltas), never the *information*. That is #13c-B.

### 1.4 Why `merge` writes don't have this problem (and why that's the hint)

The `merge` verb already records **deltas**: `TransactionBuffer.merge()`
accumulates only the merged-in value into `updatePatch`
([`TransactionBuffer.ts:54`](../../src/lib/memory/TransactionBuffer.ts)), and
replay reconstructs via `deepSmartMerge`. The quadratic lives entirely on the
**`set` path** — exactly where TypedScope's copy-on-write array writes land.
`append` is "the delta-encoding the `set` path is missing", with plain-concat
replay semantics (NOT `deepSmartMerge`'s union-dedup — see §2.5).

---

## 2. The design — `append` (and `delete`) in the bundle contract

### 2.1 Verb vocabulary

```ts
// src/lib/memory/types.ts — TraceEntry (today: types.ts:21-26)
export interface TraceEntry {
  path: string;
  verb: 'set' | 'merge' | 'append' | 'delete';   // ← widened union
}
```

- **`append`** — the path's final value is its base value plus a tail of new
  trailing elements; the bundle stores **only the tail**.
- **`delete`** (absorbs backlog B8) — the key was explicitly removed. Closes
  the documented `MemoryPatch` limitation
  ([`TransactionBuffer.ts:112-116`](../../src/lib/memory/TransactionBuffer.ts),
  [`commit-change-semantics.md`](commit-change-semantics.md) §Known
  limitations). Note the surrounding vocabulary **already exists**:
  `ScopeFacade.deleteValue()` ships today
  ([`ScopeFacade.ts:577-580`](../../src/lib/scope/ScopeFacade.ts)) and the
  commit-observer type already names `operation: 'set'|'update'|'delete'`
  ([`StageContext.ts:422`](../../src/lib/memory/StageContext.ts)) — only the
  **bundle** flattens delete into `set: undefined`. v2 maps `deleteValue`
  through a real `delete` trace entry; replay removes the key
  (`nativeDelete` to add in `pathOps.ts`).

No `replace-at-index` / `truncate` verbs in v1 — open decision §8.1; any
non-append array change falls back to today's `set` (full value, lossless).

### 2.2 Detection — in `toChangeOnlyPayload()`, at commit

Detection happens at the **commit-time net-change diff**, NOT per write —
the same seam the change-only contract chose, for the same reason
([`TransactionBuffer.ts:86-95`](../../src/lib/memory/TransactionBuffer.ts)):
a per-write classification misreads multi-write stages (push → splice →
push), while the commit holds the truthful endpoints `baseSnapshot` →
`workingCopy`.

For each surviving path whose ops include a `set`:

```
b = base value at path, f = final value at path
if Array.isArray(b) && Array.isArray(f)
   && f.length > b.length
   && prefixEqual(b, f)          // ← the new check
then verb = 'append', payload = structuredClone(f.slice(b.length))
else verb = 'set',    payload = structuredClone(f)        // today's path

prefixEqual(b, f):
  for i in 0..b.length-1:
    if b[i] === f[i] continue          // reference fast path
    if !deepEqual(b[i], f[i]) return false
  return true
```

Edge rules:
- `b === undefined` (first write of the array) → **`set`** of the full
  array. Append-from-empty would be equivalent for replay, but `set` keeps
  the first write as the causal anchor for "who initialized this key".
- Shrink, in-place element mutation, reorder → `set` (full value), exactly
  today's behavior. Losslessness never depends on detection succeeding.
- Non-arrays, `merge`-only paths → unchanged (`set`/`merge` as today).
- `redactedPaths` apply to appended tails through the same `redactPatch`
  pass over the bag ([`StageContext.ts:496-497`](../../src/lib/memory/StageContext.ts))
  — no new redaction surface.

**Cost model vs today.** Today's `deepEqual(b, f)` on a grown array
fast-fails on length in O(1) ([`utils.ts:187`](../../src/lib/memory/utils.ts))
— so the prefix walk is *new* work, O(|b|) compares. What it buys: the O(|f|)
`structuredClone` into the bundle shrinks to O(|tail|), and the **retained**
heap for the path drops from O(|f|) to O(|tail|). `deepEqual` allocates
nothing ([`utils.ts:166-168`](../../src/lib/memory/utils.ts) — "strictly
cheaper than the structuredClone the commit already performs"), so on a hit
the commit gets cheaper in both wall and heap. On a miss (prefix diverges at
the last element) the commit pays compare + full clone ≈ worst-case ~2× one
of today's two clones — bounded, and rare for the workloads that matter
(agent histories are append-only).

One honest caveat: today `baseSnapshot` and `workingCopy` are **independent
clones** ([`TransactionBuffer.ts:35-36`](../../src/lib/memory/TransactionBuffer.ts)),
so `b[i] === f[i]` rarely hits and `prefixEqual` runs structural `deepEqual`
per prefix element — O(array bytes) per commit, i.e. the **wall** keeps a
small quadratic term (≈1ms/commit at i=1000 with 1KB messages; Σ ≈ 0.5s at
N=1000) even though the **retained heap** becomes linear. The companion
optimization — make `baseSnapshot` a bare reference to the first-touch state
view (safe under the immutable-after-swap invariant already relied on by
`stateView`, [`StageContext.ts:209-215`](../../src/lib/memory/StageContext.ts))
so prefix elements compare by identity — is **deliberately a separate
decision** (§8.5): it touches the #13 first-touch anchor that was
adversarially reviewed for parallel forks. v1 of #13c-B works without it;
heap is the OOM, and heap is fixed either way.

(Also out of v1 scope, listed for honesty: the **write-time** clone in
`set()` ([`TransactionBuffer.ts:42`](../../src/lib/memory/TransactionBuffer.ts))
and the **apply-time** whole-state clone in `applySmartMerge`
([`utils.ts:242`](../../src/lib/memory/utils.ts)) remain O(i)/O(state) wall
costs per commit. Both are transient; neither contributes to the OOM. They
are the follow-up rows in §7.)

### 2.3 Bundle schema — where the tail lives

Three candidate encodings were considered:

| Option | Encoding | Verdict |
|---|---|---|
| (i) new `appends: MemoryPatch` field | explicit, but every shape consumer must learn a third bag — verified break: lens `overwriteKeys` (§4) misses appended keys → slot highlight goes dark for `history` | rejected |
| (ii) **tail in `overwrite`, verb-discriminated** | `trace` verb `'append'` says "interpret `overwrite[path]` as a tail"; field set of `CommitBundle` unchanged | **recommended** |
| (iii) tail in `updates` | reuses the existing delta bag, but `updates` replay is `deepSmartMerge` union-dedup — two different array semantics in one bag, discriminated only by verb; invites consumer confusion | rejected |

Option (ii) keeps [`CommitBundle`](../../src/lib/memory/types.ts) (types.ts:29-46)
**byte-compatible in shape**: same fields, same bags. The `trace` already
drives replay verb-by-verb ([`utils.ts:243-251`](../../src/lib/memory/utils.ts))
— `append` is a third arm of that switch, reading from `overwrite` like
`set` does. Every consumer that enumerates keys (`Object.keys(overwrite)`)
keeps seeing the changed key; only consumers that interpret the **value** as
"the full final value" see a semantic change (§4, last row).

A worked example (agent loop, iteration 7, `history` had 6 messages):

```jsonc
// v1 (today)                              // v2 (commitVerbs: 'v2')
{                                          {
  "stage": "CallLLM",                        "stage": "CallLLM",
  "stageId": "call-llm",                     "stageId": "call-llm",
  "runtimeStageId": "call-llm#41",           "runtimeStageId": "call-llm#41",
  "trace": [                                 "trace": [
    { "path": "runs\u001Fr1\u001Fhistory",     { "path": "runs\u001Fr1\u001Fhistory",
      "verb": "set" }                            "verb": "append" }
  ],     // \u001F = the DELIM separator        ],
  "overwrite": { "runs": { "r1": {           "overwrite": { "runs": { "r1": {
    "history": [ /* ALL 7 messages */ ]        "history": [ /* ONLY message 7 */ ]
  } } },                                     } } },
  "updates": {}, "redactedPaths": []         "updates": {}, "redactedPaths": []
}                                          }
```

### 2.4 Replay — `applySmartMerge` (one function, three call sites for free)

```ts
// utils.ts applySmartMerge — new arms in the existing verb switch
if (verb === 'append') {
  const cur = _get(out, segs);
  const tail = structuredClone(_get(overwrite, segs));
  if (Array.isArray(cur)) _set(out, segs, [...cur, ...tail]);
  else {
    // out-of-order / corrupted replay base — degrade losslessly-as-possible:
    // treat tail as the value; dev mode warns (gate on isDevMode() at the
    // CALLER (StageContext/EventLog) — utils.ts stays dependency-free).
    _set(out, segs, tail);
  }
} else if (verb === 'delete') {
  nativeDelete(out, segs);   // new pathOps primitive, prototype-pollution-safe
}
```

Because `applySmartMerge` is the single replay primitive, all three replay
consumers inherit v2 automatically:
- **live state** — `SharedMemory.applyPatch`
  ([`SharedMemory.ts:59-60`](../../src/lib/memory/SharedMemory.ts));
- **time travel** — `EventLog.materialise()`
  ([`EventLog.ts:25-32`](../../src/lib/memory/EventLog.ts));
- **the redacted mirror** — `StageContext.commit()`'s second `applyPatch`
  ([`StageContext.ts:499`](../../src/lib/memory/StageContext.ts)).

### 2.5 Ordering — multiple ops on the same key in one stage

Today `opTrace` records one entry **per operation** — three pushes in one
stage yield three `{path, verb:'set'}` trace entries, each surviving the
net-change filter (each compares base vs the same final), and replay applies
the same final value three times: **idempotent, merely redundant**. An
`append` entry is **NOT idempotent** — replaying "tail" k times concatenates
k tails. v2 therefore tightens the trace contract:

> **v2 trace rule: exactly ONE trace entry per surviving path.** The verb is
> resolved from the path's base→final relationship (and its op mix):
> - any `set` op on the path → `append` if §2.2's predicate holds, else `set`;
> - only `merge` ops → `merge` with the accumulated `updatePatch` delta
>   (already accumulated via `deepSmartMerge`,
>   [`TransactionBuffer.ts:54`](../../src/lib/memory/TransactionBuffer.ts) —
>   single replay of the accumulated delta ≡ sequential replay, preserved);
> - an explicit delete as the final op → `delete`.
> Entry order = order of each path's **last** touch, preserving
> last-writer-wins for nested/overlapping paths (`set a` then `set a.b`).

This is a (welcome) simplification of v1's redundant entries; the
**replay-equivalence property test** (§3) is the guard that the dedup +
ordering rule reproduces v1 byte-identically for every non-append sequence.

### 2.6 What does NOT change

- **Commit cadence.** One bundle per executed stage, empty commits preserved
  ([`StageContext.ts:456-478`](../../src/lib/memory/StageContext.ts)) — every
  `runtimeStageId` stays a time-travel cursor stop; slider extents
  (`commitLog.length`) are untouched.
- **The two honest tiers.** `onWrite` stays op-level; the commit stays
  change-level ([`commit-change-semantics.md`](commit-change-semantics.md)).
  v2 only changes the change-level **encoding**.
- **The `onCommit` observer payload** — it carries `{ ...this._stageWrites }`
  ([`StageContext.ts:473,510`](../../src/lib/memory/StageContext.ts)), the
  stage-writes tier, not the bundle. Unchanged.
- **Checkpoints** — `FlowchartCheckpoint` carries `sharedState` (a state
  snapshot), never commit bundles
  ([`pause/types.ts:190-209`](../../src/lib/pause/types.ts)). Cross-version
  resume is unaffected.

---

## 3. The reconstruction guarantee (the lossless-audit claim)

> **Invariant (lossless delta replay).** For every commit log `L` produced
> under `commitVerbs: 'v2'` and every step index `k ≤ L.length`:
> `materialise_v2(L, k)` is **deep-equal** to `materialise_v1(L′, k)`, where
> `L′` is the log the same program would have produced under v1. In
> particular, the full content of every tracked array at every step is
> exactly `base ++ tail₁ ++ … ++ tailⱼ` for the appends since its last
> `set` — nothing summarized, nothing dropped.

Corollaries: final shared state is byte-identical across modes; causal
`keysWritten` sets are identical (same surviving paths, §2.5); audit
reconstruction ("what was `history` when stage X ran?") loses zero
information relative to v1.

**Verification plan** (Convention 3 — the property tier is load-bearing):

1. **Replay-equivalence property test** — randomized programs (op sequences
   drawn from {set, merge, array-push, $batchArray, write-revert, no-op
   write, deleteValue, nested-path set} over randomized state shapes) run
   against a v1 buffer and a v2 buffer; assert (a) final state deep-equal,
   (b) `materialise` deep-equal at **every** step, (c) v2 bundle payload
   size ≤ v1's.
2. **Append-detection property** — for arrays built by k pushes over base
   length n: bundle stores exactly k elements; replay reconstructs all n+k.
3. **Non-idempotency guard** — one append trace entry per path per bundle
   (the §2.5 rule), asserted structurally.
4. **Byte-identity gate for the default** — with `commitVerbs: 'v1'`
   (default at first release, §5), the entire existing suite (2900+) and
   bench §E default rows must be **byte-identical** — same discipline as
   #13/#13b/#7.
5. **Integration** — the §E growing-history chart asserts the commitLog
   retained-heap row is linear (§7); `examples/runtime-features/long-loops/`
   gains a v2 example (Convention 2).

---

## 4. Consumer impact matrix (each row verified in source)

| # | Consumer | Exact code path | Verdict |
|---|---|---|---|
| 1 | `findCommit` / `findCommits` / `findLastWriter` (`footprintjs/trace`) | [`commitLogUtils.ts:11-29`](../../src/lib/memory/commitLogUtils.ts) — match on `b.stageId` + `trace.some(t => t.path === key)`; never read values | **Unaffected.** Semantics stay truthful: an appending stage *did* change the key, so it *is* a writer. |
| 2 | `causalChain` / `flattenCausalDAG` / `formatCausalChain` | [`backtrack.ts:124-135`](../../src/lib/memory/backtrack.ts) (reverse index over `trace.path`), `:232,:278` (`keysWritten` from `trace`) — paths only, no values | **Unaffected.** §2.5's one-entry-per-path even removes today's duplicate-edge noise. |
| 3 | "Causal chain **value** reads" — consumers dereferencing `bundle.overwrite[key]` for *the value written* (the documented pattern around `findCommit(commitLog, 'call-llm', 'adapterRawResponse')`) | CLAUDE.md / trace docs usage pattern; any downstream doing `writer.overwrite[...]` | **Semantic change** for append bundles (value = tail, not full array). Mitigation: ship `commitValueAt(commitLog, idx, key)` in `footprintjs/trace` (folds appends back to the last `set`; O(span)) and document `overwrite` as verb-qualified. §8.8. |
| 4 | `CommitRangeIndex` | [`CommitRangeIndex.ts`](../../src/lib/recorder/CommitRangeIndex.ts) — interval index over commit **indices**; labels are consumer-owned | **Unaffected.** |
| 5 | `CombinedNarrativeRecorder` write lines | [`CombinedNarrativeRecorder.ts:126-141`](../../src/lib/engine/narrative/CombinedNarrativeRecorder.ts) — built from `onRead`/`onWrite` **events** (op tier), never from bundles | **Unaffected** — narrative byte-identical in both modes. |
| 6 | eui CommitFlow (`createCommitFlowRecorder`) — `CommitView.updates`, `dataDependencies` | `explainable-ui/src/components/FlowchartView/createCommitFlowRecorder.ts:100-200` — consumes the **`onCommit` ScopeCommitEvent** ("the canonical commit + read data source"), whose payload is `_stageWrites` ([`StageContext.ts:510`](../../src/lib/memory/StageContext.ts)), not the bundle | **Unaffected.** (Surprise: eui's "commit" recorder never touches `CommitBundle`.) |
| 7 | eui snapshot display | `fromRuntimeSnapshot.ts:265` (commitLog passthrough), `NarrativePanel.tsx:253-260` (`safeJsonStringify(snap.commitLog)`) | **Unaffected structurally**; displayed JSON shows tails for appends — cosmetic, arguably *more* readable. |
| 8 | Lens slider / commit-sync | `agentfootprint-lens/src/core/group/buildCommitSyncMap.ts:81-100` — `runtimeStageId`/`stageId` + array position only; slider total = `commitLog.length` (unchanged cadence, §2.6) | **Unaffected.** |
| 9 | Lens slot-changed highlight | `LensRecorder.ts:431-458` — `overwriteKeys = [...Object.keys(c.overwrite), ...Object.keys(c.updates)]`; consumed at `cursorPositionsAtDrill.ts:442` (`overwriteKeys ∩ SLOT_KEYS`) | **Unaffected under option (ii)** — the appended key still appears in `overwrite`. (This row is what kills option (i): a separate `appends` bag would dark-out the highlight for appended keys until the lens updates.) |
| 10 | Lens milestones | `milestoneFor(id: string)` — `agentfootprint/src/conventions.ts:274` — classifies on the runtimeStageId **string** alone | **Unaffected.** |
| 11 | **#20 audit chain** (agentfootprint `auditExport`) | `agentfootprint/src/adapters/observability/audit.ts` — hash-chains **typed `agentfootprint.*` event payloads** (`AuditRecord = {seq, timestamp, eventType, payload, meta, prevHash, hash}`, `hash = SHA-256(canonicalJson(...))`, `afp-cjson/1`). Verified: records embed registry event payloads (route decisions, tool calls, validation, permissions, credentials, costs) — **no `CommitBundle` shape is ever embedded or hashed** | **Unaffected — the hash contract does not see bundles.** The "schema change = hash contract change?" worry is empty: the audit chain hashes the event tier; #13c-B changes the commit tier. (Confirmed surprise — see report.) |
| 12 | #19 OTel GenAI + decision evidence | `otel.ts:121,219` — `FlowDecisionEvent`/`FlowSelectedEvent.evidence` (event tier) | **Unaffected.** |
| 13 | #5 causal memory snapshots | evidence harvested from events (`evidenceRecorder`); `memory/causal/loadSnapshot.ts:174` — "commitLog isn't yet captured in SnapshotEntry" | **Unaffected** (and when commitLog IS later persisted there, v2 makes it affordable). |
| 14 | Snapshot replay / time-travel from bundles | `EventLog.materialise()` is the **only** in-repo state-reconstruction-from-bundles — and it has **zero production callers** (verified: no `materialise` call sites in `src/` outside `EventLog.ts`; lens time-travel scrubs by *index sync*, not state replay) | **Needs-update = the §2.4 `applySmartMerge` change itself.** Nothing else replays. |
| 15 | `getSubtreeSnapshot` / `listSubflowPaths` | [`getSubtreeSnapshot.ts:53-104`](../../src/lib/runner/getSubtreeSnapshot.ts) — `subflowResults` + `executionTree` only | **Unaffected.** |
| 16 | Pause/resume checkpoints | [`pause/types.ts:190-215`](../../src/lib/pause/types.ts) — `sharedState`, no bundles | **Unaffected.** |
| 17 | TS consumers switching exhaustively on `TraceEntry.verb` | type-level | **Compile-time update** on adopting the new typings (desired: the compiler finds them). In-repo: `applySmartMerge` only. |
| 18 | U1 trace schema (future) | schema-lives-with-the-emitter plan | **Coordinate**: the exported JSON-Schema must carry the verb enum + the format discriminant (§5). |

Summary: **one** engine function to change for replay (`applySmartMerge` —
covering rows 14's three call sites), **one** new helper for row 3, **zero**
changes required in lens / agentfootprint / eui under option (ii).

---

## 5. Versioning & migration

**Is v2 observable?** Yes — bundle *contents* differ wherever append
detection fires (tail vs full array), and the §2.5 trace dedup removes
duplicate entries. Anything byte-asserting bundles (downstream pinned
fixtures, the §E default rows) sees the difference. So v2 cannot ship
silently-on.

Options considered:

| Path | Mechanics | Cost |
|---|---|---|
| A. Default-on, major (10.0.0) | clean break | forces a major for one feature; violates the "batch breaking changes" release lesson; downstream peer-range ripple (lens/af) for an opt-out-able change |
| B. **Opt-in flag first** — `commitVerbs: 'v1' \| 'v2'` on `FlowChartExecutorOptions` (default `'v1'`), minor release; agentfootprint sets `'v2'` immediately (it owns the long-run pain); default flips to `'v2'` in the next major, batched with other breaking items | byte-identity by default; the one consumer that needs it gets it now | carries a mode flag for one major cycle |
| C. Default-on + auto-down-convert helper for old consumers | "lossless either way" | two code paths forever; the helper IS `commitValueAt`, which B ships anyway |

**Recommendation: B.** It is the same discipline #13/#13b/#7 used
(byte-identity until proven, then flip), matches the shipped dial precedent
(`readTracking`/`writeTracking` naming family), and matches how
agentfootprint already adopts engine dials (`AgentOptions.readTracking`).
agentfootprint exposes `commitVerbs` on `AgentOptions` and defaults its
agents to `'v2'` in the same release it bumps the footprintjs floor.

**Format discriminant.** Per-bundle version fields are wasteful (N copies of
a constant). Recommend a **snapshot-level field** —
`RuntimeSnapshot.commitLogFormat: 1 | 2`
([`ExecutionRuntime.ts:32,153`](../../src/lib/runner/ExecutionRuntime.ts)) —
plus the verb union itself as the per-entry self-description. Offline
tooling (U1 `validateTrace`) keys on the snapshot field; a bundle stream
without context remains self-describing via verbs. (Open decision §8.7.)

**Migration notes for the changelog:**
- `bundle.overwrite[key]` is now verb-qualified — use
  `commitValueAt(commitLog, idx, key)` when you mean "the full value at this
  commit".
- Exhaustive `switch (entry.verb)` gains two arms.
- Persisted v1 logs replay unchanged forever (`set`/`merge` arms are
  untouched); v2 is a producer-side change, the replayer accepts both.

---

## 6. RFC-001 alignment — one coordinated bundle-contract evolution

Context: the original RFC's **§12 open questions** asked (a) whether the
`CaptureEnvelope` should double as a **wire format** and (b) whether to align
attribute naming with **OTel GenAI semconv**. The accepted in-repo doc
absorbed these into the Roadmap ("Worker tier as a transport swap",
"agentfootprint one-consumer collapse" —
[`rfc-001-deferred-observers.md`](rfc-001-deferred-observers.md)). #13c-B
was deliberately deferred to be designed against those answers. The analysis:

**(a) Envelope wire-format implications: NONE structurally — by the
capture-by-value design.** `CaptureEnvelope.payload` is materialized at
capture time per policy (`'summary'`/`'clone'`/`'ref'`) and is **never a live
engine reference** (RFC §5 core types). Verified against the dispatch sites:
the commit-channel observer event carries `_stageWrites`
([`StageContext.ts:510`](../../src/lib/memory/StageContext.ts)) — the
**bundle never crosses the observer boundary today**, so no envelope shape
embeds `CommitBundle`, and widening the verb union cannot break any envelope
contract. The coordination obligation runs the **other way**: if Block 6+
later adds a first-class *commit envelope* (streaming bundles to a remote
lens over the A3 worker transport), the **v2 delta bundle is the right wire
unit** — O(tail) payloads instead of O(full array) make per-commit streaming
affordable, and §2.3's encoding is JSON-shaped and structured-clone-safe by
construction, satisfying A3 without a translation layer. Designing v2 now,
before any commit envelope exists, is exactly the "consumers updated once"
sequencing the joint design was meant to buy: the bundle contract evolves
ONCE, and the future wire format inherits it.

**(b) OTel GenAI alignment: an opportunity, not a dependency.** The natural
mapping — one `append` tail of one chat message ≈ one bounded
`gen_ai.*`-style span event — only works because tails are O(delta); a
full-array `set` was never emittable as a span event. But #19's
`otelObservability` consumes the **typed event registry**, not bundles
(§4 row 12), and should stay that way (one consumer tier per concern).
Recommendation: note the mapping in the otel adapter's docs as a future
delta-driven enrichment; do **not** couple #13c-B to semconv.

**(c) Sequencing.** The agreed order is `13c-A → RFC Blocks 1–9 → 13c-B +
contract`. Technical finding from the consumer matrix: there is **no hard
dependency in either direction** — #13c-B touches `TransactionBuffer` /
`applySmartMerge` / `types.ts`; RFC Blocks 6–10 touch dispatch wiring in
`scope/`/`engine/`/`runner/`. The af **one-consumer collapse** (RFC roadmap)
consumes envelopes, not bundles — it neither blocks nor is blocked by
#13c-B. Recommendation: keep the agreed sequence by default (one
contract-review event for consumers, as decided), but treat #13c-B as
**pull-forwardable** if N=1000 pressure arrives first — the only shared file
risk is none (disjoint modules), and landing #13c-B before the collapse
means the collapse's bench runs are not OOM-constrained at high N. (Open
decision §8.9.)

---

## 7. Measurement targets — what the bench must prove

All rows land in `bench/BASELINE.md` §E (the retained-heap probe,
`bench:heap`) and the `bench:compare` two-gate guard, per the #13b precedent.

| Target | Today (v9.5.0) | Expected under `commitVerbs: 'v2'` | Proven by |
|---|---|---|---|
| commitLog retained heap, fp-only growing-history chart, N=200 | ≈18MB (§E Finding 5) | **O(Σ tail) ≈ 0.2MB of messages + per-bundle overhead — single-digit MB; the §E row becomes ~linear** | new §E row pair (v1 vs v2 same chart) |
| Same, N=500 / N=1000 | quadratic (×6.25 / ×25 vs N=200) | **~linear (×2.5 / ×5 vs N=200)** — THE linearity proof: heap(N=1000) ≈ 2 × heap(N=500) | §E rows at 3 Ns; assert ratio < 3 |
| af full stack N=1000 (with `summary` dials) | **OOM @ 2GB** (#13c-A re-measure) | **completes in a default heap** — acceptance bar for the backlog item | af-side re-measure (the #18 protocol, `chunkDelayMs: 0`) |
| Default-mode (`'v1'`) heap + commit-release latency | 59.7MB @ N=200; commit p50 per `bench:compare` baseline | **byte-identical / Δ ≤ noise floor** — the §3.4 gate | `bench:compare` (25% + noise-floor two-gate) |
| v2 commit wall on non-array charts | — | within the same two-gate vs v1 (detection only adds the array-prefix branch) | `bench:compare` v2 row |
| v2 loop-iteration latency growth (46µs → 424µs over 100 iters today, §Micro) | 9.2× growth | reduced but **NOT flat** — write-time clone + applyPatch whole-state clone remain (§2.2 caveat); document the residual slope and attribute it | micro row + a follow-up note keyed to §8.5 |

The honest claim the numbers must support: **#13c-B makes the commit log
linear in delta size and removes the last *retained-heap* quadratic; the
residual *wall* quadratic (transient clones) is a separate, smaller item**
with its own levers (§2.2 caveat, §8.5).

---

## 8. Open decisions (numbered — each with a recommendation)

1. **Verb set** — append-only vs append+delete vs append+delete+replace-at-index/truncate.
   **Recommend: `append` + `delete`.** Delete is vocabulary-complete (the
   scope API and observer tier already speak it, §2.1) and closes B8 in the
   same contract evolution. Replace-at-index/truncate have no measured
   workload, complicate the §2.5 idempotency rules, and `set` already covers
   them losslessly — add later only against a measurement.

2. **Tail placement** — new `appends` bag vs verb-discriminated `overwrite`
   vs `updates`. **Recommend: verb-discriminated `overwrite`** (§2.3) — the
   only option with zero verified downstream breakage (lens `overwriteKeys`,
   §4 row 9).

3. **Default-on vs opt-in flag.** **Recommend: opt-in
   `commitVerbs: 'v2'` first** (§5 path B), default `'v1'` byte-identical,
   agentfootprint opts in in lockstep.

4. **Major vs minor.** **Recommend: minor for the flag (9.6.0); the default
   flip rides the next batched major** — per the "batch breaking changes"
   release lesson; do not spend a major on an opt-out-able encoding change.

5. **Detection cost budget** — always-attempt prefix compare vs gated; and
   whether to take the companion `baseSnapshot`-as-reference change for the
   pointer-fast path. **Recommend: always-attempt in v1** (worst case
   bounded ≈ one extra structural compare per array-set path, §2.2) **and
   defer the baseSnapshot/reference companion to its own reviewed change** —
   it touches the adversarially-reviewed #13 first-touch anchor and is a
   wall optimization, not a heap one.

6. **One-trace-entry-per-path dedup** (required for append idempotency,
   §2.5) — adopt for ALL verbs in v2, or special-case append only.
   **Recommend: all verbs in v2** — one rule, simpler spec, property-tested
   replay equivalence; v1 mode keeps today's duplicates untouched.

7. **Format discriminant** — per-bundle field vs snapshot-level
   `commitLogFormat: 1 | 2` vs none (verbs self-describe). **Recommend:
   snapshot-level field + verb self-description**, wired into the U1 schema
   when that lands (§5).

8. **`commitValueAt(commitLog, idx, key)` helper** — ship with v2 or defer
   until asked. **Recommend: ship with v2** in `footprintjs/trace` — it is
   the migration story for the one real semantic break (§4 row 3), and the
   docs' `findCommit(...).overwrite` pattern should be rewritten onto it in
   the same PR.

9. **Sequencing vs RFC Blocks 6–10 and the af one-consumer collapse.**
   **Recommend: keep the agreed order (RFC wiring first), explicitly marked
   pull-forwardable** — no technical dependency either way (§6c); revisit
   only if an N=1000 consumer need lands before the wiring does.
