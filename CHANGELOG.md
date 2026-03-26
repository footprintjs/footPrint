# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
