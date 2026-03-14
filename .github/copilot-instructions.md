# footprint.js — Copilot Instructions

This is the footprint.js library — the flowchart pattern for backend code.

## What It Does

Structures backend logic as a graph of named functions with transactional state. Every run auto-generates a causal trace of what happened and why. LLMs read the trace for grounded explanations — no hallucination.

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

## Key API

### Builder Chain

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
  .setInputSchema(schema) / .setOutputSchema(schema) / .setOutputMapper(fn)
  .build() / .toSpec() / .toMermaid()
```

### Stage Functions

```typescript
(scope: ScopeFacade, breakPipeline: () => void, streamCallback?: StreamCallback) => void | Promise<void>
```

### ScopeFacade

```typescript
scope.getValue('key')              // tracked read
scope.setValue('key', value)        // tracked write
scope.updateValue('key', partial)  // deep merge
scope.deleteValue('key')           // tracked delete
scope.getArgs<T>()                 // frozen readonly input (NOT tracked)
```

### Executor

```typescript
const executor = new FlowChartExecutor(chart);
await executor.run({ input, timeoutMs?, signal? });
executor.getNarrative()            // string[]
executor.getNarrativeEntries()     // CombinedNarrativeEntry[]
executor.getSnapshot()             // memory state
executor.attachFlowRecorder(r)     // plug observer
executor.setRedactionPolicy({ keys, patterns, fields })
```

## Observer Systems

- **Scope Recorder**: fires DURING stage (`onRead`, `onWrite`, `onCommit`)
- **FlowRecorder**: fires AFTER stage (`onStageExecuted`, `onDecision`, `onFork`, `onLoop`)
- 8 built-in FlowRecorder strategies (Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest)
- `setEnableNarrative()` auto-attaches `CombinedNarrativeRecorder` (implements both)

## Rules

- Never post-process the tree — use recorders
- `getValue()`/`setValue()` for tracked state; `getArgs()` for frozen readonly input
- Don't use deprecated `CombinedNarrativeBuilder`
- `setEnableNarrative()` is all you need for narrative setup
