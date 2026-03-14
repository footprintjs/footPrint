# footprint.js — Cursor Rules

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection happens as side effects of the single DFS traversal. Never walk the tree after execution.

## Architecture

```
src/lib/
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer)
├── schema/    → Validation (Zod optional, duck-typed)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart())
├── scope/     → Per-stage facades + recorders + providers
├── engine/    → DFS traversal + narrative + handlers
├── runner/    → FlowChartExecutor
└── contract/  → I/O schema + OpenAPI
```

Entry points: `footprintjs` (public) and `footprintjs/advanced` (internals).

## Builder API

```typescript
flowChart(name, fn, id, extractor?, description?)
  .addFunction(name, fn, id, description?)
  .addDeciderFunction(name, fn, id, description?)
    .addFunctionBranch(branchId, name, fn) / .setDefault(id) / .end()
  .addSelectorFunction(name, fn, id, description?)
  .addListOfFunction([...], { failFast? })
  .addSubFlowChartNext(id, subflow, mount, { inputMapper?, outputMapper? })
  .loopTo(stageId)
  .setEnableNarrative()
  .build() / .toSpec() / .toMermaid()
```

## Stage Function Signature

```typescript
(scope: ScopeFacade, breakPipeline: () => void, streamCallback?: StreamCallback) => void | Promise<void>
```

## ScopeFacade

```typescript
scope.getValue('key')              // tracked read → narrative
scope.setValue('key', value)        // tracked write → narrative
scope.updateValue('key', partial)  // deep merge (tracked)
scope.deleteValue('key')           // tracked delete
scope.getArgs<T>()                 // frozen readonly input (NOT tracked)
```

## Executor

```typescript
const executor = new FlowChartExecutor(chart);
await executor.run({ input, timeoutMs?, signal? });
executor.getNarrative()            // combined flow + data
executor.getNarrativeEntries()     // structured entries
executor.getSnapshot()             // memory state
executor.attachFlowRecorder(r)     // plug flow observer
executor.setRedactionPolicy({ keys, patterns, fields })
```

## Two Observer Systems (intentionally separate)

- **Scope Recorder**: `onRead`, `onWrite`, `onCommit`, `onStageStart/End` — fires DURING execution
- **FlowRecorder**: `onStageExecuted`, `onDecision`, `onFork`, `onNext`, `onLoop` — fires AFTER stage
- 8 strategies: Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest
- `CombinedNarrativeRecorder` implements both — auto-attached by `setEnableNarrative()`

## Rules

- Never post-process the tree — use recorders
- `getValue()`/`setValue()` for tracked state; `getArgs()` for frozen readonly input
- Don't use deprecated `CombinedNarrativeBuilder` — use `CombinedNarrativeRecorder`
- Don't extract shared base for Recorder/FlowRecorder — coincidence, not pattern
- `setEnableNarrative()` is all you need
