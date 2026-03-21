# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
