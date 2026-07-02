<!-- analyzed-at: 22953d9 @ 2026-07-02 | model: fable-5 -->
# footprintjs — feature-work map

Self-explaining flowchart engine: a fluent builder emits a static chart; one DFS pass executes it while observer channels + a commit log capture everything ("collect during traversal, never post-process"). This file maps seams and blast radius; for API description read the code/README — **trust the code** where any doc disagrees.

## Module map
Entry points: `footprintjs` (public API) · `/recorders` (factories) · `/trace` (commitLog queries, stores, causalChain) · `/advanced` (engine internals) · `/detach` · `/zod` (opt-in; zod never imported by core). New public symbols are wired through the barrel that OWNS them (canonical path); `/advanced` re-exports only a small hand-picked trace subset — do not assume `export *` chaining.

| src/lib/ | one job |
|---|---|
| capture/ | retention policies + bounded payload summarization (leaf; shared by tracking dials AND deferred-observer capture) |
| memory/ | transactional state: SharedMemory heap, StageContext frames, TransactionBuffer staging, EventLog commit log — PLUS trace analysis (backtrack.ts causalChain, commitLogUtils.ts) |
| schema/ | duck-typed validation (`.safeParse/.parse` ⇒ 'parseable') |
| builder/ | fluent DSL → FlowChartSpec → StageNode graph; build-time StructureRecorder channel. NOT standalone: imports runner's makeRunnable (FlowChartBuilder.ts:18) |
| scope/ | ScopeFacade per stage (tracked get/set, $emit, frozen args/env); built-in ScopeRecorders in scope/recorders/ |
| reactive/ | TypedScope deep Proxy over the facade |
| decide/ | decide()/select() evidence capture |
| recorder/ | stores (KeyedStore/SequenceStore/BoundaryStateStore), CombinedRecorder routing, built-ins (Topology/InOut/ControlDep/Quality) |
| slice/ | variable-first backward slicing (triage query layer): sliceForKey (anchor at last writer → causalChain) + arrayProvenance/elementProvenance (append-fold element births — the agent mega-key fix) + KeysReadSource strategies. Pure post-hoc queries; imports memory/ ONLY (see src/lib/slice/README.md) |
| pause/ | PauseSignal / FlowchartCheckpoint types |
| engine/ | FlowchartTraverser + handlers/; narrative/ = the whole FlowRecorder channel (dispatcher + 9 strategies), not just text |
| runner/ | FlowChartExecutor wiring (runtime, recorders, pause/resume, snapshot, DeferredObserverTier). RunContext.ts is a fluent run builder, NOT the threaded per-run context |
| observer-queue/ | pure deferred-delivery pipeline (engine imports IT, never reverse) |
| contract/, detach/ | I/O schema + OpenAPI; fire-and-forget child charts (drivers passed explicitly) |

## Core state & flow
- `SharedMemory` (memory/SharedMemory.ts:14) — run-namespaced heap; committed state is **immutable-after-swap** (applySmartMerge clones+swaps).
- `StageContext` (memory/StageContext.ts:29) — per-stage frame: lazy TransactionBuffer + first-touch view; `commit()` (:531) applies patch → redacted mirror → EventLog.record → onCommit.
- `CommitBundle`/`EventLog` — one bundle per executed stage, `bundle.idx` == array position; encoding governed by `commitValues: 'full'|'delta'`.
- `TraversalContext` (engine/narrative/types.ts:172) — THE per-event context (runId, runtimeStageId, parentRuntimeStageId, subflowPath, loopIteration); stamped on every FlowRecorder event.
- `runtimeStageId` = `[subflowPath/]stageId#executionIndex`; counter shared by reference into subflow traversers → globally unique; NOT reset on resume.
- Subflows get a fresh isolated ExecutionRuntime (SubflowExecutor.ts:119); inputMapper seeds, outputMapper merges back (arrays CONCAT unless `arrayMerge: Replace`).

**Event order (code-verified; older docs had 3/4 swapped):** onStageStart → onRead/onWrite (live, PRE-commit) → **onStageEnd (StageRunner.ts:81) → onCommit (StageContext.ts:587)** → FlowRecorder onDecision/onFork/onSelected/onSubflowEntry → onStageExecuted (uniform, with stageType). Error path: commit STILL happens (FlowchartTraverser.ts:1088) before onError+rethrow — a failing stage's writes land.

## Extension points
- **New stage kind**: boolean flag on `StageNode` (engine/graph/StageNode.ts:39 — kinds are flags, not an enum) + builder method on FlowChartBuilder (pattern: addPausableFunction :1264; fire structure events endpoint-before-edge) + phase in the hard-coded chain `executeNodeStep` (FlowchartTraverser.ts:801 — no handler registry; new handler class takes HandlerDeps, engine/types.ts:344, instantiated in traverser ctor :402-413). Must also edit 5 type-union sites: engine/types.ts:477, builder/types.ts:50, builder/types.ts:104, engine/types.ts:427, and computeNodeType's flag→type mapping (RuntimeStructureManager.ts:19-21 — the only one the compiler won't flag; miss it and the new kind silently serializes as 'stage'). Zero-engine alternative: pure sugar over addFunction (pattern: addDetachAndForget :1343).
- **Decider/selector**: addDeciderFunction :1433 → DeciderList (:53); addSelectorFunction :1478 → SelectorFnList (:428); runtime match on `child.branchId ?? child.id` (DeciderHandler.ts:133). Evidence via decide()/select() (decide/decide.ts:169/218).
- **Recorder**: channels = ScopeRecorder (scope/types.ts:137), FlowRecorder (engine/narrative/types.ts:425), EmitRecorder (recorder/EmitRecorder.ts:121 — attachEmitRecorder just delegates to the scope channel), CombinedRecorder (recorder/CombinedRecorder.ts:98, routed by method-shape), StructureRecorder (builder/structure/StructureRecorder.ts:347, build-time). Attach via executor.attach*Recorder — idempotent by id. **Sync rule: a new hook name MUST also go into `RECORDER_EVENT_METHODS`/`FLOW_…`/`EMIT_…` (CombinedRecorder.ts:198/219/247)** — they drive both combined routing AND the deferred tier's taps; miss it and deferred recorders silently never see the event. Detection accepts class-prototype methods (blocks only Object.prototype — CombinedRecorder.ts:266). New built-in = compose a store as a field (no base classes) + factory in src/recorders.ts.
- **Scope $-method (4-file checklist)**: ScopeFacade capability + ReactiveTarget (reactive/types.ts:20); ScopeMethods type (:74); METHOD_ROUTES (createTypedScope.ts:46); SCOPE_METHOD_NAMES (reactive/types.ts:262) — miss #4 and the name becomes a state key.
- **Contract**: builder.contract() (:1056) → makeRunnable toOpenAPI/toMCPTool (runner/RunnableChart.ts:83/153). BYO schema is duck-typed (schema/detect.ts:24).
- **Scope provider**: ProviderResolver (scope/providers/types.ts:35) via registerScopeResolver (registry.ts:15; exported from /advanced). Simpler: custom scopeFactory (engine/types.ts:73).
- **Detach driver**: DetachDriver (detach/types.ts:186); no registry — passed explicitly.
- **Observability dial** (pattern): capture/ primitive + FlowChartExecutorOptions option + snapshot discriminant — FOUR dials now: readTracking/writeTracking/commitValues/writeProvenance (#P1: `'reads-prefix'` stamps `TraceEntry.readKeys` = keys tracked-read before each write; consumed by causalChain `edgeAttribution: 'per-write'` and sliceForKey's default). Propagation is the same 6-site pattern for all four.
- **Closed seams that look open**: ExecutionEnv (fixed type); decide() operators (evaluator.ts:19 module-private); METHOD_ROUTES; the executeNodeStep phase chain; emit dispatcher (rides scope channel).

## Change-impact map
- **Trace verbs** (`set|merge|append|delete`, memory/types.ts:42) → FOUR verb-switch replicas in lockstep: applySmartMerge (utils.ts:254 — live commit AND EventLog.materialise), commitValueAt (commitLogUtils.ts:82), TransactionBuffer.toDeltaPayload/replayPathVerbs (:248-328); plus causalChain/findLastWriter readers.
- **StageContext.commit / dials** → dial propagation is TRIPLICATED: ExecutionRuntime.use* (:131-161), createNext/createChild inheritance (StageContext.ts:619/640), SubflowExecutor duck-push (:151-173) — miss one and subflows silently run the default. Applies to all FOUR dials incl. writeProvenance (#P1).
- **runtimeStageId format** (`#`/`/` delimiters) → string parsers everywhere: parseRuntimeStageId, ScopeFacade._getSubflowPath, subflowResults dual-keying, checkpoint lean-filter, narrative buffering, store keys.
- **Subflow id prefixing** → DUPLICATED prefixer: builder _prefixNodeTree (:1968) and traverser prefixNodeTree (FlowchartTraverser.ts:1356) are byte-twins; change both + stageMap key composition + resume drilling.
- **Checkpoint shape** → buildPauseCheckpoint (FlowChartExecutor.ts:987) ↔ resume() validation (:690) ↔ checkpointSanitize ↔ SubflowExecutor resume-seed (skip-inputMapper, :69-72).
- **Redaction** has FIVE enforcement points: facade get/set values, _stageWrites placeholder, commit-log redactPatch, redacted mirror, emitPatterns.
- **Traverser phases** → node-shape reads must use eff* overlay accessors (:646-703) or dynamic StageNode returns break; tail continuations must return ContinuationHops or stacks regrow; decider flat-dispatch must keep InvokerStamp or pause loses its invoker.

## End-to-end trace (seed → decider → loop branch → finish)
build: flowChart() → FlowChartBuilder.start → addDeciderFunction → branch {loopTo} plants stub `next={id,isLoopRef:true}` (:346) → build() → makeRunnable.
run: executor.run (FlowChartExecutor.ts:1455): re-entrancy guard → fresh runId → createTraverser (:336; composes scopeFactory: TypedScope + recorders + redaction :379-444) → new ExecutionRuntime (SharedMemory+EventLog+root StageContext) → traverser.execute (:501) fires onRunStart → trampoline executeNode (:738; flat hops, recursion only for forks/subflows/decider-with-next, depth cap 500).
per stage: executeNodeStep stamps runtimeStageId (:818) → StageRunner.run: scopeFactory → onStageStart → stage fn (writes stage into TransactionBuffer via StageContext.setObject; onWrite fires live) → onStageEnd → traverser calls context.commit() (:1094) → onCommit → onStageExecuted (narrative flushes buffered ops here).
decider: DeciderHandler.prepareDispatch (:89) — runs stage, **commits BEFORE branch resolution** (:124), matches branchId, fires onDecision(+evidence) → onStageExecuted('decider') → flat hop with InvokerStamp.
loop: Phase 6 sees isLoopRef → ContinuationResolver.resolveTarget (:107): id-map lookup, iteration guard (max 1000), onLoop → hop; zero stack, state carries forward (never rewound).
end: onRunEnd (throw → onRunFailed; pause → neither) → deferred terminalFlush → getSnapshot() = {sharedState (LIVE view; dev-mode frozen clone), commitLog, executionTree, subflowResults (dual-keyed), recorders}.

## Backtracking
Five mechanisms, no state rollback anywhere: **M1** TransactionBuffer staging + net-change commit — commit-on-error by design, explicitly NOT rollback (TransactionBuffer.ts:13-18; error path commits then rethrows). **M2** Pause/Resume checkpointing — the only resume-from-prior-point; checkpoint is one detached structuredClone; resume rebuilds the cursor from pausedStageId+subflowPath and only overrides the LEAF subflow root (2+-deep pause re-executes outer pre-mount stages). **M3** commit-log replay (EventLog.materialise, commitValueAt — required under delta mode). **M4** loopTo re-entry — forward execution over accumulated state, bounded by maxIterations + dynamicNextHops. **M5** causalChain backward slicing (read-only analysis; honesty flags for untracked reads; `edgeAttribution: 'per-write'` refines edges via `TraceEntry.readKeys` when the writeProvenance dial recorded them — worklist, subset-of-ceiling safe). **M6 (query layer)** slice/ — variable-first triage: sliceForKey + append-fold element provenance + the ONLY safe serializations (sliceToJSON/formatSlice — never JSON.stringify a slice root). Deep dive + step tables: [.claude/rules/backtracking.md](.claude/rules/backtracking.md).

## Invariants (assumed, not stated)
- Committed state immutable-after-swap; first-touch views hold bare references on that guarantee — in-place mutation of SharedMemory.context corrupts every in-flight stage.
- Reads are borrowed live references (recorders get them un-cloned) — never mutate.
- executionIndex globally monotonic per run; continues across resume. One CommitBundle per executed stage; empty commits are deliberate cursor stops.
- runtimeStageId stamped BEFORE the stage runs — the entire event-correlation model rests on scope+flow events sharing it.
- One executor = one run at a time (_isExecuting guard). State values must survive structuredClone.
- Loop-ref stubs deliberately VIOLATE node-id uniqueness — every graph search must skip `isLoopRef` first.
- runId regenerates per run() AND per resume(); recorders detect new runs via traversalContext.runId (engine never resets them).
- Recorder errors never abort traversal (isolated at invokeHook/emitEvent).
- Deferred-observer capture default at the executor tier is **'clone'** (DeferredObserverTier.ts:167), not 'summary'.

## Landmines
1. TypedScope's set trap JSON-round-trips EVERY object write (createTypedScope.ts:29-40, :363) — Date→string, Map→{}, undefined drops; `$setValue` bypasses it, so the two write paths store different bytes.
2. Fork "parent breaks when ALL children broke" is implemented (ChildrenExecutor.ts:53) but **unwired** — every live call site passes parentBreakFlag=undefined; fork breaks do NOT propagate in real runs.
3. TransactionBuffer.set stores the RAW reference in workingCopy but a CLONE in overwritePatch (:49-56) — post-write mutation changes what the stage reads back and the net-change filter, while committing stale bytes.

## Pointers
- [.claude/rules/backtracking.md](.claude/rules/backtracking.md) — the 5 mechanisms with step tables + pseudocode
- [docs/guides/](docs/guides/) (error-handling, observers-deferred) · [examples/](examples/) — mandatory integration tests (Convention 2); 7 test types per feature (Convention 3)
- Build/test: `npm run build` (CJS+ESM+types), `npm test`
