# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.4.1]

### Added

- **Pausable root stage** — `flowChart('Name', pausableHandler, 'id')` now accepts `PausableHandler` as the root stage. Enables single-stage pausable subflows without post-build graph mutation.

## [4.4.0]

### Added

- **ArrayMergeMode** — `SubflowMountOptions.arrayMerge` controls how array values from `outputMapper` merge into parent scope. `ArrayMergeMode.Concat` (default, existing behavior) appends. `ArrayMergeMode.Replace` overwrites. Essential for Dynamic loops where subflows recompute full arrays each iteration.
- **CombinedNarrativeEntry.key** — exposes the scope key (`string`) on narrative step entries. Enables structured data extraction (e.g., grounding analysis) without matching on rendered text strings.

## [4.3.1]

### Documentation

- **Blog section** — starlight-blog plugin with card grid, header nav (Docs/Blog/Playground), reading time, RSS feed, gradient background.
- **Blog post:** "Pause/Resume: Human-in-the-Loop for Backend Pipelines" with playground link.
- **CLAUDE.md** — documented pause/resume API for AI coding agents.

## [4.3.0]

### Added

- **Pause/Resume — human-in-the-loop for backend pipelines.** Pausable stages stop execution and create a JSON-safe checkpoint. Resume hours later, any server, with the human's response.
  - `addPausableFunction(name, { execute, resume }, id)` — builder method for pausable stages
  - `executor.isPaused()` / `getCheckpoint()` / `resume(checkpoint, input)` — pause lifecycle
  - `PausableHandler<TScope, TInput>` type — `execute` returns data to pause, void to continue
  - `FlowchartCheckpoint` — JSON-serializable checkpoint (store in Redis, Postgres, localStorage)
  - `ExecutorResult = TraversalResult | PausedResult` — proper union return type (no `as any` casts)
  - `ResumeFn<TScope>` — dedicated type for resume functions on StageNode
- **Pause/resume events on both observer systems:**
  - `FlowRecorder.onPause` / `onResume` — control flow events for narrative
  - `Recorder.onPause` / `onResume` — scope events for MetricRecorder (`pauseCount`, `totalPauses`) and DebugRecorder (pause/resume entries, logged even in minimal mode)
- **`pause/` library** (`src/lib/pause/`) — PauseSignal, FlowchartCheckpoint, PausableHandler, type guards. Internal to engine — consumers never import PauseSignal directly.
- **Blog post:** "Pause/Resume: Human-in-the-Loop for Backend Pipelines" in docs site.

### Changed

- **`resume()` reuses ExecutionRuntime** — execution tree, narrative, and metrics are continuous across pause/resume. No merge or graft needed.
- **`preserveSnapshotRoot()`** — `getSnapshot()` always returns the full execution tree from the original root, even after resume changes the traversal starting point.
- **Checkpoint validation** — `resume()` validates `sharedState` (plain object), `pausedStageId` (non-empty string), `subflowPath` (string array) before processing. Protects against tampered checkpoints from external storage.
- **PauseSignal passthrough** — 5 catch sites (FlowchartTraverser, SubflowExecutor, DeciderHandler, SelectorHandler, ChildrenExecutor) detect PauseSignal and re-throw without error logging.

## [4.2.0]

### Added

- **`recorder/` library — CompositeRecorder** (`src/lib/recorder/`) — composition primitive for bundling multiple recorders under a single ID. Implements both `Recorder` and `FlowRecorder` interfaces. Domain libraries use this to export one-call observability presets. Typed child access via `get(Type)`, merged `toSnapshot()`, and `clear()` lifecycle.
- **`MetricRecorder` stageFilter option** — `new MetricRecorder({ stageFilter: (name) => ... })` records only matching stages. Multiple instances with different filters coexist via auto-increment IDs.
- **`MetricRecorderOptions` type exported** from `footprintjs/recorders` — along with `AggregatedMetrics` and `StageMetrics`.
- **`metrics()` factory accepts options** — `metrics({ stageFilter })` passes through to MetricRecorder.

### Changed

- **`attachRecorder` is idempotent by ID** — same ID replaces existing recorder (prevents double-counting). Different IDs coexist. Applied to both scope recorders (`attachRecorder`) and flow recorders (`attachFlowRecorder`).
- **Recorder default IDs use auto-increment** — `MetricRecorder` defaults to `metrics-1`, `metrics-2`, etc. `DebugRecorder` defaults to `debug-1`, `debug-2`, etc. Multiple instances with different configs coexist naturally. Framework uses well-known ID `'metrics'` for override pattern.
- **`outputMapper` array concat behavior documented** — JSDoc on `SubflowMountOptions.outputMapper` warns that arrays are concatenated, not replaced. Return only the delta for array keys.

### Documentation

- **`recorder/` README** — full recorder architecture: ID contract, 12 built-in recorders table, CompositeRecorder pattern, custom recorder patterns, domain preset pattern, 6 design principles.
- **JSDoc `@example` blocks** on `attachRecorder`, `MetricRecorder`, `DebugRecorder`, `outputMapper` — code examples appear in IDE hover and API docs.

## [4.1.0]

### Added

- **Pluggable NarrativeRenderer** — `CombinedNarrativeRecorder` accepts a `renderer` option with optional hooks (`renderStage`, `renderOp`, `renderDecision`, `renderSubflow`, etc.) for custom narrative output. Unimplemented methods fall back to the default English renderer. `renderOp` can return `null` to exclude an entry.
- **Decision entries nest under decider stage** — condition entries now render at `depth: 1` (indented under their parent decider stage) instead of as separate top-level entries.
- **`outputMapper` array concat behavior documented** — JSDoc on `SubflowMountOptions.outputMapper` and CLAUDE.md anti-patterns section now warn that `applyOutputMapping` concatenates arrays (`[...existing, ...value]`). Return only the delta (new items) for array keys to avoid duplication.
- **Array proxy silent reads eliminated** — TypedScope array property access no longer emits redundant read events for internal proxy operations, reducing narrative noise.

### Tests

- **Pluggable renderer** — unit tests for custom `renderStage`, `renderOp`, `renderDecision` hooks.
- **Decider-in-subflow scenario** — verifies decision events fire with correct `traversalContext` when decider is inside a subflow.
- **Array proxy silent reads** — 11 tests verifying `.push()`, `.length`, `.filter()` etc. don't emit extra read events.
- **onCommit wiring** — 11 tests verifying scope recorder `onCommit` fires correctly per stage.

## [4.0.5]

### Fixed

- **SubflowExecutor continues after nested subflows instead of silently skipping** (`engine/handlers/SubflowExecutor.ts`) — when a chart built with `addSubFlowChartNext` was itself mounted as a subflow, `executeSubflowInternal()` returned immediately after a nested subflow completed, silently dropping all subsequent stages. Two fixes: (1) detect nested subflow nodes (`isSubflowRoot && subflowId`) and continue with `node.next` after `executeSubflow()` returns — mirrors `FlowchartTraverser.executeNode()` behavior; (2) save/restore instance variables (`currentSubflowRoot`, `currentSubflowDeps`, `subflowResultsMap`) around nested `executeSubflow()` calls to prevent parent context clobbering.

### Tests

- **Nested subflow continuation — 12 tests across 5 tiers** (`test/lib/engine/scenario/nested-subflow-continuation.test.ts`) — unit: stage after inner subflow executes, output doesn't swallow continuation; boundary: inner subflow at end of chain, empty inner subflow; scenario: multiple chained inner subflows, 3-level nesting, I/O mapping through nested, narrative captures entry/exit; property: execution order matches topology regardless of depth, snapshot available at every level; security: inner error propagates without skipping cleanup, break isolation.

## [4.0.4]

### Fixed

- **`$batchArray` JSDoc corrected: shallow clone, atomicity on error, type limitations** (`reactive/types.ts`) — the previous JSDoc said "mutable copy" which implies deep copy; corrected to "mutable **shallow copy**" with an explicit note that object references inside the array are shared. Added: if `fn` throws, `setValue` is never called and state remains unchanged. Added: `key` is untyped (`string`) and `arr` is typed as `unknown[]` — both are known limitations of `ScopeMethods` not being parameterized by `T`.
- **`$batchArray` added to CLAUDE.md escape hatches example** (`CLAUDE.md`) — was absent from the `$-prefixed escape hatches` code block in the TypedScope API section.

### Tests

- **`$batchArray` — fn throws: state unchanged, no write committed** (`test/lib/reactive/unit/batchArray.test.ts`) — new boundary test verifying atomicity on error.
- **`$batchArray` — shallow clone: object mutation inside fn affects original** (`test/lib/reactive/unit/batchArray.test.ts`) — new boundary test documenting the shallow-clone contract.
- **`$batchArray` — 10k-element performance test asserts final array length** (`test/lib/reactive/unit/batchArray.test.ts`) — tightened assertion: was only checking write count; now also asserts `length === 10_002`.

## [4.0.3]

### Added

- **`TypedScope.$batchArray(key, fn)`** (`reactive/types.ts`, `reactive/createTypedScope.ts`) — new escape hatch for batch array mutations. Every `scope.items.push(x)` in a loop clones the full array and commits it, giving O(N×M) total cost. `$batchArray` clones once, applies all mutations inside `fn` on the plain clone, then commits once — O(M) total regardless of how many mutations `fn` applies.

  ```typescript
  // Before: 1000 clones × growing array = O(N²)
  for (let i = 0; i < 1000; i++) scope.items.push(i);

  // After: 1 clone + 1 commit = O(N)
  scope.$batchArray('items', (arr) => {
    for (let i = 0; i < 1000; i++) arr.push(i);
  });
  ```

  `fn` receives a plain mutable array (not a Proxy). Mutations inside `fn` are not tracked individually — only the final committed array appears in the narrative as a single write. If the key does not exist or is not an array, `fn` receives an empty array.

## [4.0.2]

### Removed

- **`ExecutionRuntime.getFullNarrative()`** (`runner/ExecutionRuntime.ts`) — dead method that post-processed the `StageContext` tree after traversal. Zero callers. Violates the "collect during traversal, never post-process" core principle. The `walkContextTree()` private helper is also removed. The `NarrativeEntry` interface (its return type) is removed from both `footprintjs/advanced` and `runner/index.ts` exports.
- **`CombinedNarrativeBuilder.ts`** (`engine/narrative/CombinedNarrativeBuilder.ts`) — was a re-export shim pointing to `narrativeTypes.ts`. `narrative/index.ts` already exported from `narrativeTypes.ts` directly; the file was redundant.

### Changed

- **`loopTo()` spec stub now has `type: 'loop'` and `isLoopReference: true`** (`builder/FlowChartBuilder.ts`) — the back-edge reference node emitted by `loopTo()` previously had `type: 'stage'`, making it indistinguishable from real executable stages in visualization consumers. It now carries `type: 'loop'` and `isLoopReference: true`.
- **`'loop'` added to node type unions** (`builder/types.ts`, `engine/types.ts`) — `SerializedPipelineStructure.type`, `FlowChartSpec.type`, `RuntimeStructureMetadata.type`, and `SerializedPipelineNode.type` all now include `'loop'`. `computeNodeType()` returns `'loop'` for nodes where `isLoopRef === true`.
- **`pendingOps` keying comment corrected** (`engine/narrative/CombinedNarrativeRecorder.ts`) — previous comment claimed "name uniqueness prevents collision"; actual invariant is the event ordering contract (scope events for stage N are flushed before stage N+1's scope events begin).

### Fixed

- **`prefixNodeTree` unconditionally prefixes `node.id`** (`engine/traversal/FlowchartTraverser.ts`) — had a `if (clone.id)` guard that was dead code since `id` is required on `StageNode`. Removed to match the builder's invariant.
- **`branchIds` no longer uses `?? c.name` fallback** (`engine/handlers/RuntimeStructureManager.ts`) — `stageNodeToStructure()` always sets `id: node.id` (no fallback), so the `?? c.name` in `updateDynamicChildren` was dead code. Removed.
- **`stageNameToId` removed from `CombinedNarrativeRecorder`** (`engine/narrative/CombinedNarrativeRecorder.ts`) — `bufferOp` used `stageNameToId.get(stageName)` to look up a stageId, but scope events (`onRead`/`onWrite`) always fire before `onStageExecuted` (which populated the map). The lookup was always `undefined`. `bufferOp` and `flushOps` now key by `stageName` directly.
- **`isLoopReference` added to `FlowChartSpec`** (`builder/types.ts`) — was present on `SerializedPipelineStructure` but missing from `FlowChartSpec`, causing the field to be absent from the type model for FE transport consumers.
- **`getSubtreeSnapshot` dev-mode warning message corrected** (`runner/getSubtreeSnapshot.ts`) — the Strategy 2 fallback warning previously said "no ExtractorRunner is attached" as the only cause. Updated to mention both causes: missing ExtractorRunner or `enrichSnapshots` not enabled.
- **`enrichSnapshots` JSDoc expanded** (`runner/FlowChartExecutor.ts`) — was a one-liner; now accurately describes what it does, when to use it, and how it relates to the chart-level `enrichSnapshots(true)` method.
- **`isLoopRef` JSDoc cross-references `isLoopReference`** (`engine/graph/StageNode.ts`) — the runtime graph field (`isLoopRef`) and the serialization spec field (`isLoopReference`) use different names; a JSDoc comment now documents the intentional divergence.

## [4.0.1]

### Fixed

- **`prefixNodeTree` now prefixes `node.id`** (`engine/traversal/FlowchartTraverser.ts`) — subflow namespace isolation was prefixing `node.name` but not `node.id`, causing `id`-keyed stageMap lookups to miss prefixed entries. Both `name` and `id` are now prefixed, consistent with how `FlowChartBuilder` always sets them together.
- **`SerializedPipelineNode.id` is now required** (`engine/types.ts`) — was `id?: string` while the builder always sets it; aligned with `builder/types.ts` which already required it.
- **`ScopeFactory` exported from `engine/types` (4-param)** (`advanced.ts`) — was accidentally re-exporting the 3-param version from `memory/types`, missing the `executionEnv` parameter. Now exports the canonical 4-param version used by the traverser.
- **`CombinedNarrativeRecorder.pendingOps` keyed by `stageId`** (`engine/narrative/CombinedNarrativeRecorder.ts`) — was keyed by stage name, which could collide when two stages shared a display name but had different IDs. Now keyed by the stable `stageId`.
- **`RuntimeStructureManager` update methods emit dev-mode warn when node missing** (`engine/handlers/RuntimeStructureManager.ts`) — `updateDynamicChildren`, `updateDynamicSubflow`, and `updateDynamicNext` silently no-oped when called with an unregistered node ID. They now emit a `console.warn` in dev mode, matching the project's silent-skip warning rule.
- **`specToStageNode` removes `id ?? name` fallback** (`builder/FlowChartBuilder.ts`) — now that `id` is required in both type definitions, the defensive `id: s.id ?? s.name` fallback was dead code hiding potential misconfiguration. Removed.
- **`FlowChartExecutorOptions` exported from public API** (`src/index.ts`) — was accessible only as an import from the internal runner path.
- **`CombinedNarrativeBuilder.ts` converted to re-export shim** (`engine/narrative/CombinedNarrativeBuilder.ts`) — types moved to `narrativeTypes.ts`; old file is now a thin re-export for any consumers that imported from the old path.

## [4.0.0]

### Removed

- **`NarrativeRecorder` class** (`scope/recorders/NarrativeRecorder.ts`) — superseded by `CombinedNarrativeRecorder` (via `executor.recorder(narrative())`). All associated types (`NarrativeDetail`, `NarrativeOperation`, `StageNarrativeData`, `NarrativeRecorderOptions`) are also removed. Migration: replace `executor.attachRecorder(new NarrativeRecorder())` with `executor.recorder(narrative())` from `footprintjs/recorders`.
- **`typedFlowChart()` function** (`builder/typedFlowChart.ts`) — use `flowChart<T>(name, fn, id)` instead, which is identical and auto-embeds the TypedScope factory. `createTypedScopeFactory` remains available in `footprintjs/advanced` for custom executor setups.
- **`StageContext.get()` method** (`memory/StageContext.ts`) — deprecated alias for `getValue()`. Use `ctx.getValue(path, key)` directly.
- **`StageContext.getFromRoot()` method** (`memory/StageContext.ts`) — deprecated alias for `getRoot()`. Use `ctx.getRoot(key)` directly.
- **`StageContext.getFromGlobalContext()` method** (`memory/StageContext.ts`) — deprecated alias for `getGlobal()`. Use `ctx.getGlobal(key)` directly.
- **`FlowChartExecutor` positional params 3–9** (`runner/FlowChartExecutor.ts`) — the 9-positional-parameter constructor form is removed. Pass an options object instead: `new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots: true, ... })`. The 2-param form `new FlowChartExecutor(chart, scopeFactory)` is retained.
- **`ControlFlowNarrativeGenerator`** (`engine/narrative/ControlFlowNarrativeGenerator.ts`) — dead code; never instantiated at runtime (replaced by `NarrativeFlowRecorder` + `FlowRecorderDispatcher` in v0.9.x). Removed along with its test file.
- **`FlowChartExecutor.getEnrichedResults()`** — duplicate alias for `getExtractedResults()`. Use `getExtractedResults()` directly.

### Changed

- **`SerializedPipelineStructure.id` and `FlowChartSpec.id` are now required** (`builder/types.ts`) — both fields were `id?: string` but every builder-produced node always set them. Making them required closes the gap between the type and the runtime guarantee.
- **stageMap keyed by `id` not `name`** (`builder/FlowChartBuilder.ts`) — the internal stage function map previously used the human-readable stage name as the key, causing collisions when two stages had the same display name but different IDs. The map now uses the stable `id`.
- **`HandlerDeps.ScopeFactory` renamed to `scopeFactory`** (`engine/handlers/types.ts`) — the field was PascalCase while all other `HandlerDeps` fields are camelCase. Renamed for consistency.
- **`computeNodeType` returns `'subflow'` for `isSubflowRoot` nodes** (`engine/handlers/RuntimeStructureManager.ts`) — subflow entry points were previously classified as `'stage'`. The `SerializedPipelineStructure.type` union now includes `'subflow'`.
- **`CombinedNarrativeRecorder.onSelected` emits `type: 'selector'`** (`engine/narrative/CombinedNarrativeRecorder.ts`) — was incorrectly emitting `type: 'fork'`, making selective fan-out indistinguishable from full parallel fork. `CombinedNarrativeEntry.type` union now includes `'selector'`.
- **`NarrativeFlowRecorder.onStageExecuted` emits for every stage** (`engine/narrative/NarrativeFlowRecorder.ts`) — previously only emitted a sentence for the first stage and silently dropped all subsequent `onStageExecuted` calls. Now consistent with `CombinedNarrativeRecorder`.
- **`addSelectorFunction` tracks `id` in `_knownStageIds`** (`builder/FlowChartBuilder.ts`) — `loopTo()` can now target a selector stage by ID, matching the existing behavior of `addDeciderFunction`.
- **`buildNodeMap` depth guard applies at all call sites** (`engine/handlers/RuntimeStructureManager.ts`) — the `MAX_NODE_MAP_DEPTH` guard was only applied during `init()`; it now applies in `updateDynamicChildren`, `updateDynamicSubflow`, and `updateDynamicNext` as well.
- **`toMermaid()` exposed on `RunnableFlowChart`** (`runner/RunnableChart.ts`) — was only accessible on `FlowChartBuilder` (before `.build()` was called). Now callable on the built chart.

### Fixed

- **`extractScopedNarrative` no longer post-walks narrative text** (`runner/getSubtreeSnapshot.ts`) — previously scanned the full narrative array for `"entering"`/`"exiting"` string markers to reconstruct subflow scope. Now filters by `entry.subflowId` field which is set during traversal. Eliminates post-process text search.
- **`NodeResolver.findNodeById` uses pre-built O(1) map** (`engine/handlers/NodeResolver.ts`) — replaced a full DFS walk (called on every loop iteration) with a `Map<string, StageNode>` built at traversal start, reducing `loopTo` resolution from O(n×depth) to O(1).
- **`SelectorHandler.onError` now passes `traversalContext`** (`engine/handlers/SelectorHandler.ts`) — was the only `onError` call site missing the context argument, breaking recorder correlation for selector errors.
- **`FlowRecorderDispatcher` swallowed recorder errors now emit dev-mode `console.warn`** (`engine/narrative/FlowRecorderDispatcher.ts`) — silent swallow violated the project's own "silent skips must have dev-mode warning" rule.
- **`FlowRecorderDispatcher.getSentences()` no longer duck-types** (`engine/narrative/FlowRecorderDispatcher.ts`) — replaced `as unknown as Record<string, unknown>` cast with a typed `NarrativeFlowRecorder` lookup.
- **`addFunctionBranch` validates `fn` at build time** (`builder/FlowChartBuilder.ts`) — branches without a function now throw at `end()` rather than failing silently at runtime when the branch is chosen.
- **`RuntimeStructureManager` deep-clone wrapped in try/catch** (`engine/handlers/RuntimeStructureManager.ts`) — `JSON.parse(JSON.stringify(...))` threw unhandled `TypeError` for cyclic structures; now produces a clear error message.

## [3.1.0]

### Fixed
- **Concurrent FlowChartExecutor runs no longer race on shared FlowChart** (`engine/FlowchartTraverser.ts`) — `stageMap` and `subflows` were shared references from the compiled `FlowChart` object. Lazy-resolution writes (prefixed entries added during execution) mutated the shared dict, causing a race condition when two executors ran the same `FlowChart` concurrently (normal server-side behaviour). Both are now shallow-copied in the `FlowchartTraverser` constructor so per-run mutations stay scoped to the individual traverser. Additionally, the old `node.subflowResolver = undefined` write-back to the shared `StageNode` graph created a secondary race: the first concurrent traverser to resolve a lazy subflow would clear the resolver on the shared node, so a second concurrent traverser could not re-resolve it. The fix replaces the write-back with a per-traverser `resolvedLazySubflows: Set<string>` — the shared node is never mutated.
- **Empty-array write now clears field** (`memory/utils.ts`) — `updateValue(obj, key, [])` and `deepSmartMerge(dst, [])` previously produced a silent no-op (spreading `[]` onto an existing array left the field unchanged). Both now treat an empty array as a replacement ("clear"), consistent with how `{}` is handled. Practically: `scope.customer.tags = []` now clears `tags` instead of being silently ignored.
  - Code that intentionally called `updateValue(obj, key, [])` or `deepSmartMerge(existing, [])` expecting a no-op must add an explicit `if (arr.length > 0)` guard.
- **Maximum recursion depth guard in `FlowchartTraverser.executeNode`** (`engine/traversal/FlowchartTraverser.ts`) — each recursive `executeNode` call keeps the calling frame on the V8 call stack (no tail-call optimization for `async/await`). An infinite loop or an excessively deep stage chain would overflow the stack with a cryptic "Maximum call stack size exceeded" error. The traverser now maintains a `_executeDepth` counter (try/finally, correctly decremented on both normal exit and throw). When the counter exceeds `MAX_EXECUTE_DEPTH` (500), a descriptive error naming the offending stage is thrown immediately, before any work is done for that stage. `RunOptions.maxDepth` overrides the class default for unusually deep pipelines; `maxDepth < 1` throws immediately at traverser construction.
- **`decide()` / `select()` rule errors are now surfaced in evidence** (`decide/decide.ts`) — the `when` function evaluator previously used an empty `catch {}` block, silently treating any exception as a non-match. Developers whose `when` functions threw (e.g. accessing a null property, undefined method) had no visibility that the rule was broken — it simply never matched. The catch block now captures the error message in `matchError?: string` on `FunctionRuleEvidence` and `FilterRuleEvidence`. `matched` is still `false` (pipeline resilience is preserved), but the error is now observable in the evidence for debugging. Non-`Error` throws are coerced with `String(e)`.
- **`generateOpenAPI` no longer walks `buildTimeStructure`** (`contract/openapi.ts`) — the description was re-derived post-build by recursively walking `buildTimeStructure`, which (1) violated the "collect during traversal" principle, (2) had no depth guard so a pathologically deep or cyclic structure could overflow the call stack, and (3) re-derived content that was already assembled. `chart.description` is now read directly — it is built incrementally by `FlowChartBuilder` as each stage is added and is complete by the time `build()` returns. No post-processing walk is performed. Injecting a deep or cyclic `buildTimeStructure` cannot affect the description or cause a stack overflow in the OpenAPI path.
- **Depth guard in `RuntimeStructureManager.buildNodeMap`** (`engine/handlers/RuntimeStructureManager.ts`) — `buildNodeMap` recursively registered all nodes in the O(1) lookup map with no depth limit. A pathologically deep or cyclic injected `buildTimeStructure` could overflow the call stack at executor construction time. The walk now silently returns when depth exceeds `MAX_NODE_MAP_DEPTH` (500); normal builder-produced charts are well below this limit.
- **Decider description now always includes branch list** (`builder/FlowChartBuilder.ts`) — when `addDeciderFunction` was called with a `deciderDescription`, the generated `chart.description` line included only the description text and omitted the branch IDs. Branch IDs are now always appended: `"2. Route — Route the request (branches: a, b)"`. Pipelines with no `deciderDescription` are unaffected (`"Decides between: a, b"` format unchanged).
- **`SelectorFnList` now sets `type='selector'` instead of `'decider'`** (`builder/FlowChartBuilder.ts`, `engine/handlers/RuntimeStructureManager.ts`) — selector nodes in `buildTimeStructure` and runtime snapshots were previously labeled `type='decider'`, making them indistinguishable from deciders by type alone. `'selector'` has been added to the `SerializedPipelineStructure.type` and `RuntimeStructureMetadata.type` unions; `SelectorFnList.end()` now sets `type='selector'`; `computeNodeType` returns `'selector'` for `selectorFn` nodes. Selectors continue to be distinguished by `hasSelector: true`. **Migration note (advanced API consumers only):** Code that checked `node.type === 'decider'` expecting to match both deciders and selectors (relying on the old bug) will no longer match selector nodes. Switch to `hasDecider`/`hasSelector` flag checks, which have always been the canonical discriminators and are unaffected by this fix. Code that only uses `hasDecider`/`hasSelector` requires no changes.
- **`typedFlowChart` deprecated** (`builder/typedFlowChart.ts`) — `flowChart<T>(name, fn, id)` is fully equivalent and auto-embeds the TypedScope factory at build time. `typedFlowChart` is now marked `@deprecated` with a migration guide.
- **`FlowChartExecutor` 9-param constructor deprecated in favor of options object** (`runner/FlowChartExecutor.ts`) — the positional-parameter constructor (9 params) was error-prone and hard to read at call sites. A `FlowChartExecutorOptions<TScope>` interface is now exported and accepted as the second argument: `new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots: true })`. The function-based second argument (`scopeFactory`) remains fully backward-compatible. Positional params 3–9 are deprecated with JSDoc `@deprecated` and will be removed in a future major version.
- **`StageContext` duplicate method aliases deprecated** (`memory/StageContext.ts`) — three pairs of duplicate methods had identical implementations: `get()` (alias of `getValue()`), `getFromRoot()` (alias of `getRoot()`), and `getFromGlobalContext()` (alias of `getGlobal()`). The duplicates caused confusion about which name was canonical and doubled the surface area of the `advanced` package export. All three are now marked `@deprecated` and delegate to their canonical counterparts. Internal callers (`ScopeFacade`, `baseStateCompatible`) have been updated to use the canonical names. `StageContextLike` now exposes `getGlobal?` as the canonical interface method (with `getFromGlobalContext?` kept for backward compatibility).
- **ReDoS guard in `ScopeFacade._isPolicyRedacted`** (`scope/ScopeFacade.ts`) — regex redaction patterns were tested against `key` strings without a length cap. A pathological regex (e.g. `/(a+)+/`) tested against an unboundedly long key could cause catastrophic backtracking and hang the process. Pattern testing is now skipped for keys longer than 256 characters (the `_MAX_PATTERN_KEY_LEN` constant). Exact-key matching (`policy.keys` array) is unaffected and still applies for keys of any length.
- **`nativeGet` no longer reads from the prototype chain** (`memory/pathOps.ts`) — `nativeGet` used plain bracket notation (`curr[seg]`) which followed the JavaScript prototype chain. An attacker-controlled path like `'__proto__'`, `'constructor'`, or `'toString'` could read `Object.prototype`, the `Object` constructor, or other inherited methods. The fix adds two guards per path segment: (1) a DENIED-key check (matching the existing write-path guard in `nativeSet`) and (2) an `Object.prototype.hasOwnProperty.call` check to restrict access to own properties only. `nativeHas` already used `hasOwnProperty`; `nativeGet` now matches it.
- **`defineContract` no longer mutates the original FlowChart** (`contract/defineContract.ts`) — The function previously wrote `chart.inputSchema = options.inputSchema` directly on the compiled chart object. Because compiled charts are meant to be shared across executors, this caused cross-contract contamination when the same chart was wrapped by multiple `defineContract` calls. The fix creates a prototype-linked view via `Object.create(chart)`: the view owns `inputSchema`, `outputSchema`, and `outputMapper` as own properties (shadowing the prototype), while all other properties (`root`, `stageMap`, methods) are inherited zero-copy. The original chart object is never touched. `RunContext` reads `outputMapper` from the chart directly (line 97), so shadowing all three fields ensures the contract's values are used in all code paths.

## [3.0.21]

### Added
- **Curated API reference** — five hand-written MDX pages in the Starlight docs site (`api/flowchart`, `api/decide`, `api/executor`, `api/recorders`, `api/contract`), each with signatures, parameter tables, and runnable examples. Replaces the TypeDoc redirect links in the sidebar.
- **"Try with your LLM" section in README** — highlights `toMCPTool()` with a one-liner example and links to the live Claude agent demo in the playground.

### Changed
- **Docs theme** — accent colour updated from orange to purple (`#7c6cf0` dark / `#4f46e5` light) to match playground palette. Body font changed to Inter; code font to JetBrains Mono — same as playground.
- **Docs auto-deploy** — `Deploy Docs` workflow now triggers on every push to `main` that touches `docs-site/**` or `src/**`, not only on release events.
- **README** — badge updated from "TypeDoc" to "Docs"; "25+ examples" updated to "37+"; documentation table links updated to Starlight guide and API reference pages; `npx footprintjs-setup` replaced with `npx degit` one-liner (bin entry was removed in v3.0.19).

### Fixed
- **`setup.sh` degit compatibility** — `CLAUDE.md` and `AGENTS.md` were silently skipped when running via `npx degit` because the script referenced `$PKG_DIR/../` which doesn't exist in a degit-downloaded directory. A `_copy_or_fetch` helper now falls back to fetching from the GitHub raw URL when the local path is absent.

## [3.0.20]

### Fixed
- **CI publish fix** — `pathBuilder.test.ts` imported `lodash.get` which was not listed in `devDependencies`, causing `npm publish` to fail with `ERR_MODULE_NOT_FOUND`. Replaced with a 3-line inline `getByPath` helper; no behaviour change.

## [3.0.19]

### Changed
- **Zero runtime dependencies** — replaced `lodash.get`, `lodash.has`, `lodash.set`, and `lodash.mergewith` with native implementations in `src/lib/memory/pathOps.ts`. All 1893 tests pass with identical behaviour. Prototype-pollution guards (`__proto__`, `constructor`, `prototype`) are preserved in the write path. This also fixes a latent edge case in `ScopeFacade._scrubFields` where a redaction field name containing a literal dot (e.g. `"key.sub"`) was not correctly redacted when that key existed as a flat property.
- **npm tarball no longer ships `ai-instructions/`** — IDE setup snippets (Cursor, Cline, Copilot, etc.) are available in the GitHub repo but are no longer bundled with the package. The `bin.footprintjs-setup` entry has been removed accordingly. This reduces unpacked size.

## [3.0.18] - 2026-03-28

### Added
- **`SECURITY.md`** — responsible disclosure policy with supported versions, private reporting link (GitHub private advisories), response timeline, scope definition (prototype pollution, redaction bypass, schema injection), and out-of-scope clarifications. Enterprise evaluators expect this.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1. Enforcement via GitHub's private discussion and report-abuse channels.
- **GitHub Issue Templates** — structured YAML templates for bug reports (Node/TS version, module format, repro snippet, area dropdown) and feature requests (problem-first framing, area dropdown). `config.yml` disables blank issues and links to playground + private security reporting.
- **GitHub PR Template** — checklist covering build, tests, coverage, `any` annotation policy, and CHANGELOG requirement.

### Changed
- **`package.json` description** updated to front-load high-signal search terms: `"Explainable backend flows — automatic causal traces, decision evidence, and MCP tool generation for AI agents"`. Previous description buried searchable terms.
- **`package.json` homepage** updated to docs site (`https://footprintjs.github.io/footPrint/`) — npm displays this prominently on the package page.
- **`package.json` keywords** expanded from 12 to 20: added `explainability`, `xai`, `ai-agent`, `mcp`, `decision-engine`, `rule-engine`, `audit-trail`, `openapi`, `tracing`. High-traffic terms that map to common npm/Google searches for this category of tool.

## [3.0.17] - 2026-03-27

### Fixed
- **`toMCPTool()` — MCP spec compliance** (3 fixes):
  - **`name` now uses `root.id`** (explicit machine-readable id) instead of lowercasing `root.name`. `flowChart('ProcessOrder', fn, 'process-order')` now emits `name: 'process-order'` instead of `'processorder'`.
  - **`name` is sanitized** to the MCP allowlist `[A-Za-z0-9_\-.]`. Any disallowed character is replaced with `_`. Leading/trailing underscores are trimmed.
  - **`inputSchema` is always present** (required by the MCP spec). Previously it was omitted when no `.contract()` was set. Now defaults to `{ type: 'object', properties: {}, additionalProperties: false }` (the MCP-recommended form for no-parameter tools).
- **`toOpenAPI()` — path now uses slugified `root.id`** instead of slugifying `root.name`. For `flowChart('ProcessOrder', fn, 'process-order')`, the path is now `/process-order` instead of `/processorder`.
- **`toOpenAPI()` — parameterized calls are no longer incorrectly cached**. Previously, calling `chart.toOpenAPI({ title: 'A' })` then `chart.toOpenAPI({ title: 'B' })` silently returned the first call's result. Now only no-options calls are cached; calls with options always recompute.
- **`MCPToolDescription.inputSchema` type changed from `unknown` to `JsonSchema`** (source-level breaking change — see migration below). This correctly models that `inputSchema` is always a JSON Schema object. Runtime behavior is unchanged for JS users.
- **`toMCPTool()` / `toOpenAPI()` now use `normalizeSchema` from `contract/schema.ts`** instead of a local duplicate with weaker typing.

#### Migration — `MCPToolDescription.inputSchema`
If you construct a `MCPToolDescription` literal manually (rare — most users call `.toMCPTool()` which constructs it), you must now include `inputSchema`. Add `inputSchema: { type: 'object', properties: {} }` for tools with no parameters.

## [3.0.16] - 2026-03-27

### Fixed
- **`flowChart<T>()` typed overload** — calling `flowChart<LoanState>(name, fn, id)` now infers `scope: TypedScope<LoanState>` in the stage function, instead of `scope: any`. Added two overloads: single-type-param for TypedScope usage, explicit-generics for advanced/ScopeFacade usage.
- **`StageFunction` return type widened to `TOut | void`** — stage functions that return nothing (i.e., `async (scope) => { scope.x = 1 }`) no longer produce a TypeScript error. `StageRunner` uses a cast internally to maintain `TOut` through the pipeline.
- **`T extends object` replaces `T extends Record<string, unknown>`** — interfaces without index signatures (e.g. `interface OrderState { total: number }`) can now be passed to `flowChart<T>()`, `decide()`, `select()`, `TypedScope<T>`, and `createTypedScope()`. Changed across `reactive/`, `decide/`, and `builder/`.
- **`RunOptions.input` widened to `unknown`** — `run({ input })` now accepts any value (including plain class instances), not just `Record<string, unknown>`. `validateInput` signature updated accordingly.
- **`addSubFlowChartBranch`/`addSubFlowChartNext`/`addSubFlowChartBranch`/`addLazySubFlowChartBranch` accept `FlowChart<any, any>`** — subflows have independent state types; parent and child no longer need to share the same `TOut`/`TScope`.
- **`addDeciderFunction`/`addSelectorFunction` `fn` param changed to `StageFunction<any, TScope>`** — decider functions return `DecisionResult` or branch IDs, not `TOut`; this resolves the overload mismatch when using `decide()`.

## [3.0.15] - 2026-03-27

### Changed
- **`ScopeFacade` removed from main `footprintjs` export** — `ScopeFacade` was previously accessible from the main entry point, which encouraged an anti-pattern (custom `scopeFactory` overrides) that broke TypedScope auto-embedding, silently dropped `executionEnv`, and caused incompatibilities in subflow inheritance. `ScopeFacade` is now only available via `footprintjs/advanced` for internal/testing use. The correct pattern for observing reads/writes is `executor.attachRecorder(r)` — no custom `scopeFactory` needed.
- **Internal tests updated** — Two scenario test files that explicitly passed `createTypedScopeFactory<T>()` to `FlowChartExecutor` were cleaned up to use `new FlowChartExecutor(chart)` (the factory is auto-embedded by `.build()` since v3.0.3).
- **API conformance test moved** — The `ScopeFacade` conformance test moved from the "Public Exports" block to the "Removed from Main Export" block to correctly document the intent.

## [3.0.14] - 2026-03-27

### Fixed
- **`RunnableFlowChart` extends `builder.FlowChart` instead of `engine.FlowChart`** — `runner/RunnableChart.ts` was importing `FlowChart` from `engine/types.js`, whose `buildTimeStructure` is optional and wider (9-member `type` union). This made `RunnableFlowChart` unassignable to `builder.FlowChart` (which has a required, narrower `buildTimeStructure`), causing a type error when passing the result of `.build()` to `addSubFlowChartBranch` / `addSubFlowChartNext`. Fixed by importing `FlowChart` from `builder/types.js` — which already carries `buildTimeStructure` (required), `description`, `stageDescriptions`, `inputSchema`, `outputSchema`, and `outputMapper`, making the redundant field re-declarations in `RunnableFlowChart` unnecessary. `runner → builder → engine` has no circular dependency.
- **Docs: `recording.mdx` narrative output corrected** — example output comments showed the old `[Set]`/`[Read]` format (e.g. `[Set] temperature = 38.5`). Updated to match the current `CombinedNarrativeRecorder` output: `Step N: Write key = value` / `Step N: Read key = value` with quoted strings for string values.
- **Docs: `self-describing.mdx` `defineContract` section removed** — `defineContract` is deliberately not exported from the public API (enforced by conformance test — "use `.contract()`"). The section documented an unreachable import. Replaced with a corrected JSON Schema section referencing only `.contract()`.

## [3.0.13] - 2026-03-26

### Added
- **`@typescript-eslint/no-var-requires` lint rule enabled** — was explicitly disabled (`'off'`), allowing `require()` calls in TypeScript source. Now set to `'error'`. Catches any future ESM/CJS incompatibility at `git commit` time (pre-commit hook runs ESLint). The `require()` that broke `.toOpenAPI()` in ESM (fixed in v3.0.12) would have been caught at commit time with this rule active.
- **Type structural compatibility test suite** (`test/api-conformance/type-structural-compat.test.ts`) — 5 `expectTypeOf` assertions that run on every `npm test` and in the release pipeline (Gate 3):
  - `RunnableFlowChart` is assignable to `FlowChart` (the v3.0.9 regression)
  - `RunnableFlowChart.buildTimeStructure` is required, not optional
  - `SubflowExecutor.RunStageFn` equals `handlers/types.RunStageFn` (same-shape-different-name duplicate class)
  - All four handler callback types resolve (non-never) from their canonical source
  - Public `ScopeFactory` accepts a 4-param implementation with `executionEnv` (catches if export reverts to 3-param memory version)

## [3.0.12] - 2026-03-26

### Fixed
- **`toOpenAPI()` now works correctly in ESM** — `normalizeSchema()` in `RunnableChart.ts` used a `require()` call to load `zodToJsonSchema`, which throws `ReferenceError: require is not defined` in ESM environments. The error was swallowed by a try/catch, causing `.toOpenAPI()` to silently emit a spec with no request/response schemas when the user's `inputSchema`/`outputSchema` was a Zod schema. Fixed by replacing `require()` with a static `import { zodToJsonSchema } from '../contract/schema.js'`.
- **`ExecuteStageFn` in `SubflowExecutor` was a structural duplicate of `RunStageFn`** — identical four-parameter signature, different name, same directory. `SubflowExecutor` already re-exported `CallExtractorFn` from `handlers/types.ts` (added in v3.0.11) but kept its own `ExecuteStageFn`. Replaced with `RunStageFn` from `handlers/types.ts` throughout. The constructor parameter `executeStage` now correctly typed as `RunStageFn`. No runtime change — type-only.

## [3.0.11] - 2026-03-26

### Fixed
- **Eliminated 5 duplicate type definitions across the codebase** — each was a structural mismatch risk (same class of bug as v3.0.10's `TraversalExtractor`):
  - `ScopeProtectionMode`: deleted redefinition from `builder/types.ts`; now imports canonical from `scope/protection/types.ts`
  - `FlowControlType` + `FlowMessage`: deleted duplicate definitions from `engine/types.ts`; now re-exported from `memory/types.ts` (their canonical home)
  - `ExecuteNodeFn`, `CallExtractorFn`, `RunStageFn`, `GetStagePathFn`: consolidated from 3 separate handler files into a single `engine/handlers/types.ts`; `SelectorHandler` now imports from there instead of `DeciderHandler`
  - `OpenAPIOptions` in `runner/RunnableChart.ts`: renamed to `ChartOpenAPIOptions` (matching the public export alias that was already in `index.ts`) to avoid collision with `contract/types.ts`'s `OpenAPIOptions`
  - `ScopeFactory` public export: `index.ts` now exports the 4-param version from `engine/types.ts` (includes `executionEnv`) instead of the 3-param version from `memory/types.ts`. Non-breaking — 3-param implementations remain assignable.
- **Duplicate type detector added** (`scripts/check-dup-types.mjs` / `npm run check:dup-types`): scans `src/` for exported type/interface names defined in more than one file; fails the release pipeline if any new duplicates are introduced. Allowlisted entries include a documented explanation of why consolidation is not currently possible.

## [3.0.10] - 2026-03-26

### Fixed
- **`RunnableFlowChart` now assignable to `FlowChart` in `addSubFlowChartBranch`** — structural type mismatch caused by `TraversalExtractor` being defined twice with incompatible parameter types (`unknown` in `builder/types.ts` vs `StageSnapshot` in `engine/types.ts`). Fixed by removing the duplicate definition from `builder/types.ts` and re-exporting the canonical one from `engine/types.ts`. Also added `buildTimeStructure: SerializedPipelineStructure` (required) to `RunnableFlowChart`, narrowing the optional field inherited from `FlowChart`. Runtime was never affected — type-only bug.

## [3.0.9] - 2026-03-26

### Added
- **`narrative()` exported from main `'footprintjs'` package** — previously required a sub-path import (`'footprintjs/recorders'`). Now importable directly: `import { flowChart, decide, narrative } from 'footprintjs'`.

### Changed
- **README Quick Start** — restructured around the 3-step pattern (define state → build flowchart → run), and replaced `FlowChartExecutor` with `chart.recorder(narrative()).run()`. `FlowChartExecutor` remains in the public API for advanced use cases (multiple recorders, redaction policy, getSnapshot).

## [3.0.8] - 2026-03-26

### Fixed
- **`RunnableFlowChart` now includes builder metadata fields** — `description`, `stageDescriptions`, `outputSchema`, and `outputMapper` were only on the builder's internal `FlowChart` type and were lost in the `RunnableFlowChart` interface. Now explicitly declared on `RunnableFlowChart`, matching what `FlowChartBuilder.build()` actually puts on the object. Fixes TypeScript errors in any code that accesses these fields on the built chart.

## [3.0.7] - 2026-03-26

### Added
- **5-tier test coverage for subflow redaction boundary** — 7 new tests across all tiers:
  - *Property*: invariant that once a key is in `_redactedKeys`, every subsequent `setValue` without `shouldRedact` still fires redacted
  - *Scenario*: TypedScope top-level write path + cross-scope write via shared `_redactedKeys` Set (the outputMapper pattern)
  - *Security*: end-to-end `FlowChartExecutor` test asserting raw PII never appears in parent narrative after subflow→outputMapper transfer
- **Sample `17-subflow-redaction`** — demonstrates the subflow PII boundary pattern: payment subflow marks `cardNumber` redacted per-call, `outputMapper` transfers it to parent without any explicit flag, parent narrative shows `[REDACTED]` throughout

## [3.0.6] - 2026-03-26

### Fixed
- **`setValue` inherits dynamic redaction state** — if a key was previously marked redacted (via `setValue(key, val, true)` or policy), subsequent `setValue(key, newVal)` calls without an explicit `shouldRedact` flag now also fire as redacted. Previously, only the static policy was checked; the dynamic `_redactedKeys` set was ignored on writes. This closes the outputMapper edge case: when a subflow marks a key redacted and `outputMapper` writes it to the parent scope, the write event is now correctly redacted. 2 new tests added.

## [3.0.5] - 2026-03-26

### Fixed
- **`outputMapper` shallow-clones subflow state** — previously passed the live `sharedState` reference to `outputMapper`, risking aliasing bugs if the mapper mutated the object. Now passes `{ ...sharedState }` (shallow clone). Documentation added explaining that `outputMapper` receives the full subflow scope (not just declared outputs) for TypedScope subflows, and that PII key redaction across subflow boundaries is the caller's responsibility until the full ScopeFacade-level redaction layer lands.

## [3.0.4] - 2026-03-25

### Fixed
- **`outputMapper` now receives subflow scope state** — TypedScope subflow stages return `void`, so `outputMapper` previously received `undefined` as its first argument. It now falls back to the subflow's `sharedState` when the stage function returns `undefined`, making `outputMapper` usable with TypedScope subflows.
- **`05-subflow` sample** — added `outputMapper` to properly propagate payment subflow results back to the parent scope. Sample previously showed "on hold -- payment undefined" due to missing output mapping.
- **All samples** — added `executor.enableNarrative()` to 15 samples that called `getNarrative()` without enabling it; all samples now produce full narrative output.

### Added
- **Sample integration tests** — 17 vitest snapshot tests in `footprint-samples/test/integration/` covering: linear pipeline, decider, decide()/select() evidence, loan application, and subflow. Snapshots are golden files that break on any API regression. Added as gate 6a in the release script.

## [3.0.3] - 2026-03-25

### Fixed
- **Re-export `createTypedScopeFactory`** from main API — needed by playground and custom builder extensions that create `FlowChartBuilder` subclasses.

## [3.0.2] - 2026-03-25

### Added
- **7-gate release pipeline** — release script now verifies: clean tree, doc check, API conformance (47 tests), build, full suite (1874 tests), sample projects, CHANGELOG entry. No release gets out with stale docs or broken samples.

## [3.0.1] - 2026-03-25

### Fixed
- **All documentation updated to v3 API** — 19 `.md` files, 156 outdated references fixed (README, CLAUDE.md, AGENTS.md, all AI instructions, guides).
- **Pre-release doc check** — `scripts/check-docs.sh` blocks releases if any `.md` file references removed APIs. Integrated into `release.sh`.

## [3.0.0] - 2026-03-25

### Breaking
- **Removed `typedFlowChart()`** from public API — use `flowChart<T>()` instead. Auto-embeds TypedScope factory.
- **Removed `createTypedScopeFactory()`** from public API — auto-embedded by `flowChart<T>()`.
- **Removed `setEnableNarrative()`** from builder — use `.recorder(narrative())` at runtime.
- **Removed `setInputSchema()` / `setOutputSchema()` / `setOutputMapper()`** from builder — use `.contract({ input, output, mapper })`.
- **Removed `generateOpenAPI()` / `defineContract()`** from public API — use `chart.toOpenAPI()` and `.contract()` on builder.
- **`flowChart()` now auto-embeds TypedScope factory** — stage functions receive TypedScope, use typed property access (`scope.name = 'Alice'`).

### Added
- **API Conformance Tests** — 47 tests verify every v2 design decision. Run `npx vitest run test/api-conformance/` before every release.

## [2.0.0] - 2026-03-24

### Added
- **`chart.run()`** — Execute a chart directly without creating a `FlowChartExecutor`. Returns `RunResult` with `state`, `output`, `narrative`.
- **`chart.recorder(r).run()`** — d3-style chainable run configuration. Attach recorders and redaction per-run.
- **`RunContext`** — Ephemeral run configuration returned by `chart.recorder()` and `chart.redact()`. Distinct type from `FlowChart`.
- **`chart.toOpenAPI()`** — Generate OpenAPI 3.1 spec from chart metadata and contract. Cached.
- **`chart.toMCPTool()`** — Generate MCP tool description from chart metadata. Cached.
- **`.contract({ input, output, mapper })`** — Unified API replacing `setInputSchema()`, `setOutputSchema()`, `setOutputMapper()`.
- **`footprintjs/recorders`** — Recorder factory functions: `narrative()`, `metrics()`, `debug()`, `manifest()`, `adaptive()`, `milestone()`, `windowed()`.
- **Auto-embedded scopeFactory** — `typedFlowChart<T>()` embeds `createTypedScopeFactory<T>()` into the chart. `FlowChartExecutor` reads it automatically.

### Changed
- **`FlowChartExecutor` scopeFactory parameter is now optional** — reads `chart.scopeFactory` if not provided.
- **`FlowChartBuilder.build()` returns `RunnableFlowChart`** — extends `FlowChart` with `.run()`, `.recorder()`, `.redact()`, `.toOpenAPI()`, `.toMCPTool()`.
- **All samples updated** — no `createTypedScopeFactory` needed. `FlowChartExecutor(chart)` is enough.

## [1.0.1] - 2026-03-24

### Fixed
- **TypedScope proxy unwrap** — `structuredClone` in `TransactionBuffer` failed when assigning proxy-wrapped values (e.g., `scope.backup = scope.customer`). Proxy values are now auto-unwrapped via JSON round-trip before storing. Regression tests added.
- **AI coding instructions** — All AI tool instruction files (Copilot, Cursor, Kiro, Windsurf, Cline, AGENTS.md) updated to use `typedFlowChart<T>()`, `decide()`/`select()`, and typed property access. Previously referenced deprecated `ScopeFacade`/`getValue`/`setValue` API.

## [1.0.0] - 2026-03-22

### Added
- **`TypedScope<T>`** — Reactive proxy for typed property access. `scope.creditScore = 750` instead of `scope.setValue('creditScore', 750)`. Deep nested writes (`scope.customer.address.zip = '90210'`), array copy-on-write (`scope.tags.push('vip')`), and 17 `$`-prefixed escape hatches (`$getValue`, `$getArgs`, `$getEnv`, `$break`, `$debug`, `$metric`, etc.). New `reactive/` internal package.
- **`decide()` / `select()`** — Decision reasoning capture. Auto-captures WHY a decider chose a branch or a selector picked paths. Two `when` formats: function `(s) => s.creditScore > 700` (auto-captures reads via temp recorder) and Prisma-style filter `{ creditScore: { gt: 700 } }` (captures operators + thresholds). Evidence flows into narrative: "It evaluated creditScore 750 gt 700, and chose Approve." New `decide/` internal package.
- **`typedFlowChart<T>()`** — Convenience builder that infers `TypedScope<T>` for all stage functions.
- **`createTypedScopeFactory<T>()`** — Pairs with `typedFlowChart<T>()` for the executor.
- **`FilterOps<V>`** — 8 Prisma-style operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`.
- **`DecisionResult` / `SelectionResult`** — Symbol-branded results from `decide()` / `select()`. Engine detects them via `DECISION_RESULT` Symbol and extracts evidence automatically.
- **API docs** — TypeDoc auto-generated and deployed to GitHub Pages on every release.
- **Dev-mode circular reference detection** — `enableDevMode()` activates runtime detection of circular references in `setValue()` / `updateValue()`.

### Changed
- **`TypedScope<T>` is now the recommended API** — `getValue()` / `setValue()` still work via `ScopeFacade` but TypedScope eliminates the cast-hell DX problem. All samples and documentation updated.
- **Evidence-aware narrative** — `CombinedNarrativeRecorder.onDecision()` and `onSelected()` render structured evidence when available. Filter evidence shows operators and thresholds with pass/fail markers. Function evidence shows which keys were read and their values.

### Fixed
- **Spurious "Read getValue" in narrative** — `decide()` accessor helpers now check `$getValue` before `getValue` to avoid triggering TypedScope's Proxy get trap.
- **Inline `import()` types** — Converted all inline type imports in narrative types to explicit top-level imports for consistency.

## [0.18.1] - 2026-03-20

### Fixed
- **`Recorder.clear()` lifecycle** — Scope recorders are now cleared before each `run()`, preventing cross-run data accumulation. `MetricRecorder` and `DebugRecorder` implement it.
- **`Recorder.toSnapshot()` in snapshots** — Scope recorders implementing `toSnapshot()` (like `MetricRecorder`) are now included in `executor.getSnapshot().recorders` alongside FlowRecorder data.
- **Documentation sweep** — All samples, guides, and skill files updated to use `executor.attachRecorder()` instead of custom `scopeFactory` boilerplate.

## [0.18.0] - 2026-03-20

### Added
- **`executor.attachRecorder(recorder)`** — Attach scope recorders (MetricRecorder, DebugRecorder, custom) to the executor with a one-liner. No more custom `scopeFactory` boilerplate. Also adds `detachRecorder(id)` and `getRecorders()`. Works alongside narrative, FlowRecorders, and redaction.
- **`Recorder.clear()` lifecycle hook** — Optional `clear?()` on the `Recorder` interface. Called before each `executor.run()` to prevent cross-run accumulation. `MetricRecorder` and `DebugRecorder` implement it.
- **`Recorder.toSnapshot()` lifecycle hook** — Optional `toSnapshot?()` on the `Recorder` interface. Scope recorders with this method are now included in `executor.getSnapshot().recorders` alongside FlowRecorder snapshots.

## [0.17.3] - 2026-03-20

### Fixed
- **Narrative wording for parallel/selected** — `onFork` now says "Forking into N parallel paths" (future tense) instead of "N paths were executed in parallel" (past tense). `onSelected` says "selected for execution" instead of "were selected". Matches traversal order where the announcement fires before execution.

## [0.17.2] - 2026-03-20

### Fixed
- **`traversalContext` on all FlowRecorder events** — `onFork`, `onSelected`, `onDecision`, `onLoop`, `onSubflowEntry`, `onSubflowExit`, and `onError` from handlers now pass `traversalContext` from the traverser. Previously only `onStageExecuted` and `onNext` carried it. This ensures all narrative entries have `stageId` for UI sync.

## [0.17.1] - 2026-03-20

### Added
- **`stageId` on all narrative entries** — `CombinedNarrativeEntry` now carries `stageId` (from `TraversalContext.stageId`) on every entry type: stage, step, condition, fork, subflow, loop, break, error. This is the stable build-time identifier (matches spec node `id`) that enables exact UI sync between the execution tree timeline and recorder entries — no name matching needed.

## [0.17.0] - 2026-03-19

### Added
- **Per-subflow stage numbering** — `CombinedNarrativeRecorder` resets stage counters when entering a subflow, so stages inside subflows start at "Stage 1" instead of continuing the parent's count. Counters reset on re-entry too.
- **Recorder snapshots in `getSnapshot()`** — `FlowRecorder` interface gains optional `toSnapshot()` method. `FlowChartExecutor.getSnapshot()` collects data from recorders that implement it into a `recorders[]` field on `RuntimeSnapshot`. `MetricRecorder` and `ManifestFlowRecorder` implement `toSnapshot()`.
- **`RecorderSnapshot` and `RuntimeSnapshot` types** — Exported from the public API for consumers building snapshot-aware UIs.
- **All FlowEvent types exported** — `FlowStageEvent`, `FlowDecisionEvent`, `FlowBreakEvent`, `FlowNextEvent`, `FlowForkEvent`, `FlowSelectedEvent` now exported from `footprintjs` (previously only available via `footprintjs/advanced`).

### Fixed
- **`onDecision` missing `subflowId` in `flushOps`** — Buffered data ops for decider stages inside subflows were tagged with `undefined` subflowId. Now correctly passes `event.traversalContext?.subflowId`.

## [0.16.0] - 2026-03-18

### Added
- **TraversalContext on all FlowRecorder events** — Every recorder event now carries an optional `traversalContext` with `stageId`, `parentStageId`, `subflowId`, `subflowPath`, `depth`, `loopIteration`, and `forkBranch`. Created by the traverser during DFS traversal, passed as read-only data. Enables third-party recorders (Datadog, OpenTelemetry, Elastic) to build execution trees from `parentStageId` without post-processing.
- **`CombinedNarrativeEntry.subflowId`** — Narrative entries are now tagged with the subflow they belong to. Set from `event.traversalContext.subflowId` (from the traverser), not a manual stack (eliminates parallel subflow interleaving bugs).
- **`CombinedNarrativeRecorder.getEntriesBySubflow()`** — Returns entries grouped by subflowId for structured access.

### Changed
- **CombinedNarrativeRecorder** — Removed manual `subflowStack` in favor of `traversalContext.subflowId` from events. Parallel subflows now tag correctly (each branch gets its own context from the traverser).

## [0.15.2] - 2026-03-18

### Fixed
- **Subflow trace matching in drill-down** — `NodeResolver.resolveSubflowReference` now uses the inner root's `id` (`subflowDef.root.id`) instead of the mount node's `id`. Previously, the subflow execution tree's root stage got the mount ID (e.g., "auth"), which didn't match the spec node ID (e.g., "validate-token"), causing trace overlay to fail inside subflow drill-down views.

## [0.15.1] - 2026-03-18

### Fixed
- **Decider continuation stage visible in snapshot** — Decider branches now use `createChild` instead of `createNext` for the selected branch context. Previously, the branch occupied the `context.next` slot, causing the continuation stage (the node after `.end()`) to share the branch's context and become invisible in the execution snapshot. Now the branch appears as `context.children[0]` and the continuation gets its own `context.next`, producing the correct trace: Decider → [Branch] → Continuation.

## [0.15.0] - 2026-03-18

### Added
- **Lazy subflow resolution (`addLazySubFlowChartBranch`)** — Defers subflow tree cloning until first execution. Stores a factory function instead of eagerly expanding the subflow tree at build time. Enables the "graph-of-services" pattern at scale — 50+ service branches with zero build-time cost for unselected ones.
  - `addLazySubFlowChartBranch()` on `DeciderList` and `SelectorFnList`
  - `addLazySubFlowChart()` — lazy parallel child
  - `addLazySubFlowChartNext()` — lazy linear next
  - `StageNode.subflowResolver` — factory function, resolved at most once per execution
  - `SerializedPipelineStructure.isLazy` — visualization hint (dashed border + cloud icon in UI)
  - Engine Phase 0a: resolves lazy subflows before Phase 0 classify
- **10 unit tests** covering decider, selector, linear, parallel, spec flags, and resolver idempotency.

## [0.14.4] - 2026-03-17

### Added
- **Structural-only dynamic subflows (pre-executed subflow pattern)** — A stage function can now return a StageNode with `isSubflowRoot: true` + `subflowDef: { buildTimeStructure }` but no `subflowDef.root`. The engine annotates the runtime structure for visualization without invoking SubflowExecutor. Use case: HTTP request tracing where the inner flow already executed in the route handler — only its shape needs to be attached for Trace Studio drill-down.
- **`isStageNodeReturn` recognizes `isSubflowRoot`** — `isSubflowRoot === true` is now a valid continuation marker for dynamic StageNode return detection. Previously only `children`, `next`, and `nextNodeSelector` qualified.
- **46 new tests** — Full 5-type test coverage (unit, scenario, property, boundary, security) for the structural subflow feature.

### Changed
- **`subflowDef.root` is now optional** — The `StageNode.subflowDef` type allows omitting `root` for structural-only subflows. When `root` is absent, `autoRegisterSubflowDef` skips subflow registration and the traverser falls through to normal continuation.

### Fixed
- **Deep-copy of `buildTimeStructure` in `RuntimeStructureManager.updateDynamicSubflow`** — The stored `subflowStructure` is now a deep copy (via `JSON.parse(JSON.stringify())`), preventing external mutation of the annotation after execution.

## [0.14.2] - 2026-03-17

### Fixed
- **Snapshot `id` field now reflects builder stage ID** — `StageContext.getSnapshot()` was setting `id` to `runId` (empty string for sequential stages) instead of the builder's stage identifier. This broke trace overlay matching when runtime snapshots were merged across services (prefixed `name` was used as fallback). Added required `stageId` field to `StageContext`, propagated from builder `StageNode.id` through traverser and executor.

## [0.14.1] - 2026-03-16

### Fixed
- **ESM import compliance** — All internal imports now use explicit `.js` extensions for proper ESM module resolution. Added `moduleResolution: "node"` to tsconfig for compatibility.

## [0.14.0] - 2026-03-16

### Fixed
- **Subflow internal narrative events** — `SubflowExecutor` now fires `onStageExecuted`, `onNext`, and `onBreak` to the shared `CombinedNarrativeRecorder`, matching what `FlowchartTraverser` does for top-level stages. Previously, `getNarrativeEntries()` only contained "Entering/Exiting" markers for subflows with no internal stage detail — subflow drill-down views showed placeholder text instead of real narrative.

### Added
- **`icon` hint on spec types** — Optional `icon` field on `SerializedPipelineStructure` and `FlowChartSpec` for semantic visualization hints (e.g., `"llm"`, `"tool"`, `"rag"`, `"agent"`).

## [0.13.0] - 2026-03-15

### Added
- **`ComposableRunner` interface** — convention for runners that expose their internal flowChart via `toFlowChart()`. Enables mounting any runner as a subflow in a parent flowChart for UI drill-down into nested execution. Type-only export (zero runtime cost).
- **`getSubtreeSnapshot(snapshot, path, narrativeEntries?)`** — navigate the execution snapshot tree by slash-separated subflow path (e.g. `"sf-payment"` or `"sf-outer/sf-inner"`). Returns `SubtreeSnapshot` with `{ subflowId, executionTree, sharedState, narrativeEntries }`. Pass `executor.getNarrativeEntries()` as third arg to get narrative scoped to that subflow.
- **`listSubflowPaths(snapshot)`** — discover all available drill-down targets in a snapshot. Returns array of slash-separated subflow ID paths from `subflowResults`.

## [0.12.0] - 2026-03-14

### Added
- **`scope.getEnv()` — per-executor infrastructure context.** Introduces `ExecutionEnv`, a closed frozen type `{ signal?, timeoutMs?, traceId? }` that propagates through nested subflows like `process.env` for flowcharts. Pass via `executor.run({ env: { traceId, signal, timeoutMs } })`, read inside any stage with `scope.getEnv()`. Three scope access tiers: `getValue()` (tracked mutable state), `getArgs()` (frozen business input), `getEnv()` (frozen infrastructure context). Subflows inherit env automatically — no explicit mapping needed.

## [0.11.0] - 2026-03-14

### Fixed
- **`loopTo()` runtime execution** — `loopTo(stageId)` built the graph structure correctly but the engine couldn't execute the loop at runtime. The bare reference node had no `fn` and no stageMap entry, causing "must define: embedded fn OR a stageMap entry" errors. Fixed by routing `isLoopRef` nodes through `ContinuationResolver` for proper ID resolution, iteration tracking, and narrative generation. Works with linear chains, mid-chain targets, and decider→branch→loopTo patterns.
- **`loopTo()` build-time validation** — `loopTo(stageId)` now throws immediately if `stageId` is not a registered stage ID, catching name-vs-id mistakes at build time.

### Changed
- **Single canonical `StageNode` type** — Eliminated the duplicate `StageNode` definition in `builder/types.ts`. Builder now re-exports the engine's canonical `StageNode` via `import type` (zero runtime dependency). Same consolidation for `ILogger`, `StageFunction`, `StreamCallback`, `StreamHandlers`, `SubflowMountOptions`.
- **`StageNode.id` enforced at engine level** — The engine type now has `id: string` (required), matching the builder API which always required `id` since v0.10.0. Removed 16 `node.id ?? node.name` / `node.id || node.name` fallback patterns that were dead code.
- **`PipelineStageFunction` deprecated** — Use `StageFunction` instead. The old name is preserved as a type alias for backward compatibility.

## [0.10.3] - 2026-03-14

### Changed
- **README restructured** — Condensed from 590 lines / 16 sections to ~130 lines / 7 sections. Leads with the problem and loan trace, not a toy example. Fixed Quick Start to use current API (`id` required since v0.10.0). Added Live Demo badge.
- **Hero GIF** — Added animated demo GIF (`assets/hero.gif`) showing the BTS visualization with flowchart, memory inspector, and causal trace.
- **API Reference moved to docs** — Full Builder, Executor, ScopeFacade, and Contract method tables now in `docs/guides/api-reference.md`.
- **Performance benchmarks moved to docs** — Benchmark results and guidance now in `docs/guides/performance.md`.

## [0.10.2] - 2026-03-13

### Added
- **AI coding tool instructions** — Ship built-in instructions for Claude Code (`CLAUDE.md` + interactive skill), OpenAI Codex (`AGENTS.md`), GitHub Copilot, Cursor, Windsurf, Cline, and Kiro. Every file teaches the AI assistant the Builder, Executor, ScopeFacade APIs, recorder system, core principle (collect during traversal), and anti-patterns.
- **`npx footprintjs-setup`** — Interactive installer that copies the right instruction files for your AI coding tool into your project. Files ship inside the npm package under `ai-instructions/`.
- **README: AI Coding Tool Support section** — Documents all 7 supported tools with quick setup instructions.

## [0.10.0] - 2026-03-12

### Breaking Changes
- **`fn` and `id` are now required** on `.start()`, `.addFunction()`, `.addStreamingFunction()`, `.addDeciderFunction()`, `.addSelectorFunction()`, and `flowChart()` factory.
- **`addStreamingFunction` parameter order changed** — new: `(name, fn, id, streamId?, description?)` (was: `name, streamId?, fn?, id?, description?`).
- **`StageNode.id` is now required** in the type definition. All nodes must have a stable identifier for visualization matching and branch aggregation.

### Why
Optional `fn` caused silent stageMap resolution bugs. Optional `id` forced the UI to guess identifiers from `name`, breaking visualization matching. Making both required ensures every stage is explicit and identifiable.

## [0.9.2] - 2026-03-12

### Added
- **`stageReads` tracking** — `StageContext.getValue()` now records pre-namespace keys and their values at read time in `_stageReads`, exposed via `StageSnapshot.stageReads`. Enables the memory view to show a "read cursor" — which keys each stage accessed.
- **`stageWrites` tracking** — `StageContext.setObject()` / `updateObject()` record pre-namespace keys and values in `_stageWrites`, exposed via `StageSnapshot.stageWrites`. The memory view can now show actual `setValue()`/`updateValue()` data separately from diagnostic logs.

### Fixed
- **`writeTrace` no longer leaks into diagnostic logs** — `commit()` previously called `this.debug.addLog('writeTrace', commitBundle.trace)`, polluting the diagnostic layer with commit-level data that already exists in the event log. Removed.

## [0.9.1] - 2026-03-12

### Fixed
- **Subflow metadata no longer pollutes diagnostic logs** — engine internal keys (`isSubflowContainer`, `subflowResult`, `mappedInput`, `subflowName`, `hasSubflowData`, etc.) were previously written to parent stage logs via `addLog()`, leaking into the user's scope/memory. These keys are now routed exclusively through the proper `subflowResultsMap` channel.
- **`RuntimeSnapshot.subflowResults`** — new optional field on `RuntimeSnapshot` exposes subflow execution results (keyed by subflowId) via `FlowChartExecutor.getSnapshot()`. Previously only available via the separate `getSubflowResults()` method.

## [0.9.0] - 2026-03-12

### Added
- **ManifestFlowRecorder** — lightweight subflow catalog built during traversal
  - Builds a tree of subflow IDs, names, and descriptions as a side effect of execution
  - `getManifest()` returns the tree (defensive copy); `getSpec(subflowId)` returns full specs on demand
  - First-write-wins semantics for spec registration; `clear()` resets between runs
  - Suitable for LLM navigation: include manifest in snapshot, pull specs only when needed
- **Subflow event enrichment** — `FlowSubflowEvent` widened with `subflowId` and `description`
  - `onSubflowEntry` / `onSubflowExit` now carry subflow identifier and builder description
  - New `onSubflowRegistered` hook fires when dynamic subflows are attached at runtime
  - `FlowSubflowRegisteredEvent` carries subflowId, name, description, and specStructure
- **StageSnapshot enrichment** — `description` and `subflowId` fields on `StageSnapshot`
  - Builder descriptions propagate through `StageContext.getSnapshot()` into execution tree
  - Subflow entry points carry their `subflowId` for downstream consumers
- **FlowRecorder.clear()** — optional lifecycle hook for stateful recorders
  - `FlowChartExecutor.run()` calls `clear()` on all recorders before each run
  - Prevents cross-run accumulation without `instanceof` checks
- `executor.getSubflowManifest()` and `executor.getSubflowSpec(id)` convenience methods
- `ManifestFlowRecorder`, `ManifestEntry`, `FlowSubflowEvent`, `FlowSubflowRegisteredEvent` exported from `footprintjs`
- Core design principle documented: all data collection is a side effect of traversal
- 41 new tests across 5 tiers: unit (15), scenario (7), property (4), boundary (9), security (3)

### Changed
- `IControlFlowNarrative.onSubflowEntry()` / `onSubflowExit()` signatures widened (backward-compatible)
- `ControlFlowNarrativeGenerator` includes description in subflow entry sentences when available
- `NarrativeFlowRecorder` includes description in subflow entry sentences when available

## [0.8.0] - 2026-03-10

### Added
- **Structured error preservation** — errors flow through the narrative pipeline as structured objects, not flat strings
  - `extractErrorInfo(error)` — extracts `StructuredErrorInfo` from any thrown value (InputValidationError, Error, non-Error)
  - `formatErrorInfo(info)` — renders structured error to human-readable string at rendering boundaries
  - `StructuredErrorInfo` type: `{ message, name?, issues?, code?, raw }`
  - `FlowErrorEvent.structuredError` — carries full structured details to FlowRecorders
  - `NarrativeFlowRecorder` enriches error sentences with field-level validation issues
  - Hardened against adversarial inputs: throwing getters, null-prototype objects, Proxy errors
  - Deep-clones issues array for mutation safety
- `extractErrorInfo`, `formatErrorInfo`, `StructuredErrorInfo`, `FlowErrorEvent` exported from `footprintjs`
- 37 new tests across 5 tiers: unit (9), scenario (6), property-based (5), boundary (6), security (11)

### Changed
- `IControlFlowNarrative.onError()` — `error` parameter is now **required** (was optional)
- `FlowErrorEvent.structuredError` — field is now **required** (was optional)

### Fixed
- `SubflowExecutor` — added missing `narrativeGenerator.onError()` call in catch block (pre-existing omission)

## [0.7.0] - 2026-03-10

### Added
- **Schema library** (`src/lib/schema/`) — unified schema detection and validation gateway
  - `detectSchema(input)` — single function replaces 3 separate Zod detection strategies
  - `SchemaKind` type: `'zod' | 'parseable' | 'json-schema' | 'none'`
  - `validateAgainstSchema(schema, data)` — safe result-type validation for any schema kind
  - `validateOrThrow(schema, data)` — convenience wrapper that throws on failure
  - `InputValidationError` — structured error with `.issues: ValidationIssue[]` and `.cause`
  - Lightweight JSON Schema validation (required fields + type checks, no ajv dependency)
  - `extractIssuesFromZodError()` — extract structured issues from Zod or duck-typed errors
- **Runtime input validation** in `FlowChartExecutor.run()`
  - Validates `options.input` against `flowChart.inputSchema` before execution starts
  - Contract-defined `inputSchema` auto-propagates to chart via `defineContract()`
- **Readonly input protection** (`src/lib/scope/protection/readonlyInput.ts`)
  - Stage inputs are frozen to prevent accidental mutation across stages
- All schema types and functions exported from `footprintjs` public API

### Changed
- `isZodSchema()` in contract/schema.ts now delegates to `isZod()` from schema library (marked `@deprecated`)
- `isZodNode()` in scope/state/zod delegates to `detectSchema()` from schema library (marked `@deprecated`)
- Test suite migrated from `jest.fn()` to `vi.fn()` across 24+ test files (vitest compatibility)

## [0.6.0] - 2026-03-09

### Added
- **RedactionPolicy** — declarative, config-driven PII redaction
  - `RedactionPolicy` type with `keys`, `patterns`, and `fields` dimensions
  - `executor.setRedactionPolicy(policy)` — apply across all stages with one call
  - `executor.getRedactionReport()` — compliance-friendly audit trail (keys, fields, patterns — never values)
  - Exact key matching: `keys: ['ssn', 'creditCard']`
  - Pattern matching: `patterns: [/password|secret|token/i]` — auto-redacts any matching key
  - Field-level scrubbing: `fields: { patient: ['ssn', 'dob'] }` — redacts specific fields within objects
  - Dot-notation nested paths: `fields: { patient: ['address.zip'] }` — scrubs deeply nested fields
  - Global regex `lastIndex` safety — stateful patterns handled correctly
  - Policy is additive with existing manual `setValue(..., true)` approach
- `RedactionPolicy` and `RedactionReport` types exported from `footprintjs`
- **Optional `scopeFactory`** — `FlowChartExecutor` now defaults to `ScopeFacade` when no scope factory is provided
  - Before: `new FlowChartExecutor(chart, (ctx, name) => new ScopeFacade(ctx, name))`
  - After: `new FlowChartExecutor(chart)` — zero boilerplate for the common case
  - Custom factories (with recorders, typed scopes, Zod validation) still work as before

## [0.5.0] - 2026-03-09

### Added
- **PII Redaction** — `setValue(key, value, true)` now protects ALL recorders, not just EventLog
  - `_redactedKeys` tracking on ScopeFacade — scrubs values before dispatching to any recorder
  - `redacted?: boolean` field on `ReadEvent` and `WriteEvent` types for custom recorder logic
  - `useSharedRedactedKeys(set)` / `getRedactedKeys()` — share redaction state across stages
  - Cross-stage redaction auto-wired in `FlowChartExecutor` — once a key is redacted, all subsequent stages' recorders see `[REDACTED]`
  - `updateValue()` on a redacted key stays redacted; `deleteValue()` clears redaction status
- Redaction section in [scope guide](docs/guides/scope.md#redaction-pii-protection)
- PII Redaction row in README Key Features table

### Changed
- Release script now validates CHANGELOG entry exists, extracts notes, and creates GitHub releases automatically
- CHANGELOG backfilled for all historical versions (v0.2.1, v0.2.2)
- All GitHub release notes updated to match CHANGELOG format
- Branch protection enabled on `main` (requires PR with 1 approval)

## [0.4.0] - 2026-03-08

### Added
- **FlowRecorder system** — pluggable observers for control flow narrative
  - 7 built-in strategies: Windowed, Silent, Adaptive, Progressive, Milestone, RLE, Separate
  - `attachFlowRecorder(recorder)` / `detachFlowRecorder(id)` on FlowChartExecutor
  - Custom recorder support via `NarrativeFlowRecorder` base class
- Guides for scope, execution control, error handling, flow recorders, contracts
- Pre-push hook to run tests with coverage

### Fixed
- Use double cast in FlowRecorderDispatcher for TS strict mode
- Fix flaky `__proto__` property test

### Changed
- README repositioned as a code pattern, not a pipeline builder

## [0.3.0] - 2026-03-08

### Added
- **Contract layer** (`src/lib/contract/`) — standalone library for defining I/O boundaries on flowcharts
  - `defineContract(chart, options)` — create a typed contract with input/output schemas
  - `normalizeSchema(input)` — convert Zod or raw JSON Schema to normalized JSON Schema
  - `zodToJsonSchema(zodSchema)` — Zod v4-compatible converter (v3 also supported)
  - `generateOpenAPI(contract, options)` — generate OpenAPI 3.1 specs from a contract
- Builder schema methods: `setInputSchema()`, `setOutputSchema()`, `setOutputMapper()`
- `FlowChart` type now carries `inputSchema`, `outputSchema`, `outputMapper` fields
- Public exports for all contract types and functions from `footprintjs`

## [0.2.3] - 2026-03-07

### Fixed
- Flaky property-based test (`recorder-never-breaks-execution`) using JSON.stringify comparison

### Changed
- README: added quick-start snippet, comparison table, playground/samples links
- Removed `displayName` — `name` IS the display name, `id` is optional

## [0.2.2] - 2026-03-07

### Fixed
- README corrections to match actual project structure

### Changed
- Clarified documentation for return values in dynamic stages

## [0.2.1] - 2026-03-06

### Removed
- Deprecated `addDecider` method (use `addDeciderFunction` exclusively)

### Changed
- Clarified that return values are only needed for dynamic stages (deciders/selectors)

## [0.2.0] - 2026-03-06

### Added
- Causal trace narrative generation (NarrativeRecorder + ControlFlowNarrativeGenerator + CombinedNarrativeBuilder)
- Auto-generated `chart.description` for LLM tool selection
- `ScopeFacade` as the primary scope interface (replaces BaseState)
- Scope protection via Proxy (blocks direct property assignment)
- Pluggable recorder system (DebugRecorder, MetricRecorder, NarrativeRecorder)
- Zod-based scope validation (`defineScopeFromZod`)
- Enriched snapshots for single-pass debug capture
- Subflow composition (fork, linear, branch mounting)
- Loop support via `loopTo()`
- Streaming stages for LLM token emission
- Stage descriptions for build-time metadata

### Changed
- Architecture reorganized into six independent libraries (memory, builder, scope, engine, runner, contract)
- Moved `zod` to optional peer dependency

### Removed
- Legacy `BaseState`, `Pipeline`, `PipelineRuntime`, `GlobalStore`, `WriteBuffer` classes
- Old `src/core/`, `src/internal/`, `src/scope/`, `src/utils/` directories

## [0.1.0] - 2024-01-01

### Added
- Initial release with FlowChartBuilder, FlowChartExecutor, and core pipeline execution
