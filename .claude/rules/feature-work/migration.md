---
paths:
  - ".claude/rules/feature-work/migration.md"
---

# Root instruction migration

Source: `CLAUDE.md` at commit `a4bc026ce65d55447810ea84f4cb5b31a18cd604`. Every original nonblank heading, table row, bullet and paragraph is retained below its linked stable anchor, including every clause of long paragraphs. Nothing is silently reclassified as an obsolete rule. Relative Markdown link targets were rebased for their new directory. Table-row anchors sit inside first cells; separator anchors precede the intact table. Removing anchor markup recovers every original row exactly. Read the short root map first; these references supply all prior detail and qualifications.

| Original entry | Rule or context (all subclauses retained) | New owner |
| --- | --- | --- |
| `cl-001` | Introduction — !-- analyzed-at: 22953d9 @ 2026-07-02  /  model: fable-5 -- | [architecture](./architecture.md#cl-001) |
| `cl-002` | Introduction — Self-explaining flowchart engine: a fluent builder emits a static chart; one DFS pass executes it wh | [architecture](./architecture.md#cl-002) |
| `cl-003` | Module map — Module map | [architecture](./architecture.md#cl-003) |
| `cl-004` | Module map — Entry points: footprintjs (engine API), /recorders, /trace (engine recorders, stores and structure w | [architecture](./architecture.md#cl-004) |
| `cl-005` | Module map — /  src/lib/  /  one job  / | [architecture](./architecture.md#cl-005) |
| `cl-006` | Module map — / --- / --- / | [architecture](./architecture.md#cl-006) |
| `cl-007` | Module map — /  capture/  /  engine retention policies, bounded payload summarization, hook invocation and dev-mo | [architecture](./architecture.md#cl-007) |
| `cl-008` | Module map — /  memory/  /  engine composition and policy: StageContext composes RecordFrame from foottrace/write | [architecture](./architecture.md#cl-008) |
| `cl-009` | Module map — /  schema/  /  duck-typed validation (.safeParse/.parse ⇒ 'parseable')  / | [architecture](./architecture.md#cl-009) |
| `cl-010` | Module map — /  builder/  /  fluent DSL → FlowChartSpec → StageNode graph; build-time StructureRecorder channel.  | [architecture](./architecture.md#cl-010) |
| `cl-011` | Module map — /  builder/retryLoop.ts  /  addRetryLoop (10.1, P3b) composes ordinary attempt/reconcile/decide/wait | [architecture](./architecture.md#cl-011) |
| `cl-012` | Module map — /  budget/  /  the static time budget (10.1, P5): timeBudget(chart) walks the BUILT graph once (expl | [architecture](./architecture.md#cl-012) |
| `cl-013` | Module map — /  scope/  /  ScopeFacade per stage (tracked get/set, $emit, frozen args/env); built-in ScopeRecorde | [architecture](./architecture.md#cl-013) |
| `cl-014` | Module map — /  reactive/  /  TypedScope deep Proxy over the facade — four write laws + the honest boundary (what | [architecture](./architecture.md#cl-014) |
| `cl-015` | Module map — /  decide/  /  decide()/select() evidence capture  / | [architecture](./architecture.md#cl-015) |
| `cl-016` | Module map — /  filter/  /  evaluator.ts · evaluateFilter — the ONE filter-rule law, shared by decide() and the a | [architecture](./architecture.md#cl-016) |
| `cl-017` | Module map — /  attempt/  /  the ONE retry loop and its record (10.1, docs/design/2026-10-time-and-failure-eviden | [architecture](./architecture.md#cl-017) |
| `cl-018` | Module map — /  timers/  /  the ONE long-timer law, a neutral L0 leaf folder (like ids/): longTimeout.ts · setLon | [architecture](./architecture.md#cl-018) |
| `cl-019` | Module map — /  recorder/  /  engine stores (KeyedStore/SequenceStore/BoundaryStateStore), CombinedRecorder routi | [architecture](./architecture.md#cl-019) |
| `cl-020` | Module map — /  pause/  /  PauseSignal / FlowchartCheckpoint types + interrupt(scope, payload) (throws InterruptS | [architecture](./architecture.md#cl-020) |
| `cl-021` | Module map — /  engine/  /  FlowchartTraverser + handlers/; narrative/ = the whole FlowRecorder channel (dispatch | [architecture](./architecture.md#cl-021) |
| `cl-022` | Module map — /  runner/  /  FlowChartExecutor wiring — composes attach.ts (RunObservers) · resume.ts · checkpoint | [architecture](./architecture.md#cl-022) |
| `cl-023` | Module map — /  observer-queue/  /  pure deferred-delivery pipeline (engine imports IT, never reverse)  / | [architecture](./architecture.md#cl-023) |
| `cl-024` | Module map — /  sinks/  /  (10.1, P6) fileSink / readRecordFile — the crash-safe record on a Node host: one JSON  | [architecture](./architecture.md#cl-024) |
| `cl-025` | Module map — /  contract/, detach/  /  I/O schema normalization (OpenAPI generation belongs to runner/RunnableCha | [architecture](./architecture.md#cl-025) |
| `cl-026` | Module map — The fence: engine files import only their own layer or below, using scripts/layering.config.cjs as t | [architecture](./architecture.md#cl-026) |
| `cl-027` | Core state & flow — Core state & flow | [execution](./execution.md#cl-027) |
| `cl-028` | Core state & flow — Component lifecycle wiring: runner/NativeRunLifecycle.ts owns weak component-port | [execution](./execution.md#cl-028) |
| `cl-029` | Core state & flow — SharedMemory (foottrace/write) is the copy-on-write live heap. StageContext decides the address with | [execution](./execution.md#cl-029) |
| `cl-030` | Core state & flow — StageContext (memory/StageContext.ts) owns per-stage run context. stageWrite decides redaction and i | [execution](./execution.md#cl-030) |
| `cl-031` | Core state & flow — CommitBundle (foottrace) / EventLog (foottrace/write) retain the existing bundle/index and full/delt | [execution](./execution.md#cl-031) |
| `cl-032` | Core state & flow — TraversalContext (engine/narrative/types.ts) — THE per-event context (runId, runtimeStageId, parentR | [execution](./execution.md#cl-032) |
| `cl-033` | Core state & flow — runtimeStageId = [subflowPath/]stageId#executionIndex; counter shared by reference into subflow trav | [execution](./execution.md#cl-033) |
| `cl-034` | Core state & flow — Subflows get a fresh isolated ExecutionRuntime (SubflowExecutor · executeSubflow); inputMapper seeds | [execution](./execution.md#cl-034) |
| `cl-035` | Core state & flow — Retry (9.15.0; on the attempt runner since 10.1): StageNode.retry is a POLICY on a stage, not a kind | [execution](./execution.md#cl-035) |
| `cl-036` | Core state & flow — In-stage calls (10.1, P2): scope.$call(target, fn, policy?) (four-file checklist: ScopeFacade · call | [execution](./execution.md#cl-036) |
| `cl-037` | Core state & flow — Time budget (10.1, P1b): armRun (runner/deadline.ts) composes RunOptions.signal, env.signal and the  | [execution](./execution.md#cl-037) |
| `cl-038` | Core state & flow — Declared tags (9.21.0): StageNode.tags?: readonly string[] is a NAME on a stage, declared at build t | [execution](./execution.md#cl-038) |
| `cl-039` | Core state & flow — Event order (code-verified; older docs had 3/4 swapped): onStageStart → onRead/onWrite (live, PRE-co | [execution](./execution.md#cl-039) |
| `cl-040` | Extension points — Extension points | [extensions](./extensions.md#cl-040) |
| `cl-041` | Extension points — New stage kind: boolean flag on StageNode (engine/graph/StageNode.ts — kinds are flags, not an enum) | [extensions](./extensions.md#cl-041) |
| `cl-042` | Extension points — Decider/selector: addDeciderFunction → DeciderList; addSelectorFunction → SelectorFnList; runtime ma | [extensions](./extensions.md#cl-042) |
| `cl-043` | Extension points — Recorder: channels = ScopeRecorder (scope/types.ts), FlowRecorder (engine/narrative/types.ts), EmitR | [extensions](./extensions.md#cl-043) |
| `cl-044` | Extension points — Scope $-method (4-file checklist): ScopeFacade capability + ReactiveTarget (reactive/types.ts); Scop | [extensions](./extensions.md#cl-044) |
| `cl-045` | Extension points — Contract: builder.contract() → makeRunnable toOpenAPI/toMCPTool (runner/RunnableChart.ts). BYO schem | [extensions](./extensions.md#cl-045) |
| `cl-046` | Extension points — Scope provider: ProviderResolver via registerScopeResolver (exported from /advanced), or a custom sc | [extensions](./extensions.md#cl-046) |
| `cl-047` | Extension points — Detach driver: detach/types.ts · DetachDriver; no driver registry — passed explicitly. The three bat | [extensions](./extensions.md#cl-047) |
| `cl-048` | Extension points — Observability dial (pattern): capture/ primitive + FlowChartExecutorOptions option + snapshot discri | [extensions](./extensions.md#cl-048) |
| `cl-049` | Extension points — Second worked example (10.1 onAttempt) — the same chain: FlowAttemptEvent + FlowRecorder.onAttempt?  | [extensions](./extensions.md#cl-049) |
| `cl-050` | Extension points — Worked example of a new FLOW hook (9.15.0 onStageRetry): FlowStageRetryEvent + FlowRecorder.onStageR | [extensions](./extensions.md#cl-050) |
| `cl-051` | Extension points — Closed seams that look open: ExecutionEnv (fixed type); decide() operators (filter/evaluator.ts · OP | [extensions](./extensions.md#cl-051) |
| `cl-052` | Change-impact map — Change-impact map | [change-impact](./change-impact.md#cl-052) |
| `cl-053` | Change-impact map — Record sink (10.1, P6) → foottrace's RecordSink port; the engine composes. runner/recordSink.ts · Ru | [change-impact](./change-impact.md#cl-053) |
| `cl-054` | Change-impact map — Nested diagnostic writes → DiagnosticCollector uses the public foottrace/paths nested writers. They  | [change-impact](./change-impact.md#cl-054) |
| `cl-055` | Change-impact map — Trace verbs (set / merge / append / delete, TraceEntry.verb) → the record law lives only in foottrac | [change-impact](./change-impact.md#cl-055) |
| `cl-056` | Change-impact map — Write address → ONE constant, runAddress.ts · RUN_NAMESPACE (an L4 leaf, C4), read by runAddress / u | [change-impact](./change-impact.md#cl-056) |
| `cl-057` | Change-impact map — StageContext.commit / dials → ONE owner since 9.35.0 (F5): memory/runPolicy.ts — a frozen RunPolicy  | [change-impact](./change-impact.md#cl-057) |
| `cl-058` | Change-impact map — runtimeStageId format (#// delimiters) → foottrace owns build/parse/read and the brands RuntimeStage | [change-impact](./change-impact.md#cl-058) |
| `cl-059` | Change-impact map — Subflow id prefixing → ONE prefixer since 9.37.0: engine/graph/prefixNodeTree.ts, used by the builde | [change-impact](./change-impact.md#cl-059) |
| `cl-060` | Change-impact map — Checkpoint shape (format 2 since 9.44.0, LEAN: only what resume reads + the pause's record — no exec | [change-impact](./change-impact.md#cl-060) |
| `cl-061` | Change-impact map — Committed-state writers → copy-on-write staging and commit belong to foottrace. The engine composes  | [change-impact](./change-impact.md#cl-061) |
| `cl-062` | Change-impact map — Redaction (9.19.0; the law restored to owner ruling (a)) has ONE owner of the DECISION, memory/redac | [change-impact](./change-impact.md#cl-062) |
| `cl-063` | Change-impact map — Diagnostic retention → DiagnosticCollector asks the current run rule before merging/storing: a named | [change-impact](./change-impact.md#cl-063) |
| `cl-064` | Change-impact map — Traverser phases → node-shape reads must use eff overlay accessors or dynamic StageNode returns brea | [change-impact](./change-impact.md#cl-064) |
| `cl-065` | End-to-end trace (seed → decider → loop branch → finish) — End-to-end trace (seed → decider → loop branch → finish) | [walkthrough](./walkthrough.md#cl-065) |
| `cl-066` | End-to-end trace (seed → decider → loop branch → finish) — build: flowChart() → FlowChartBuilder.start → addDeciderFunction → branch {loopTo} plants stub next= | [walkthrough](./walkthrough.md#cl-066) |
| `cl-067` | Backtracking — Backtracking | [failure-and-resume](./failure-and-resume.md#cl-067) |
| `cl-068` | Backtracking — Native terminal failure (#109): errors/terminalFailure.ts is an L0 leaf owning TerminalFailureContex | [failure-and-resume](./failure-and-resume.md#cl-068) |
| `cl-069` | Backtracking — Seven mechanisms, no state rollback anywhere: M1 TransactionBuffer staging + net-change commit — com | [failure-and-resume](./failure-and-resume.md#cl-069) |
| `cl-070` | Invariants (assumed, not stated) — Invariants (assumed, not stated) | [invariants](./invariants.md#cl-070) |
| `cl-071` | Invariants (assumed, not stated) — The admitted record (9.30.0) — a commit's bundle, replayed onto the state its stage began from, give | [invariants](./invariants.md#cl-071) |
| `cl-072` | Invariants (assumed, not stated) — Committed state immutable-after-swap — a generation is NEVER edited, and since 9.29.0 generations SH | [invariants](./invariants.md#cl-072) |
| `cl-073` | Invariants (assumed, not stated) — Reads are borrowed live references (recorders get them un-cloned) — never mutate. | [invariants](./invariants.md#cl-073) |
| `cl-074` | Invariants (assumed, not stated) — The commit log is never the reader's to edit. Foottrace owns freezeRecord (foottrace/write) and serv | [invariants](./invariants.md#cl-074) |
| `cl-075` | Invariants (assumed, not stated) — executionIndex globally monotonic per run; continues across resume. The FIRST CommitBundle per runti | [invariants](./invariants.md#cl-075) |
| `cl-076` | Invariants (assumed, not stated) — runtimeStageId stamped BEFORE the stage runs — the entire event-correlation model rests on scope+flo | [invariants](./invariants.md#cl-076) |
| `cl-077` | Invariants (assumed, not stated) — One executor = one run at a time (_isExecuting guard). State values must survive structuredClone. | [invariants](./invariants.md#cl-077) |
| `cl-078` | Invariants (assumed, not stated) — A resume re-enters ONCE (ResumeEntry, 9.28.0): the stand-in carries the paused stage's id but is onl | [invariants](./invariants.md#cl-078) |
| `cl-079` | Invariants (assumed, not stated) — Loop-ref stubs deliberately VIOLATE node-id uniqueness — every graph search must skip isLoopRef firs | [invariants](./invariants.md#cl-079) |
| `cl-080` | Invariants (assumed, not stated) — runId regenerates per run() AND per resume(); recorders detect new runs via traversalContext.runId.  | [invariants](./invariants.md#cl-080) |
| `cl-081` | Invariants (assumed, not stated) — Recorder errors never abort traversal (isolated by recorder/hooks.ts · fire; every recorder ErrorEve | [invariants](./invariants.md#cl-081) |
| `cl-082` | Invariants (assumed, not stated) — Deferred-observer capture default at the executor tier is 'clone' (the DeferredObserverTier construc | [invariants](./invariants.md#cl-082) |
| `cl-083` | Invariants (assumed, not stated) — getSnapshot().recorders = ONE row per recorder id, across both channels and both delivery tiers (run | [invariants](./invariants.md#cl-083) |
| `cl-084` | Landmines — Landmines | [landmines](./landmines.md#cl-084) |
| `cl-085` | Landmines — 1. NOT a landmine any more (9.24.0), recorded because it was one for eight releases: TypedScope's se | [landmines](./landmines.md#cl-085) |
| `cl-086` | Landmines — 2. Fork "parent breaks when ALL children broke" is implemented (ChildrenExecutor · executeNodeChildr | [landmines](./landmines.md#cl-086) |
| `cl-087` | Landmines — 3. First bite CLOSED (9.23.0 — clone once at commit): TransactionBuffer · set now stores the REFEREN | [landmines](./landmines.md#cl-087) |
| `cl-088` | Landmines — 4. NOT a landmine any more (9.22.0), recorded because it was one: an indexed array read (arr[i]) use | [landmines](./landmines.md#cl-088) |
| `cl-089` | Pointers — Pointers | [architecture](./architecture.md#cl-089) |
| `cl-090` | Pointers — .claude/rules/backtracking.md — the 7 mechanisms with step tables + pseudocode | [architecture](./architecture.md#cl-090) |
| `cl-091` | Pointers — docs/guides/ (error-handling, observers-deferred) · examples/ — mandatory integration tests (Convent | [architecture](./architecture.md#cl-091) |
| `cl-092` | Pointers — Build/test: npm run build (CJS+ESM+types), npm test | [architecture](./architecture.md#cl-092) |
| `cl-093` | Attempt metrics (10.1, P7) — Attempt metrics (10.1, P7) | [attempt-metrics](./attempt-metrics.md#cl-093) |
| `cl-094` | Attempt metrics (10.1, P7) — recorder/AttemptRecorder.ts owns the opt-in attempts() flow recorder (footprintjs/recorders). It com | [attempt-metrics](./attempt-metrics.md#cl-094) |
| `cl-095` | Attempt metrics (10.1, P7) — P7 admission reads plain own data descriptors (including nested loops and array windows) before fiel | [attempt-metrics](./attempt-metrics.md#cl-095) |
| `cl-096` | Attempt metrics (10.1, P7) — Queued-sibling re-raise notifications use current-leg root context at FlowchartTraverser.walkThenRai | [attempt-metrics](./attempt-metrics.md#cl-096) |
| `cl-097` | Attempt metrics (10.1, P7) — A shared recorder's auto-clear preserves already-emitted rows for active/paused ownership; completed | [attempt-metrics](./attempt-metrics.md#cl-097) |
| `cl-098` | Stage attention (C2) — Stage attention (C2) | [stage-attention](./stage-attention.md#cl-098) |
| `cl-099` | Stage attention (C2) — memory/attention.ts · StageAttention owns attention bookkeeping; StageContext holds one helper and d | [stage-attention](./stage-attention.md#cl-099) |
