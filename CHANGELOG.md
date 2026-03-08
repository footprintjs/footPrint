# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.2.0] - 2026-03-06

### Removed
- Deprecated `addDecider` method (use `addDeciderFunction` exclusively)

### Changed
- Clarified that return values are only needed for dynamic stages (deciders/selectors)

## [Unreleased - v0.1.x]

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
- Architecture reorganized into five independent libraries (memory, builder, scope, engine, runner)
- Moved `zod` to optional peer dependency

### Removed
- Legacy `BaseState`, `Pipeline`, `PipelineRuntime`, `GlobalStore`, `WriteBuffer` classes
- Old `src/core/`, `src/internal/`, `src/scope/`, `src/utils/` directories
- Outdated documentation (replaced by comprehensive README)

## [0.1.0] - 2024-01-01

### Added
- Initial release with FlowChartBuilder, FlowChartExecutor, and core pipeline execution
