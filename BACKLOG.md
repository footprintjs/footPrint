# Combined Backlog — footprintjs + agentfootprint (detailed)

*Dependency-ordered. [F] = footprintjs, [A] = agentfootprint. Items within a phase run in parallel.
Every finding from both REVIEW.md files is represented — majors as numbered tasks, minors in Phase 6.
Effort: S = hours–1 day · M = days · L = 1–2 weeks.*

> **Converged after second-agent verification (June 2026):** ~85% of findings confirmed against source;
> #3 refuted by measurement (7.0 frames/iter, peak depth 352 @ 50 iterations, wall ≈ iteration 71 —
> subflow mounts get a fresh traverser/depth counter) → folded into #16; #15 reframed (caps the longest
> chain within one traverser, not the run); #6 deferred behind a widened #1 guard; #19 = extend existing
> `otelObservability`, not new exporter; B9 won't-fix (deliberate AI-IDE channel); stray-file sweep =
> `MIGRATION_PLAN.md` only (rest are git-ignored). The refuting measurement must be committed as the
> seed of #12/#17 — the experiment IS the cross-repo limits test.

**Critical paths:** engineering `#1 → #7 → #15 → #16/#17` · strategy `#5 → #19/#20 → #21`

---

## Phase 0 — Truth & guards (no dependencies)

### 1. [F] Re-entrancy guard on `executor.run()` — **S**
**Why:** `run()` mutates instance fields mid-flight — `lastCheckpoint`, `_executionCounter`, `_currentRunId`, `_hasRunBefore`, `this.traverser` (FlowChartExecutor.ts:1093–1096) — and clears all attached recorders at run start. Two concurrent `run()` calls on one executor interleave runIds, cross-contaminate recorder/narrative state; `getCheckpoint()` returns whichever run paused last. Natural server pattern (module-level executor, N requests) silently corrupts traces.
**Fix:** `_running` flag; second entry throws `"Executor already running — create one executor per concurrent run (see docs/execution-model)"`.
**Done when:** concurrent-run test asserts the throw; error message links the doc from #2.

### 2. [F] "Supported envelope" doc — **S**
**Why:** README positions "explainable backend flows"; the real envelope today is single-run-per-executor, ~500 traversal frames, modest state sizes, throughput-insensitive. Honest docs cost nothing and convert silent corruption into informed choices.
**Fix:** `docs/guides/execution-model.md`: executor lifecycle (executor-per-run for servers), depth budget & how `maxDepth` trades against V8 stack, clone-cost model (what you pay per read/write/stage), what pause/resume does and doesn't capture (recorder state documented-out; `DetachHandle`s and in-flight detached children invisible to checkpoints).
**Done when:** README links it; #1's error message links it.

### 3. [A] ~~Friendly depth-budget guard~~ — **REFUTED → demoted, folded into #16**
**Measured (second-agent verification):** full-feature 50-iteration agent completes; 7.0 frames/iteration, peak depth 352; wall ≈ iteration 71. Original estimate (~10–15 frames/iter, wall at 35–50) missed that subflow mounts create a fresh traverser with its own depth counter — only the parent loop chain accumulates. `clampIterations(50)` (validators.ts:42–46) accidentally keeps every user inside the envelope today, so there is **no Phase-0 urgency**. The build-time warning survives as S-polish inside #16: it becomes mandatory the moment the clamp rises, because users between 71 and the new cap would hit the cryptic wall. Real dependency preserved: **#16 is blocked on #15.**

### 4. [A] Truth-in-docs + hygiene sweep — **S**
**Why:** (a) CAUSAL memory README/CLAUDE.md claims "replay decision evidence, zero hallucination" while snapshots persist empty evidence (see #5) — overclaim until wired. (b) Docs say "59 typed events × 16 domains"; `events/registry.ts` has 63 entries. (c) Stray root files: `README.proposed.md`, `profile-README.proposed.md`, `index-claude.html`, `MIGRATION_PLAN.md`.
**Fix:** soften causal claims ("stores final outcome today; evidence wiring in progress"); add a test that derives the event count from `EVENT_NAMES` and asserts docs match (or generates the docs table); stray-file sweep = `MIGRATION_PLAN.md` only (the .proposed/index-claude files are git-ignored locals — verified).
**Done when:** no doc claim a fresh reader can falsify by reading source.

---

## Phase 1 — The moat + correctness

### 5. [A] **Causal evidence bridge** (Strategic #1) — **M**
**Why:** The flagship ⭐ differentiator is scaffolded, not shipped. `writeSnapshot.ts:95–102` persists `iterations: 0 // TODO`, `decisions: [] // Populated by a follow-up FlowRecorder integration`, `toolCalls: []`, `durationMs: 0`, `tokenUsage: {0,0}`. Only `query` + `finalContent` are real; `loadSnapshot.ts:141` renders "(no decision evidence captured)". Cross-run "why was X rejected?" currently replays *what* was said, not *why*. All the data already exists downstairs: footprintjs `onDecision.evidence` (from `decide()`/`select()`), tool events, `agent.turn_end` token counts, commitLog.
**Fix:** attach a CombinedRecorder during agent runs that harvests: decision events (rule index, label, operator-level conditions, chosen branch), tool calls (name, args summary, result summary, toolCallId), iteration count, duration, token usage → populate `SnapshotEntry` fields; ensure redaction policy applies to evidence values.
**Done when:** the existing causal example answers "why did you reject the $50K loan last run?" from stored operator-level evidence (`creditScore 580 lt 620 → rejected`), with a test asserting non-empty `decisions[]` round-trip through store + retrieval; README claim restored from #4.

### 6. [F] Per-run state extraction (`RunHandle`) — **DEFERRED**
**Disposition (converged):** with #1's loud guard + #2's executor-per-run doc, the silent-corruption class is closed; RunHandle is an M-sized hot-path refactor serving a pattern the docs explicitly argue against. Wait for a real consumer needing interleaved runs on one executor ("two instances = coincidence"). If #15's rework touches run lifecycle anyway, fold it in there.
**Conditions for safe deferral (added to #1/#2):** (a) the #1 guard also rejects `resume()` re-entrancy — run-while-resuming and double-resume are the same corruption class, one more flag check; (b) document `getCheckpoint()`/`getSnapshot()`/`getNarrativeEntries()` as **last-run-wins** in the #2 envelope doc.

### 7. [F] Stop dynamic returns mutating the shared chart graph — **M**
**Why:** On a `StageNode` return, the traverser writes to the *built chart's* shared nodes: `node.isSubflowRoot/subflowId/subflowName/subflowMountOptions` (FlowchartTraverser.ts:759–762), `node.children` (:791), `node.nextNodeSelector` (:806), `node.next` (:815). Only `next` is restored (:823–824). A chart that returns dynamic children once keeps them for **all later runs**; concurrent runs race on these fields — undermining the per-traverser copies done for stageMap/subflows (:197–199) and `resolvedLazySubflows` (:146).
**Fix:** traverser-local overlay (Map<nodeId, dynamicPatch>) consulted by phases 5–6, or clone-on-mutate; never write to `opts.root`'s nodes.
**Done when:** test: run a dynamic-children chart twice — second run sees the original graph; concurrent-run fuzz over a dynamic chart stays deterministic.

### 8. [F] Snapshot/checkpoint boundary isolation — **S/M** *(split per verification)*
**Why:** `getSnapshot().sharedState` is the live context object (`SharedMemory.getState()` returns `this.context`, SharedMemory.ts:54–56; passed through at ExecutionRuntime.ts:122–129); pause checkpoints embed the same reference. Nuance (verified): the alias detaches after the *next* commit (`applySmartMerge` rebuilds context) — but mid-pause and **post-run it aliases forever**, and docs say "store the checkpoint in Redis" while handing out a live reference.
**Fix (converged):** checkpoint **deep-copy mandatory** (it's persisted by contract); snapshot gets dev-mode deep-freeze + measurement before deciding clone-always.
**Done when:** test mutating a returned checkpoint/snapshot leaves engine state untouched; bench notes snapshot clone cost.

---

## Phase 2 — Production trust, agent side (independent of Phase 1)

### 9. [A] Validate tool args before dispatch + model-visible retry — **M**
**Why:** `toolCalls.ts:85` casts LLM-produced `args` to `Record<string, unknown>` and dispatches. `inputSchema` is sent to the LLM but never enforced on the return path; null/malformed args reach `execute` silently — off-brand for an auditability framework, and the model never gets a chance to self-correct.
**Fix:** validate against the tool's JSON Schema (footprintjs `schema/` module already does lightweight JSON Schema); on failure, feed a structured `tool_result` error back to the model ("args failed validation: <details> — retry with valid arguments") instead of executing; count against a small retry budget; emit `tools.validation_failed` event.
**Done when:** scripted-mock test: model sends bad args → gets validation error → retries with good args → tool executes once.

### 10. [A] Required parallel branches (`failFast`) + mapper error surfacing — **S/M**
**Why:** `core-flow/Parallel.ts` never sets footprintjs's fan-out `failFast` (no hits in core-flow); a throwing branch is collected, siblings finish, merge runs on a half-built result. Branch failure is detected only by absence (Parallel.ts:408–440); outputMapper failures surface as "unknown error" (footprintjs fires no onError for mapper throws — :414–422 comment). footprintjs added `failFast` for precisely this class of bug.
**Fix:** `.branch(id, runner, { required?: true })` → set `failFast` on the fan-out when any branch is required (or per-branch wrap-and-rethrow for mixed mode); wrap branch outputMappers to capture and attribute errors.
**Done when:** tests: required branch throws → whole run rejects with attributed error; tolerant mode still aggregates; mapper throw is attributed to its branch.

### 11. [A] Listener/recorder lifecycle — **M**
**Why:** `EventDispatcher` maps (`byType`, `domainWildcards`, `allWildcards`, dispatcher.ts:98–100) and `RunnerBase.attachedRecorders` (RunnerBase.ts:410–415) accumulate with no per-run/runId cleanup — long-lived Agent instances on servers grow monotonically unless consumers diligently unsubscribe. `LiveStateRecorder` resets only via `runIdGuard.observe()` on incoming events (:131–167): a run that dies before `llm_start` leaves stale state for the next run.
**Fix:** runId-keyed auto-expiry (reset transient maps when a new runId is observed — footprintjs Convention 4); `AbortSignal` option on `.on()`; reset LiveState stores on `run()` entry, not first event; document the contract for externally attached recorders.
**Done when:** leak test — 1,000 sequential runs with per-run `.on()` + no manual `off()` → bounded listener count; stale-state repro fixed.

### 11½. [A] Absorbed from owners' open ledger — slots into Phase 2, no phasing change
Credential transient-retry via reliability (documented deferral) · `sf-credential` subflow node · `req.identity` forwarding in `agentCoreIdentity` · AgentCore Memory semantic retrieve · skillGraph scoped-`read_skill` v2.

---

## Phase 3 — Lift the ceilings (footprintjs perf release)

### 12. [F] Benchmark baseline — **S**
**Why:** #13–15 must ship with before/after numbers; `bench/` exists but doesn't cover these paths.
**Fix:** benches for (a) read-heavy stage over 1 MB state, (b) 100-iteration loop over growing state, (c) deep-nested subflows; record ops/sec + peak RSS. **Commit the verification experiment** (full-feature agent, frames/iteration + peak-depth probe — the one that measured 7.0/iter, peak 352, wall ≈ 71) as a bench script: it's the seed of #17 and the regression guard for #15.
**Done when:** baseline committed incl. depth probe; #13–15 PRs show deltas.

### 13. [F] Truly lazy `TransactionBuffer` — **M**
**Why:** Buffer construction does **two `structuredClone`s of the entire shared state** (TransactionBuffer.ts:25–26) and is instantiated on first **read** (`StageContext.getValue` → `getTransactionBuffer()`, StageContext.ts:204–207) — so read-only stages pay full freight; the "pay clone cost only if stage writes" comment (:108) is currently untrue. Biggest single perf win per line changed.
**Fix:** reads before any write go straight to `SharedMemory` (read-your-writes only matters after a write); create buffer on first write; `baseSnapshot` can be captured at that moment.
**Done when:** bench (a) shows ~0 clone cost for read-only stages; commit semantics (net-change diff vs base) unchanged — full suite green.

### 14. [F] Read-tracking clones opt-in/sampled — **S/M**
**Why:** Every tracked read `structuredClone`s the value into `_stageReads` (StageContext.ts:211) — O(value) per read, brutal for agent message arrays. Writes triple-clone: patch clone (TransactionBuffer.ts:32) + `_stageWrites` clone (StageContext.ts:150) + commit-time clone (:162); TypedScope object writes add a `JSON.parse(JSON.stringify())` proxy-unwrap (createTypedScope.ts:29–40).
**Fix:** store `summarizeValue` summaries by default for the memory view; full clones behind an opt-in (`recordFullValues: true`) or dev mode; audit whether `_stageWrites` can reference the already-cloned patch value instead of re-cloning.
**Done when:** bench (b) shows per-iteration cost no longer scales with full history size for reads; snapshot still renders meaningful read/write views.

### 15. [F] Trampoline `next`/loop continuations — **M/L** *(framing corrected)*
**Why:** `executeNode` recurses for every `next` and loop hop (FlowchartTraverser.ts:594, :703, :913); awaited frames never unwind, so `MAX_EXECUTE_DEPTH = 500` (:184) caps **the longest chain within one traverser** (subflow mounts get a fresh traverser — it does *not* cap the whole run). The agent's loop chain IS that chain: measured wall ≈ iteration 71. The code's own comment (:176–178) concedes the depth guard fires before the documented 1000-iteration loop limit. Raising `maxDepth` just trades the clear error for a real V8 stack overflow. Riskiest change in the backlog — sequence after #7 (same region); byte-identical-narrative is the bar.
**Fix:** iterative driver loop: linear `next` and `loopTo` continuations become "set current = next, continue" in a while-loop; true tree recursion (fork children, subflow mounts) stays recursive (bounded by real nesting). Keep `_executeDepth` for tree depth only.
**Done when:** 10,000-iteration loop chart completes with flat stack; narrative/event ordering byte-identical on the existing golden tests.
**Depends:** #7 (same code region; land graph-mutation fix first).

---

## Phase 4 — Agent-scale (depends on Phase 3)

### 16. [A] Adopt new footprintjs + unlock iterations — **S** · **BLOCKED ON #15**
**Why the hard dependency (measured):** the wall is ≈ iteration 71 today; `clampIterations(50)` accidentally protects users. Raising the clamp before #15 lands moves users past 71 into the cryptic depth error.
**Fix:** bump peer to the major carrying #13–15 (drop `^7` or CI-matrix both); raise/remove `clampIterations(50)` (validators.ts:42–46); expose `maxDepth` on `Agent.create`/`run`; include the demoted #3 build-time budget warning (mandatory once the clamp rises).
**Done when:** peer range matches CI matrix; 200-iteration agent run passes; budget warning fires when `maxIterations × measured-frames > maxDepth`.

### 17. [A] Cross-repo limits test in CI — **S**
**Why:** The two libraries' limits were never co-engineered; nothing pins the boundary (today a 50-iteration full-feature agent likely dies mid-run).
**Fix:** CI test: 50-iteration agent with cache + thinking + 3 slots + tools completes against the pinned footprintjs version; assert peak memory under budget.
**Depends:** #13–15, #16.

### 18. [A] Re-measure history cost; optimize only if needed — **S**
**Why:** History lives in scope (`scope.history`: seed.ts; toolCalls.ts:88 copies; callLLM.ts:123 reads) → O(N²·M) under the old clone model. #13/#14 should collapse this; verify before building history-specific storage.
**Done when:** bench of 30-iteration/500 KB-history run shows acceptable RSS/latency, or a follow-up task is filed with data.

---

## Phase 5 — The compliance wedge (depends on #5)

### 19. [A] OTel GenAI bridge carrying decision evidence — **M** *(extend, don't build)*
**Why:** LangSmith/Langfuse/Datadog/OTel GenAI conventions are where enterprises already look; they carry telemetry (what happened), not decision evidence (why). Emitting OTel spans with footprint evidence attributes makes this stack *the evidence layer inside tools they already bought* instead of a 13th dashboard.
**Fix (converged):** **upgrade the existing `otelObservability`** (ships today with exactly one GenAI attribute — verified) to GenAI semantic conventions + `footprint.decision.evidence`, `footprint.commit.id`, `footprint.runtime_stage_id` attributes. No new exporter, no duplicate surface. Sample app showing traces in Langfuse. ATUI's OTLP reader (U5/U6) is the round-trip consumer.
**Depends:** #5.

### 20. [A] Tamper-evident audit export — **M**
**Why:** EU AI Act Article 12 (high-risk systems, enforcement Aug 2, 2026) requires traceable, retained, tamper-evident decision logging. The stack already has redacted mirrors (footprintjs RedactionPolicy) + commitLog + (post-#5) evidence — productize the export.
**Fix:** `exportAuditBundle(run)` → JSON bundle: redacted narrative, commit log, decision evidence, tool calls, hashes chained per entry (hash-linked log) for tamper evidence; verification CLI.
**Depends:** #5, #8.

### 21. [A] Lighthouse example: regulated decisioning — **M**
**Why:** One real "regulator asks why → stored evidence answers" story is worth more than feature parity in this niche.
**Fix:** end-to-end example (loan decisioning or AML triage): agent + decide() rules + causal memory + audit export; README walkthrough answering "why was applicant X declined three weeks ago?" from the stored snapshot; pairs with #19/#20 output.
**Depends:** #5; better with #19/#20.

---

## Research track — RFC-001 Deferred Observers (design: `research/RFC-001-deferred-observers.md`)

- [ ] **R1. [F]** Blocks 1–5: standalone `src/lib/observer-queue/` module (envelope/ring/merged queue/flush driver/dispatcher) — zero engine imports, full 7-type test coverage. *Can start anytime.*
- [ ] **R2. [F]** Blocks 6–9: tier router (`delivery: 'inline' | 'deferred'`, inline default), wire 3 dispatch sites after redaction, terminal flush on end/fail/pause, `observerStats` on snapshot. **Gate: existing suite green + narrative byte-identity with zero opt-ins.** *Sequence around #7/#15 merge windows (same traverser region).*
- [ ] **R3. [A]** Block 10: EmitBridge `delivery` opt-in + published bench (p95 traversal latency, 5ms listener × 10⁴ events, inline vs deferred). Default flip deferred to next major.

## Research track — RFC-002 Tool-Choice Confusability (design: `research/RFC-002-tool-choice-confusability.md`)

- [ ] **R4. [A]** Tier 1 — `analyzeToolCatalog()` build-time lint (blocks C1–C3): pairwise description confusability + structural rules (missing "when", enum-able prose params) + CI gate. Plain `{name, description}[]` input — adoptable with zero stack buy-in. First test catalog: Neo's twinned NX-API/Influx tools.
- [ ] **R5. [A]** Tier 2 — `toolChoiceRecorder` (blocks C4–C6): per-LLM-call margin scoring over the offered catalog, flags narrow margins + proxy disagreements. Declares `delivery: 'deferred'` once R2 lands. Lens "Tool choice" panel = C7 (U-tier).
- [ ] **R6. [A]** Tier 3 — choice-entropy sampler + description A/B harness + proxy-health metric (block C8). The validation study for the FDL follow-up paper.

## Research track — RFC-003 Contextual Bug Localization (design: `research/RFC-003-contextual-bug-localization.md`)

- [ ] **R7. [F]** Part A — backtracking gap fixes (blocks D1–D5, one additive minor): `parentRuntimeStageId` on TraversalContext · untracked-read honesty flags on CommitBundle · control-dependence edges + `CausalEdge`/`weigh` hook in `causalChain` · `controlDepRecorder()` · truncation flags. Fixes the decider-invisible-in-slice gap verified at backtrack.ts.
- [ ] **R8. [A]** Part B — `localizeContextBug()` (blocks D6–D10): extract shared `influence-core` (also de-dupes R4/R5) · LLM-edge weigher · ablation adapters (tool/injection/memory) · N-seeded bisection with variance · Lens weighted-DAG panel. The follow-up paper's engine.

## Phase 6 — Minor & polish (anytime; none block the phases above)

**footprintjs**
- [ ] **B1.** Split `FlowChartBuilder.ts` (~2K LOC); dedupe `DeciderList`/`SelectorFnList` branch APIs (near-identical code repeated across fork/decider/selector); remove `as any` on lazy-resolver paths.
- [ ] **B2.** `BoundaryStateStore`: optional max-age sweep for long-running servers (missed `stop()` leaks; dev-warn only today — BoundaryStateStore.ts:19–21).
- [ ] **B3.** `isFlowEvent()` discriminates on *absence* of `pipelineId` (CombinedRecorder.ts:164–167) — add explicit discriminant field in next major; keep helper as shim.
- [ ] **B4.** `StageContext.createNext` silently ignores name/id args when `next` exists (StageContext.ts:290–299) — dev-warn on mismatch.
- [ ] **B5.** Docs: TransactionBuffer = staging buffer with read-your-writes + net-change, **not** rollback (commit-on-error at FlowchartTraverser.ts:730 is intentional, for evidence); `decide()` empty-filter → no-match is anti-vacuous-truth by design (evaluator.ts:118) but inverts Prisma `where: {}` intuition; dev-warn on unknown filter operators (today: silently never match).
- [ ] **B6.** CI: make coverage thresholds fail the build; run an examples smoke-subset at runtime (Convention 2 calls examples the integration layer; they're only type-checked); lift `contract/schema.ts` branch coverage (44.6%).
- [ ] **B7.** `TopologyRecorder.getChildren` is O(n) per call (TopologyRecorder.ts:386–389) — add parent→children index if Lens uses it hot; `CommitRangeIndex.close()` silently ignores re-close with different endIdx — dev-warn; `pendingForkByName` entries for never-entered fork children linger within-run (cleared between runs) — note or sweep.
- [ ] **B8.** Known model gaps (tracked in JSDoc): key deletion unrepresentable in `MemoryPatch` (future `delete` verb); `deepSmartMerge` array dedup is reference-equality only.
- [x] **B9.** ~~npm tarball ships CLAUDE.md + AGENTS.md~~ — **won't-fix (converged):** deliberate AI-IDE discoverability channel. Optional: trimmed `llms.txt`-style index later.

**UI tier (explainable-ui [E] · agentfootprint-lens [L] · agentThinkingUI [T]) — details in each repo's REVIEW.md**
- [ ] **U1. [stack-wide]** Shared versioned trace/event schema package (`@footprintjs/trace-schema`): zod/JSON-Schema shapes for snapshot, commitLog, narrative entries, and agentfootprint events + `traceVersion` field emitted by core. All three UIs call `validateTrace()` at ingestion and show a version-mismatch banner. *The same P0 appears independently in all three UI reviews — one fix, three consumers. Pairs with #19/#20.*
- [ ] **U2. [E]** Golden-trace fixture pipeline (generated from footprintjs examples, checked in) + shell-level tests — fixes inverted coverage (66.4% lines/50.1% branches overall; ExplainableShell 0–33%) and doubles as the cross-repo contract test.
- [ ] **U3. [E+L]** Scale envelope to match core Phase 3: virtualize narrative/commit lists [E] and EventStream/RunTreeView [L]; `maxEvents` FIFO cap on LensRecorder; selector memoization by version key [L]. *Ship in the same window as #13–15 so the viewers don't lag the runtime.*
- [ ] **U4. [L]** Dev-mode warning + counter for unknown event types and bracket mismatches (today: silent attach/skip — LensRecorder.ts); test for `useLensRecorder`; one a11y pass.
- [ ] **U5. [T]** `validateTrace()` in adapters + at mount; extract extended thinking from OTLP/OpenInference (opt-in); responsive `layoutFlow(containerDims)` (drop hardcoded COLW/ROWH); speed-scale animation delays; console-warn the deprecated `AgentFootprint` alias (v0.11), drop in v1.0; `tsc --noEmit` demo-vs-`.d.ts` CI guard.
- [ ] **U6. [T]** "Works with any OTel-emitting framework" example (LangChain/CrewAI/Mastra trace → ATUI story) — the adoption-funnel showcase; pairs with #19/#21.

**agentfootprint**
- [ ] **B10a.** *(from composability audit)* Apply the `defineMemory` dependency-inversion pattern to the other optional subsystems: cache, security/governance, reliability, thinking become definition objects consumed by the builder instead of hard core imports. Breaks the only module cycle (`core ↔ reliability`), cleans the `security → adapters` edge (shared types instead), and makes `Agent` tree-shakeable (today `cache/strategies/*` side-effects defeat shaking). Hub goes thin; leaves stay Lego.
- [ ] **B10.** Split `AgentBuilder.ts` (761 lines / 28+ methods → sub-builders) and consolidate the 8+ `build*Chart/Slot/Subflow` helpers; `Agent.ts` (961) and `toolCalls.ts` (437: permission gate + credential resolution + dispatch in one function) are the next candidates.
- [ ] **B11.** `skillGraph.tree()` "exactly one leaf fires" — add dev-mode exhaustiveness/overlap check on compiled predicates.
- [ ] **B12.** Resume semantics: failed iteration's tool calls re-execute on `resumeOnError` (runCheckpoint.ts:37–39) — document idempotency requirements prominently; consider toolCallId-based dedup helper for mutating tools.
- [ ] **B13.** Prompt-injection security guide: PermissionPolicy gates *which* tools, not *why* the model called them — document recommended external guards/input validation; consider optional `inputValidator` hook in v7.
- [ ] **B14.** `humanizeLLMError` regex set is SDK-format-fragile — add fallthrough tests per provider SDK major.
- [ ] **B15.** `Loop.until` guard receives `latestOutput: string` only — consider structured output support for complex exit conditions.
- [ ] **B16.** Per-tool circuit breakers (today provider-level all-or-nothing) — future enhancement, document the design choice.
