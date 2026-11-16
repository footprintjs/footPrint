---
paths:
  - "src/lib/builder/**"
  - "src/lib/recorder/**"
  - "src/lib/scope/**"
  - "src/lib/reactive/**"
  - "test/architecture/**"
---

# Extensions — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-040"></a>

## Extension points

<a id="cl-041"></a>

- **New stage kind**: boolean flag on `StageNode` (engine/graph/StageNode.ts — kinds are flags, not an enum) + builder method on FlowChartBuilder (pattern: addPausableFunction; fire structure events endpoint-before-edge) + phase in the hard-coded chain `executeNodeStep` (FlowchartTraverser.ts — no handler registry; new handler class takes HandlerDeps, engine/types.ts, instantiated in the traverser ctor). Must also edit 5 type-union sites: engine/types.ts · RuntimeStructureMetadata.type, engine/types.ts · SerializedPipelineNode.type, builder/types.ts · SerializedPipelineStructure.type, builder/types.ts · FlowChartSpec.type, and computeNodeType's flag→type mapping (RuntimeStructureManager.ts — the only one the compiler won't flag; miss it and the new kind silently serializes as 'stage'). Zero-engine alternative: pure sugar over addFunction (pattern: addDetachAndForget). WORKED EXAMPLE (9.14.0 addParallelForEach): flag `isDynamicParallel` + ParallelForEachHandler + Phase 0b (BEFORE Phase 1 VALIDATE — the node has no fn/children/decider by design); it added NO new node type — the spec carries a BOOLEAN and computeNodeType returns 'fork' (precedent: isPausable/isLazy/isStreaming are flags on a 'stage'), which is the cheaper choice whenever the new kind is a variant of an existing shape.

<a id="cl-042"></a>

- **Decider/selector**: addDeciderFunction → DeciderList; addSelectorFunction → SelectorFnList; runtime match on `child.branchId ?? child.id` (`DeciderHandler · prepareDispatch`). Evidence via decide()/select() (decide/decide.ts). `decide()`'s 3rd param is `DefaultBranch = string | { branch, label? }` (9.16.0) — the default is chosen by NO rule, so `rules[].label` can never name it; the object form puts that label on `DecisionEvidence.defaultLabel`, spread into BOTH evidence exits (matched AND fallthrough) so a harvest doesn't gain/lose the meaning with the data. Bare string ⇒ key absent, byte-identical to pre-9.16. `select()` has no default and is deliberately untouched.

<a id="cl-043"></a>

- **Recorder**: channels = ScopeRecorder (scope/types.ts), FlowRecorder (engine/narrative/types.ts), EmitRecorder (recorder/EmitRecorder.ts — attachEmitRecorder just delegates to the scope channel), CombinedRecorder (recorder/CombinedRecorder.ts, routed by method-shape), StructureRecorder (builder/structure/StructureRecorder.ts, build-time; its hooks are NOT in `HOOKS` (build-time, not a run channel) — the `StructureRecorderDispatcher` fires each by name, so a new structure hook = interface + `fire*` + the builder's `_fire*` helper; 9.24.0 `onStageTagged` is the worked example: names that land AFTER `onStageAdded` through the `.tag()` door go out as their own event, `StructureStageAddedEvent.tags` carries the ones that landed before). Attach via executor.attach*Recorder — idempotent by id. **One registry since 9.36.0 (F6): `recorder/hooks.ts · HOOKS`** — every hook declared once (channels, payload, executor-made); `hooksOn(channel)` drives channel routing and the deferred tier's taps, `CompositeRecorder`'s fan-out is generated from `HOOK_NAMES`, and one `fire` isolates every recorder error (scope → `onError`, flow → dev warning; R10: a throwing `onResume` no longer rejects `resume()`). A hook on an interface but not in `HOOKS` does not compile (`test/architecture/hook-registry-compile.test.ts`). Detection accepts class-prototype methods (blocks only Object.prototype — `CombinedRecorder.ts · hasOwnOrClassMethod`). New built-in = compose a store as a field (no base classes) + factory in src/recorders.ts. `toSnapshot()` bundles are REBUILT field by field into `RecorderSnapshot` (`recorder/snapshot.ts · copyBundle`, called by `runner/snapshot.ts · collectRecorderSnapshots` — so a recorder can't spoof its own `id`); anything not on that copy list is dropped silently — the free-form slot is `meta` (facts about the bundle: which projection, what it omits — what a consumer BRANCHES on; prose goes in `description`). A new bundle field means editing the copy list AND the three `toSnapshot?()` signature sites (scope/types.ts · ScopeRecorder, engine/narrative/types.ts · FlowRecorder, recorder/CombinedRecorder.ts · CombinedRecorder).

<a id="cl-044"></a>

- **Scope $-method (4-file checklist)**: ScopeFacade capability + ReactiveTarget (reactive/types.ts); ScopeMethods type; METHOD_ROUTES (createTypedScope.ts); SCOPE_METHOD_NAMES (reactive/types.ts) — miss #4 and the name becomes a state key.

<a id="cl-045"></a>

- **Contract**: builder.contract() → makeRunnable toOpenAPI/toMCPTool (runner/RunnableChart.ts). BYO schema is duck-typed (`schema/detect.ts · detectSchema`).

<a id="cl-046"></a>

- **Scope provider**: ProviderResolver via registerScopeResolver (exported from /advanced), or a custom scopeFactory. Runtime ownership is explicit in `scope/runtime.ts`: `registerScopeRuntime(scope, { target, handlesAssignments, setBreak? })` maps the user object to its engine port without probing its fields. ScopeFacade, TypedScope, attachScopeMethods and canonical Zod factories auto-register. Other executor/decide/select scopes must register; no duck-typed fallback. One facade per stage owns recording, redaction, argument ownership and commit sealing; adapters use its path-aware accessors instead of writing directly to StageContext.

<a id="cl-047"></a>

- **Detach driver**: `detach/types.ts · DetachDriver`; no driver registry — passed explicitly. The three batching adapters delegate to `detach/drivers/batch.ts · createBatchSchedule`, the one owner of queued work, dispatch, settlement and handle-registry cleanup. A scheduling failure returns a failed handle, never a stuck queue or a parent exception. `validate()` is explicit caller preflight, not an automatic entry-point hook; do not use it instead of containing failures in the driver. No implicit fallback or retry.

<a id="cl-048"></a>

- **Observability dial** (pattern): capture/ primitive + FlowChartExecutorOptions option + snapshot discriminant — FOUR dials now: readTracking/writeTracking/commitValues/writeProvenance (#P1: `'reads-prefix'` stamps `TraceEntry.readKeys` = keys tracked-read before each write; consumed by causalChain `edgeAttribution: 'per-write'` and sliceForKey's default). Propagation is the same 6-site pattern for all four.

<a id="cl-049"></a>

- **Second worked example (10.1 `onAttempt`)** — the same chain: `FlowAttemptEvent` + `FlowRecorder.onAttempt?` + `IControlFlowNarrative.onAttempt` → `FlowRecorderDispatcher · onAttempt` → `NullControlFlowNarrativeGenerator` no-op → `HOOKS.onAttempt` (placed before `onStageRetry`; `hooks.test.ts` pins the list and the 25/28 counts) → `NarrativeFlowRecorder · onAttempt` (`formatting/sentences.ts · attemptSentence`) → `CombinedNarrativeRecorder` buffers it (`bufferOp`) as `CombinedNarrativeEntry.type: 'attempt'`, rendered by `NarrativeFormatter.renderAttempt` (string / null / undefined) → barrels. Two narrative laws it added: the attempt line REPLACES the retry line (`onStageRetry` still fires, the built-ins no longer narrate it; `NarrativeFormatter.renderRetry` and `CombinedNarrativeRecorder · onStageRetry` were removed in 10.1), and a FAILED stage's buffered attempt lines are flushed beneath its `[Error]` line (`flushAttempts` — its reads/writes still are not, so a no-policy failure narrates byte-identically).

<a id="cl-050"></a>

- **Worked example of a new FLOW hook (9.15.0 `onStageRetry`)**: `FlowStageRetryEvent` + `FlowRecorder.onStageRetry?` + `IControlFlowNarrative.onStageRetry` (engine/narrative/types.ts) → `FlowRecorderDispatcher` impl → `NullControlFlowNarrativeGenerator` no-op (interface is REQUIRED there) → **its `HOOKS` entry (recorder/hooks.ts)** → `NarrativeFlowRecorder` sentence (the 8 strategies extend it, so they inherit free) → `CombinedNarrativeRecorder` + `CombinedNarrativeEntry.type` + `NarrativeFormatter.renderRetry` (removed in 10.1 — the attempt line replaced it) → barrels (the composite fan-out is generated). Retry is the only flow event that fires DURING a stage, so the narrative BUFFERS it via `bufferOp` (the `onEmit` precedent) — pushing it straight to the store would place the line before its own stage header.

<a id="cl-051"></a>

- **Closed seams that look open**: ExecutionEnv (fixed type); decide() operators (`filter/evaluator.ts · OPERATOR_HANDLERS`, module-private); METHOD_ROUTES; the executeNodeStep phase chain; emit dispatcher (rides scope channel).
