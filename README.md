<p align="center">
  <h1 align="center">FootPrint</h1>
  <p align="center">A flowchart runtime for TypeScript. Draw it, then build it.</p>
</p>

<p align="center">
  <a href="https://github.com/sanjay1909/footPrint/actions"><img src="https://github.com/sanjay1909/footPrint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/footprint"><img src="https://img.shields.io/npm/v/footprint.svg?style=flat" alt="npm version"></a>
  <a href="https://github.com/sanjay1909/footPrint/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/footprint"><img src="https://img.shields.io/npm/dm/footprint.svg" alt="Downloads"></a>
</p>

<br>

```
   Validate ────> Process ────> Notify
```

```typescript
const chart = flowChart('Validate', validateFn)
  .addFunction('Process', processFn)
  .addFunction('Notify', notifyFn)
  .build();

await new FlowChartExecutor(chart, scopeFactory).run();
```

FootPrint turns flowcharts into executable TypeScript pipelines with scoped state, parallel execution, and built-in observability. Every step is recorded, replayable, and debuggable.

## Features

- **Flowchart-first** &mdash; Define pipelines as nodes and edges. Linear, parallel, conditional, loops.
- **Scoped state** &mdash; Three-level memory isolation (global, path, node). No shared mutable state.
- **Composable** &mdash; Mount entire flowcharts as subflows. Build complex apps from simple parts.
- **Observable** &mdash; Pluggable recorders capture per-stage data. Debug, metrics, and narrative out of the box.
- **AI-native** &mdash; Stage descriptions auto-cascade into tool definitions. Narrative generation produces plain-English execution stories for LLM context.
- **Streaming** &mdash; Built-in streaming stages for LLM token emission.

## Installation

```bash
npm install footprint
```

## Quick Start

```typescript
import { flowChart, FlowChartExecutor, BaseState } from 'footprint';

const scopeFactory = (ctx, stageName) => new BaseState(ctx, stageName);

const chart = flowChart('ValidateCart', async (scope) => {
    scope.setValue(['pipeline'], 'cartTotal', 79.98);
    return { valid: true };
  })
  .addFunction('ProcessPayment', async (scope) => {
    const total = scope.getValue(['pipeline'], 'cartTotal');
    return { charged: total };
  })
  .addFunction('SendReceipt', async () => ({ sent: true }))
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run();
```

For simple cases, skip the executor entirely:

```typescript
await flowChart('Validate', validateFn)
  .addFunction('Process', processFn)
  .addFunction('Notify', notifyFn)
  .execute(scopeFactory);
```

## Patterns

### Linear

```typescript
flowChart('A', fnA)
  .addFunction('B', fnB)
  .addFunction('C', fnC)
  .build();
```

### Parallel (Fork)

```typescript
flowChart('Fetch', fetchFn)
  .addListOfFunction([
    { name: 'ParseHTML', fn: parseHTML },
    { name: 'ParseCSS',  fn: parseCSS },
    { name: 'ParseJS',   fn: parseJS },
  ])
  .addFunction('Merge', mergeFn)
  .build();
```

### Conditional (Decider)

```typescript
flowChart('Classify', classifyFn)
  .addDeciderFunction('Route', async (scope) => {
    return scope.getValue(['pipeline'], 'priority') === 'high'
      ? 'express' : 'standard';
  })
    .addFunctionBranch('express', 'Express', expressFn)
    .addFunctionBranch('standard', 'Standard', standardFn)
  .end()
  .build();
```

### Subflow Composition

```typescript
const auth = flowChart('Verify', verifyFn)
  .addFunction('Authorize', authorizeFn)
  .build();

const main = flowChart('Start', startFn)
  .addSubFlowChart('auth', auth, 'Authentication')
  .addFunction('Dashboard', dashboardFn)
  .build();
```

### Streaming (LLM)

```typescript
flowChart('Prompt', promptFn)
  .addStreamingFunction('LLM', 'llm-stream', callLLM)
  .onStream((id, token) => process.stdout.write(token))
  .addFunction('Parse', parseFn)
  .build();
```

## Scope

Each stage receives its own scope instance. State is shared through explicit read/write methods &mdash; not property assignment.

```typescript
// Write
scope.setValue(['pipeline'], 'total', 99.50);

// Read
const total = scope.getValue(['pipeline'], 'total');
```

Extend `BaseState` for typed access:

```typescript
class OrderScope extends BaseState {
  get total(): number {
    return this.getValue(['pipeline'], 'total') ?? 0;
  }
  set total(value: number) {
    this.setValue(['pipeline'], 'total', value);
  }
}
```

Or use Zod schemas for runtime validation &mdash; see the [Zod Scope guide](./docs/guides/ZOD_SCOPE.md).

## Observability

FootPrint ships three built-in recorders:

```typescript
import { DebugRecorder, MetricRecorder, NarrativeRecorder } from 'footprint';

scope.attachRecorder(new DebugRecorder({ verbosity: 'verbose' }));
scope.attachRecorder(new MetricRecorder());
scope.attachRecorder(new NarrativeRecorder());
```

Build your own by implementing any subset of six hooks: `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`.

Enable **enriched snapshots** for single-pass debug data:

```typescript
const executor = new FlowChartExecutor(chart, scopeFactory, {
  enrichSnapshots: true,
});
await executor.run();

const enriched = executor.getEnrichedResults();
const narrative = executor.getNarrative();
```

## Stage Descriptions

Attach descriptions to stages. The builder composes a full execution context automatically &mdash; no tree walking needed.

```typescript
flowChart('Seed', seedFn, 'seed', undefined, 'Initialize history')
  .addFunction('Prompt', promptFn, 'prompt', undefined, 'Build messages')
  .addDeciderFunction('Route', routeFn, 'route', undefined, 'Route on tool calls')
    .addFunctionBranch('tools', 'RunTools', toolsFn, undefined, 'Execute tools')
    .addFunctionBranch('done', 'Finish', finishFn, undefined, 'Final response')
  .end()
  .build();

// chart.description:
// 1. Seed — Initialize history
// 2. Prompt — Build messages
// 3. Route — Route on tool calls
//    → tools: Execute tools
//    → done: Final response
```

When registered as a tool handler, `chart.description` is auto-extracted as the tool description.

## Examples

The [`demo/`](./demo) folder contains progressive examples:

| Demo | Pattern | Description |
|------|---------|-------------|
| [1-payment](./demo/src/1-payment/) | Linear | Basic stage chaining |
| [2-llm-tool-loop](./demo/src/2-llm-tool-loop/) | Decider | Conditional branching |
| [3-parallel](./demo/src/3-parallel/) | Fork | Parallel execution |
| [4-selector](./demo/src/4-selector/) | Selector | Multi-choice parallel |
| [5-composed](./demo/src/5-composed/) | Composition | Apps as building blocks |

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
```

## Architecture

FootPrint separates **building** from **executing**:

```
FlowChartBuilder  ──build()──>  FlowChart  ──run()──>  Results
   (DSL)                      (Compiled Tree)         (Runtime)
```

| Concept | Role |
|---------|------|
| `flowChart()` | Factory function to start building |
| `FlowChartBuilder` | Fluent DSL for defining pipeline structure |
| `FlowChart` | Compiled tree with stage functions and metadata |
| `FlowChartExecutor` | Runtime engine &mdash; executes, records, extracts |

## Documentation

**Start here:** [Getting Started](./docs/guides/GETTING_STARTED.md) &middot; [Core Concepts](./docs/guides/CORE_CONCEPTS.md) &middot; [Patterns](./docs/guides/PATTERNS.md)

**Guides:** [Scope Communication](./docs/guides/SCOPE_COMMUNICATION.md) &middot; [Dynamic Children](./docs/guides/DYNAMIC_CHILDREN.md) &middot; [Zod Scope](./docs/guides/ZOD_SCOPE.md)

**Features:** [Recorders](./docs/features/recorders.md) &middot; [Narrative Generation](./docs/features/narrative-generation.md) &middot; [Streaming](./docs/features/streaming.md) &middot; [Subflow Composition](./docs/features/subflow-composition.md) &middot; [Enriched Snapshots](./docs/features/observability-enriched-snapshots.md)

**Internals:** [Terminology](./docs/TERMINOLOGY.md) &middot; [Control-Flow Model](./docs/internals/CONTROL_FLOW_MODEL.md) &middot; [Scope Isolation](./docs/internals/SCOPE_ISOLATION_DESIGN.md) &middot; [Memory Model](./docs/architecture/MEMORY_MODEL.md)

**Training** (~2 hours): [Functions](./docs/training/01-FUNCTIONS.md) &rarr; [Execution](./docs/training/02-EXECUTION.md) &rarr; [Memory](./docs/training/03-MEMORY.md) &rarr; [Scope](./docs/training/04-SCOPE.md) &rarr; [Flowchart Execution](./docs/training/05-FLOWCHART_EXECUTION.md)

## Contributing

See the [architecture docs](./docs/architecture/FOLDER_REORGANIZATION_DESIGN.md) for project structure and design decisions.

```
src/
├── core/           # Builder DSL, Executor, Pipeline, Memory
├── internal/       # WriteBuffer, ExecutionHistory
├── scope/          # BaseState, Scope, Recorders, Zod integration
└── utils/          # Logger, scopeLog

test/
├── unit/           # Unit tests mirroring src/
├── properties/     # Property-based tests (fast-check)
└── scenarios/      # Cross-module integration tests
```

## License

[MIT](./LICENSE)
