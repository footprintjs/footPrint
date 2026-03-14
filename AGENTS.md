# footprint.js — AI Agent Instructions

> The flowchart pattern for backend code — self-explainable systems that AI can reason about.

## What This Library Does

footprint.js structures backend logic as a graph of named functions with transactional state. Every run auto-generates a causal trace showing what happened and why. An LLM reads the trace and explains decisions accurately — no hallucination.

## Core Principle

**Collect during traversal, never post-process.** All data collection (narrative, metrics, manifest) happens as side effects of the single DFS traversal pass. Never walk the tree again after execution.

## Architecture

```
src/lib/
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer)
├── schema/    → Validation (Zod optional, duck-typed detection)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart())
├── scope/     → Per-stage facades + recorders + providers
├── engine/    → DFS traversal + narrative + handlers
├── runner/    → High-level executor (FlowChartExecutor)
└── contract/  → I/O schema + OpenAPI generation
```

Two entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/advanced'` — internals

## Quick Start

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart('ReceiveOrder', (scope) => {
    scope.setValue('orderId', 'ORD-123');
    scope.setValue('amount', 49.99);
  }, 'receive-order', undefined, 'Receive the incoming order')
  .addFunction('ProcessPayment', (scope) => {
    const amount = scope.getValue('amount');
    scope.setValue('paymentStatus', amount < 100 ? 'approved' : 'review');
  }, 'process-payment', 'Charge customer')
  .setEnableNarrative()
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run({ input: { orderId: 'ORD-123' } });
console.log(executor.getNarrative());
```

## Builder API

```typescript
flowChart(name, fn, id, extractor?, description?)  // start chain
  .addFunction(name, fn, id, description?)          // linear stage
  .addDeciderFunction(name, fn, id, description?)   // single-choice branch
    .addFunctionBranch(branchId, name, fn)           //   branch option
    .addSubFlowChartBranch(branchId, subflow)        //   subflow branch
    .setDefault(branchId)                             //   fallback
    .end()                                            //   close decider
  .addSelectorFunction(name, fn, id, description?)  // multi-choice fan-out
  .addListOfFunction([...], { failFast? })           // parallel fork
  .addSubFlowChartNext(id, subflow, mount, opts?)   // mount subflow inline
  .loopTo(stageId)                                   // back-edge loop
  .setEnableNarrative()                              // enable narrative
  .setInputSchema(schema)                            // Zod or JSON Schema
  .build()                                           // compile
  .toSpec()                                          // JSON structure
  .toMermaid()                                       // diagram
```

## Stage Function Signature

```typescript
(scope: ScopeFacade, breakPipeline: () => void, streamCallback?: StreamCallback) => void | Promise<void>
```

## ScopeFacade (per-stage state access)

```typescript
scope.getValue('key')              // tracked read → appears in narrative
scope.setValue('key', value)        // tracked write → appears in narrative
scope.updateValue('key', partial)  // deep merge (tracked)
scope.deleteValue('key')           // tracked delete
scope.getArgs<T>()                 // frozen readonly input (NOT tracked)
```

## Executor

```typescript
const executor = new FlowChartExecutor(chart);
await executor.run({ input, timeoutMs?, signal? });

executor.getNarrative()         // string[] — combined flow + data
executor.getNarrativeEntries()  // CombinedNarrativeEntry[] — structured
executor.getSnapshot()          // full memory state
executor.attachFlowRecorder(r)  // plug observer before run()
executor.setRedactionPolicy({   // PII protection
  keys: ['ssn'], patterns: [/password/i]
})
```

## Two Observer Systems

**Scope Recorder** — fires DURING stage: `onRead`, `onWrite`, `onCommit`, `onStageStart/End`
**FlowRecorder** — fires AFTER stage: `onStageExecuted`, `onDecision`, `onFork`, `onNext`, `onLoop`, `onError`

8 built-in FlowRecorder strategies: Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest, Silent.

`CombinedNarrativeRecorder` implements BOTH — auto-attached by `setEnableNarrative()`.

## Anti-Patterns

- Never post-process the tree — use recorders
- Never use deprecated `CombinedNarrativeBuilder`
- Don't use `getArgs()` for tracked data — use `getValue()`/`setValue()`
- Don't manually create `CombinedNarrativeRecorder` — `setEnableNarrative()` handles it

## Build

```bash
npm install footprintjs
npm run build    # CJS + ESM dual output
npm test
```
