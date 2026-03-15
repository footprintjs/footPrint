# footprint.js — AI Coding Instructions

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection (narrative, metrics, manifest, identity) happens as side effects of the single DFS traversal pass. Never walk the tree again after execution.

## Architecture — Library of Libraries

```
src/lib/
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer, EventLog)
├── schema/    → Validation abstraction (Zod optional, duck-typed detection)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart(), DeciderList, SelectorFnList)
├── scope/     → Per-stage facades + recorders + providers (largest module)
├── engine/    → DFS traversal + narrative + 13 handlers
├── runner/    → High-level executor (FlowChartExecutor)
└── contract/  → I/O schema + OpenAPI generation
```

Dependency DAG: `memory ← scope ← engine ← runner`, `schema ← engine`, `builder (standalone) → engine`, `contract ← schema`

Two entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/advanced'` — internals

## Key API

### Builder

```typescript
import { flowChart, FlowChartBuilder } from 'footprintjs';

// flowChart(name, fn, id, buildTimeExtractor?, description?)
const chart = flowChart('Stage1', fn1, 'stage-1', undefined, 'Description')
  .addFunction('Stage2', fn2, 'stage-2', 'Description')
  .addDeciderFunction('Decide', deciderFn, 'decide', 'Route based on risk')
    .addFunctionBranch('high', 'Reject', rejectFn)
    .addFunctionBranch('low', 'Approve', approveFn)
    .setDefault('high')
    .end()
  .setEnableNarrative()
  .build();
```

Methods: `start()`, `addFunction()`, `addStreamingFunction()`, `addDeciderFunction()`, `addSelectorFunction()`, `addListOfFunction()`, `addSubFlowChart()`, `addSubFlowChartNext()`, `loopTo()`, `setEnableNarrative()`, `setInputSchema()`, `setOutputSchema()`, `setOutputMapper()`, `build()`, `toSpec()`, `toMermaid()`

### Stage Functions

```typescript
type PipelineStageFunction = (
  scope: ScopeFacade,
  breakPipeline: () => void,
  streamCallback?: StreamCallback,
) => Promise<void> | void;
```

### ScopeFacade

```typescript
scope.getValue('key')              // tracked read (appears in narrative)
scope.setValue('key', value)        // tracked write
scope.updateValue('key', partial)  // deep merge
scope.deleteValue('key')           // tracked delete
scope.getArgs<T>()                 // frozen readonly input (NOT tracked)
scope.getEnv()                     // frozen execution environment (NOT tracked)
scope.attachRecorder(recorder)     // plug observer
```

**Three access tiers:**
- `getValue`/`setValue` — mutable shared state, tracked in narrative
- `getArgs()` — frozen business input from `run({ input })`, NOT tracked
- `getEnv()` — frozen infrastructure context from `run({ env })`, NOT tracked. Returns `ExecutionEnv { signal?, timeoutMs?, traceId? }`. Auto-inherited by subflows. Closed type — not extensible.

### Executor

```typescript
const executor = new FlowChartExecutor(chart);
await executor.run({
  input: data,
  timeoutMs: 5000,
  signal: abortSignal,
  env: { traceId: 'req-123', signal: abortSignal, timeoutMs: 5000 },
});

executor.getNarrative()         // combined flow + data narrative
executor.getNarrativeEntries()  // structured entries with type/depth/stageName
executor.getFlowNarrative()     // flow-only (no data ops)
executor.getSnapshot()          // full memory state
executor.attachFlowRecorder(r)  // plug flow observer
executor.setRedactionPolicy({}) // PII protection
```

### ComposableRunner & Snapshot Navigation

```typescript
import type { ComposableRunner } from 'footprintjs';
import { getSubtreeSnapshot } from 'footprintjs';

// Interface for runners that expose their internal flowChart
interface ComposableRunner<TIn, TOut> {
  toFlowChart(): FlowChart;
  run(input: TIn, options?: RunOptions): Promise<TOut>;
}

// Drill into subflow subtrees by path
const subtree = getSubtreeSnapshot(snapshot, 'sf-payment');
const nested = getSubtreeSnapshot(snapshot, 'sf-outer/sf-inner');
// Returns { subflowId, executionTree, sharedState, narrativeEntries } or undefined

// Pass narrative entries for scoped narrative
const subtreeWithNarrative = getSubtreeSnapshot(snapshot, 'sf-payment', executor.getNarrativeEntries());

// Discover available drill-down targets
import { listSubflowPaths } from 'footprintjs';
listSubflowPaths(snapshot); // ['sf-payment', 'sf-outer/sf-inner']
```

## Two Observer Systems

Both use `{ id, hooks } → dispatcher → error isolation → attach/detach`. Intentionally NOT unified.

**Scope Recorder** (data ops — fires DURING stage execution):
- `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`
- Built-in: `NarrativeRecorder`, `MetricRecorder`, `DebugRecorder`

**FlowRecorder** (control flow — fires AFTER stage execution):
- `onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onSelected`, `onSubflowEntry/Exit`, `onLoop`, `onBreak`, `onError`
- Built-in: 8 strategies (Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest, Silent)

**CombinedNarrativeRecorder** implements BOTH interfaces. Auto-attached by `setEnableNarrative()`.

## Event Ordering

```
1. Recorder.onStageStart        — stage begins
2. Recorder.onRead/onWrite      — DURING execution (buffered per-stage)
3. Recorder.onCommit            — transaction flush
4. Recorder.onStageEnd          — stage completes
5. FlowRecorder.onStageExecuted — CombinedNarrativeRecorder flushes buffered ops
6. FlowRecorder.onNext/onDecision/onFork — control flow continues
```

## Anti-Patterns

- Never post-process the tree — use recorders
- Never use deprecated `CombinedNarrativeBuilder` — use `CombinedNarrativeRecorder`
- Don't extract shared base for Recorder/FlowRecorder — two instances = coincidence
- Don't use `getArgs()` for tracked data — use `getValue()`/`setValue()`
- Don't put infrastructure data (signal, traceId) in `getArgs()` — use `getEnv()` via `run({ env })`
- Don't manually create `CombinedNarrativeRecorder` — `setEnableNarrative()` handles it

## Build & Test

```bash
npm run build    # tsc (CJS) + tsc -p tsconfig.esm.json (ESM)
npm test         # full suite
npm run test:unit
```

Dual output: CommonJS (`dist/`) + ESM (`dist/esm/`) + types (`dist/types/`)
