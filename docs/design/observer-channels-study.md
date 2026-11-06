# Observer Channels — Complete Characterization Study

*Groundwork for the "non-blocking observers" research proposal (commitLog-as-CDC).
Method: every channel traced to its dispatch site in source; payload mutability verified at the
emitting line, not assumed from docs. June 2026.*

---

## 1. Inventory — what actually exists

footprintjs has **four observer channels**, **one legacy side-channel**, and **two persistent stores**.
They are not variations of one thing; they differ on every axis that matters for deferral.

| # | Channel / Store | Fires | Dispatch site |
|---|---|---|---|
| C1 | **StructureRecorder** | BUILD time, synchronously during builder calls | `StructureRecorderDispatcher` (builder ops) |
| C2 | **ScopeRecorder** (data ops) | DURING stage execution, per read/write; commit at stage flush | `ScopeFacade._invokeHook` (:495, :535, :560); commit observer via `StageContext.commit()` (:283) |
| C3 | **FlowRecorder** (control flow) | AFTER stage execution; control events | `FlowRecorderDispatcher` from `FlowchartTraverser` |
| C4 | **EmitRecorder** (consumer events) | When stage code calls `$emit`/`$metric`/`$debug`… | `ScopeFacade.emitEvent` (fast-path when no recorder) |
| C5 | DiagnosticCollector side-bags (legacy) | `$debug/$metric/$eval/$error` writes | `StageContext.add*` → snapshot only (now ALSO mirrored onto C4) |
| S1 | **commitLog** (`CommitBundle[]`) | One bundle per stage commit | `TransactionBuffer.toChangeOnlyPayload` → `ExecutionRuntime.executionHistory` |
| S2 | **EventLog** (redacted trace) | Per commit, redacted patches | `StageContext.commit()` (:275) |

Plus recorder-owned stores (KeyedStore/SequenceStore/BoundaryStateStore) — these are *consumer-side*
memory, not channels; they inherit whatever delivery semantics the channel gives them.

---

## 2. Per-channel characterization (payload mutability VERIFIED at source)

### C1 · StructureRecorder
- **Phase:** build time only — never on the traversal hot path. **Volume:** O(chart size), once.
- **Payload:** builder-produced specs (mount events carry `subflowSpec`).
- **CDC relevance: none.** Out of scope for deferral entirely. Class **C-inline** by nature.

### C2 · ScopeRecorder — the high-frequency engine channel
- **Trigger:** `onRead`/`onWrite` per operation DURING execution; `onCommit` at stage flush;
  `onStageStart/End`, `onPause/Resume` lifecycle.
- **Payload mutability — split verdict (verified):**
  - `ReadEvent.value` / `WriteEvent.value` carry the **live reference** (`value: recorderValue`,
    ScopeFacade.ts:497/:542; `value: unknown` in types.ts:25/:32). Redaction replaces the value at
    source when policy matches. → **Class B** (defer only with capture-at-source).
  - `CommitEvent.mutations` are **already cloned** — `StageContext._stageWrites` values are
    `structuredClone`d at write-tracking time (StageContext.ts:150/:164) and the observer gets a
    fresh container (:284). → **Class A** (defer free).
- **Volume:** O(ops) — the largest engine-side channel. **Ordering invariant:** ops for stage *k*
  must be observable before *k*'s flow events (CombinedNarrativeRecorder buffers per
  `runtimeStageId` and flushes on `onStageExecuted` — it RELIES on cross-channel order).

### C3 · FlowRecorder — the control-flow channel
- **Trigger:** after stage execution; `onStageExecuted/onNext/onDecision/onFork/onSelected/
  onSubflowEntry/Exit/onLoop/onBreak/onError/onPause/onResume/onRunStart/onRunEnd/onRunFailed`.
- **Payload mutability (verified):** small fresh objects; `TraversalContext` created per stage
  (FlowchartTraverser.ts:515–524); **decision evidence is summary-based by design** —
  `summarizeValue()` at capture time, "no raw object references held" (evidence.ts:6–10,
  evaluator.ts:91–108). `onRunStart/End` payloads carry run input/output (live refs — the one
  exception). → **Class A** except run-boundary payloads (**B**).
- **Volume:** O(stages + control events) — moderate. **Ordering invariant:** specialized events
  (onDecision/onFork/onSelected/onSubflowEntry) fire BEFORE the uniform `onStageExecuted` for
  non-linear stages (documented event-ordering contract §"Event Ordering" in CLAUDE.md).

### C4 · EmitRecorder — the consumer channel (and the agent hot path)
- **Trigger:** synchronous from stage code; envelope auto-enriched (stageName, runtimeStageId,
  subflowPath — with a frozen shared empty-path sentinel to avoid allocation, ScopeFacade.ts:31–36).
- **Payload mutability (verified):** envelope is fresh; **`payload`/`value` fields carry the
  consumer's live reference** (e.g. `emitEvent('metric.x', { name, value })`, ScopeFacade.ts:253).
  String payloads (stream tokens!) are immutable by language; object payloads are Class **B**.
- **Volume:** unbounded — consumer-defined. In agentfootprint this is the firehose: per-token
  stream events ride C4 → highest-frequency channel in the whole stack.
- **Redaction:** `emitPatterns` matches name → payload replaced at source. Must remain at source.

### C5 · Diagnostic side-bags (legacy)
- Snapshot-only mirror of `$debug/$metric/...`; since the emit-channel work they double-publish on
  C4. **Disposition:** fold into C4's story; no separate deferral design needed.

### S1 · commitLog — the CDC substrate
- **`CommitBundle` is immutable at creation:** surviving patches are `structuredClone`d in
  `toChangeOnlyPayload` (TransactionBuffer.ts:162–164); bundle carries stage, stageId,
  `runtimeStageId`, net-change overwrite/updates, trace, redactedPaths. Appended in commit order.
- This is **already a change-data-capture stream**: ordered, immutable, keyed by the universal
  correlation id, with redaction metadata attached. Zero additional cost — it exists today.

### S2 · EventLog — redacted twin of S1, same properties, PII-safe by construction.

---

## 3. The three invariants any deferred design must preserve

1. **Cross-channel total order.** Consumers correlate C2 ops → C3 stage events → C4 emits by
   `runtimeStageId` AND by arrival order (narrative buffering, Lens bracket-pairing). Per-channel
   queues would break this silently. ⇒ **one merged queue**, not four.
2. **Redaction at source.** C2/C4 redaction happens before dispatch today. Buffering must never
   hold a pre-redaction value — capture-at-source must run AFTER the redaction decision.
3. **Terminal completeness.** Sync dispatch gives exactly-once, complete delivery even on error
   (onRunFailed closes the boundary). Deferred delivery needs a **flush-before-return** contract on
   `onRunEnd`/`onRunFailed`/pause (prior art: `flushAllDetached({timeoutMs})`).

---

## 4. CDC-readiness classification (the punchline)

| Class | Meaning | Members (verified) |
|---|---|---|
| **A — defer for free** (payload already immutable at source) | move behind a buffer with zero new cost | `CommitBundle` (S1/S2) · `CommitEvent` (C2) · all C3 events incl. decision evidence · lifecycle markers |
| **B — defer with capture-at-source** (live refs in payload) | need a capture policy at emit time | C2 `onRead`/`onWrite` values · C4 object payloads · C3 run-boundary payloads |
| **C — inline by nature** | not part of the problem | C1 (build-time) · redaction decisions · pause signal flow |

**Class B's capture policy already exists in the codebase:** `evidence.ts` solves the identical
problem with `summarizeValue()` at capture time — bounded, redaction-aware, reference-free. The
research design choice for B is per-recorder: `capture: 'summary' (default) | 'clone' | 'ref'`
(ref = consumer asserts immutability, e.g. token strings).

**Volume model (full-feature agent, 50 iterations, ~10 tools):** C1 ≈ 10² once · C3 ≈ 10²–10³ ·
C2 ≈ 10³–10⁴ · C4 ≈ 10⁴–10⁵ (token-dominated). ⇒ The deferral win lives in C4 and C2-ops;
the consistency anchor lives in S1/A-class; C3 is cheap either way.

---

## 5. Implications for the proposal (what this study fixes in the v1 design)

1. **Don't "shift everything to commitLog dispatch."** S1 carries *change-level* truth only —
   C2 op-level events (write-then-revert visibility) and C4 emits are NOT reconstructible from
   commits (two-honest-tiers is a feature, TransactionBuffer.ts:87–93). The design is:
   **commitLog as the consistency spine + a merged deferred queue for A/B events**, not commitLog
   as the only stream.
2. **Tier assignment falls out of the classes:** engine-internal consumers needing sync state
   reads (narrative flush, metric appends — microseconds) stay inline; everything domain-side
   (agentfootprint EmitBridge → EventDispatcher → user listeners) goes deferred-tier by default.
3. **The queue is one ring buffer of pre-captured envelopes** (A: as-is; B: per-policy capture),
   flushed by microtask batch (prior art: `microtaskBatchDriver`), bounded with explicit policy
   (`block | drop-oldest | sample | spill`), counters surfaced as first-class evidence
   ("observability of the observability").
4. **Benchmarks defined by the volume model:** p95 traversal latency with a 5ms-per-event listener
   on C4 at 10⁴ events — inline vs deferred; plus loss/ordering property tests (fast-check) over
   randomized interleavings.

## 6. §7 Precedent survey — the four-channel split in other tree-traversal systems

| footprintjs channel | Precedents |
|---|---|
| C1 Structure (build-time) | Compiler parse phase vs runtime; GraphQL validation vs execution; Apollo `serverWillStart` vs per-request hooks; React render vs commit |
| C2/S1 Scope + commitLog (data) | **Database WAL** (change-level, immutable, ordered); statement-log vs WAL = the "two honest tiers" (op vs change) |
| C3 Flow (control) | `EXPLAIN ANALYZE` wrapping Volcano-model plan nodes; Intel PT branch trace vs data watchpoints (hardware separates the same two channels) |
| C4 Emit (consumer) | **USDT probes** (DTrace/eBPF): app-defined named probe points on infra delivery; `performance.mark` |

**GraphQL detail:** graphql-js execution is DFS with parallel siblings (field resolution ≈ fork children). Apollo's plugin API is *hierarchical brackets* — `requestDidStart ⊃ executionDidStart ⊃ willResolveField → onComplete` — structurally `InOutRecorder`'s entry/exit pairs. Plugins: passive, sync, error-isolated (same contract). Their per-field firehose is handled by **request sampling** (trace 1-in-N) — precedent for shed-at-source. GraphQL needs only 2 channels because execution is *read-only*; a read-write traversal forces the WAL-like channel — the 4-channel split is the read-write generalization, not over-engineering.

**The headline precedent for the deferral proposal:** DOM **Mutation Events → MutationObserver**. Synchronous tree-mutation observers shipped, blocked the mutator, were deprecated platform-wide; the replacement delivers **immutable change records, batched, one microtask behind** — item-for-item the commitLog-as-CDC design. Same migration in databases: row triggers (inline, blocking, anti-pattern for long work) → CDC/logical-replication consumers (deferred). Mechanism precedent: **DataLoader** batches on the microtask boundary (= `microtaskBatchDriver`). Tier precedent: React `useLayoutEffect` (inline, use sparingly) vs `useEffect` (deferred, default) = `delivery: 'inline' | 'deferred'`. "One beat behind" precedent: game-engine ECS double-buffered event buses (write this frame, read next).

**Survey verdict:** every platform that shipped synchronous tree-mutation observers at scale deprecated them; the four-channel decomposition is independently reinvented in databases, CPUs, compilers, and the DOM. What precedents say is missing from footprintjs today is exactly the proposal: per-recorder delivery QoS + sampling policy.

## 7. Open research questions

- Can B-class `onWrite` defer with **delta references into S1** (value = pointer into the commit
  bundle that will contain it) instead of summaries — zero-copy with change-level fidelity?
- Snapshot reads for deferred consumers: expose `stateAt(runtimeStageId)` reconstructed by
  commitLog prefix replay (time-travel already does this in the UI tier — move it engine-side?).
- Cross-process tier (worker/OTLP): is the capture-at-source envelope already the wire format?
  (It nearly is — compare InOutEntry/EmitEvent to OTel GenAI span attributes.)
- Formal claim worth proving: *bounded-staleness delivery with terminal flush preserves
  narrative byte-identity for all A-class consumers.* That's the paper's theorem.
