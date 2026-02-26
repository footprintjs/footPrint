# FootPrint

> **Turn your whiteboard flowchart into running code.**

FootPrint is a tiny, production-minded runtime for building **flowchart-like pipelines** where each node is just a function. It transforms how you think about application architecture: draw a flowchart, then build it.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Validate   │────▶│   Process   │────▶│   Notify    │
└─────────────┘     └─────────────┘     └─────────────┘
```

becomes:

```typescript
import { flowChart, FlowChartExecutor, BaseState } from 'footprint';

// Build your flowchart
const chart = flowChart('Validate', validateFn)
  .addFunction('Process', processFn)
  .addFunction('Notify', notifyFn)
  .build();

// Execute it
const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();
```

---

## Why FootPrint?

> 📖 **[Read the full story](./docs/STORY.md)** — Why FootPrint exists, who it's for, and the vision behind it.

### The Problem

Traditional code obscures control flow. Callbacks, promises, and async/await scatter your logic across files. When something breaks, you're left tracing through stack traces and console logs.

### The Solution

FootPrint makes control flow **explicit and inspectable**:

- **Visual → Code**: Your whiteboard flowchart becomes executable code
- **Execution as Artifact**: Every step is recorded, replayable, debuggable
- **Scoped State**: No more global state bugs or race conditions
- **Time-Travel Debugging**: Step backward and forward through execution
- **Self-Documenting Tools**: Stage descriptions cascade into tool definitions. LLMs see the full inner workflow. No manual description writing needed.
- **Built-in Observability**: Recorders capture per-stage data. DebugRecorder, MetricRecorder, and NarrativeRecorder ship out of the box. Debug without re-running.
- **Narrative Generation**: Runtime produces plain-English execution stories. Feed to follow-up LLM calls for context continuity.

---

## Mental Model

Think of FootPrint as a **flowchart runtime**. You define:

1. **Nodes** - Functions that do work
2. **Edges** - How nodes connect (linear, parallel, conditional)
3. **Scope** - Where data lives and flows

The runtime handles execution order, state management, and observability.

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR FLOWCHART                          │
│                                                             │
│   ┌─────┐     ┌─────┐     ┌─────┐                          │
│   │  A  │────▶│  B  │────▶│  C  │   Linear                 │
│   └─────┘     └─────┘     └─────┘                          │
│                                                             │
│   ┌─────┐     ┌─────┐                                      │
│   │  A  │──┬─▶│ B1  │──┐                                   │
│   └─────┘  │  └─────┘  │  ┌─────┐                          │
│            ├─▶│ B2  │──┼─▶│  C  │  Fork (Parallel)         │
│            │  └─────┘  │  └─────┘                          │
│            └─▶│ B3  │──┘                                   │
│               └─────┘                                      │
│                                                             │
│   ┌─────┐     ┌─────┐                                      │
│   │  A  │──?─▶│ B1  │                                      │
│   └─────┘  │  └─────┘                                      │
│            └─▶│ B2  │      Decider (One of N)              │
│               └─────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Not a DAG** | Supports loops, re-entry, and partial/resumed execution |
| **Parallel Fan-Out/In** | Fork pattern with automatic result aggregation |
| **Three-Level Scope** | Global → Path → Node memory isolation |
| **Patch-Based State** | Atomic commits, safe merges, no race conditions |
| **First-Class Observability** | Connected logs, traces, time-travel debugging |
| **Composable Subflows** | Mount entire flowcharts as nodes in larger workflows |
| **Streaming Support** | Built-in streaming stages for LLM token emission |

---

## Installation

```bash
npm install footprint
```

---

## Architecture Overview

FootPrint separates **building** from **executing**:

```
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│   FlowChartBuilder  │─────▶│      FlowChart      │─────▶│  FlowChartExecutor  │
│   (Build-time DSL)  │      │   (Compiled Tree)   │      │   (Runtime Engine)  │
└─────────────────────┘      └─────────────────────┘      └─────────────────────┘
        │                            │                            │
        │ flowChart()                │ .build()                   │ .run()
        │ .addFunction()             │                            │ .getContextTree()
        │ .addDecider()              │                            │ .getExtractedResults()
        │ .addSubFlowChart()         │                            │
        └────────────────────────────┴────────────────────────────┘
```

- **FlowChartBuilder**: Fluent DSL for defining your flowchart structure
- **FlowChart**: Compiled tree with stage functions and metadata
- **FlowChartExecutor**: Runtime engine that executes the compiled flowchart

---

## Quick Start

```typescript
import { flowChart, FlowChartExecutor, BaseState } from 'footprint';

// Scope factory creates state containers for each stage
const scopeFactory = (ctx: any, stageName: string) => new BaseState(ctx, stageName);

// Build your flowchart using the factory function
const chart = flowChart('ValidateCart', async (scope) => {
    scope.setObject(['pipeline'], 'cartTotal', 79.98);
    return { valid: true };
  })
  .addFunction('ProcessPayment', async (scope) => {
    const total = scope.getValue(['pipeline'], 'cartTotal');
    return { success: true, amount: total };
  })
  .addFunction('SendReceipt', async () => {
    return { sent: true };
  })
  .build();

// Execute with FlowChartExecutor
const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();

// Access execution data
const contextTree = executor.getContextTree();
```

### Alternative: One-liner execution

For simple cases, use the convenience `execute()` method:

```typescript
const result = await flowChart('ValidateCart', validateFn)
  .addFunction('ProcessPayment', processFn)
  .addFunction('SendReceipt', receiptFn)
  .execute(scopeFactory);
```

---

## Learning Curve

### Core Concepts (30 minutes)

1. **flowChart()** - Factory function to start building (recommended)
2. **FlowChartBuilder** - Fluent API for building pipelines
3. **FlowChartExecutor** - Runtime engine for execution
4. **Stages** - Functions that receive scope and return output
5. **Scope** - State container with `setObject()`, `getValue()`, `updateObject()`

### Patterns (1 hour)

| Pattern | Method | Use Case |
|---------|--------|----------|
| Linear | `addFunction()` | Sequential steps |
| Fork | `addListOfFunction()` | Parallel execution |
| Decider | `addDecider()` | Single-choice routing |
| Selector | `addSelector()` | Multi-choice parallel |
| Subflow | `addSubFlowChart()` | Compose flowcharts |
| Streaming | `addStreamingFunction()` | LLM token streaming |

### Advanced (2 hours)

- Composing apps with `addSubFlowChart()` and `addSubFlowChartNext()`
- Traversal extractors with `addTraversalExtractor()`
- Custom scope classes extending `BaseState`
- Zod validation for typed scope
- Time-travel debugging with `getContextTree()`

---

## ⚠️ CRITICAL: Scope Communication

> **Each stage receives its own scope instance. Direct property assignment does NOT persist.**

```typescript
// ❌ WRONG - Data is LOST
scope.myData = { result: 'hello' };

// ✅ CORRECT - Data persists
scope.setObject([], 'myData', { result: 'hello' });
const data = scope.getValue([], 'myData');
```

| Method | Purpose |
|--------|---------|
| `setObject(path, key, value)` | Write (overwrites) |
| `updateObject(path, key, value)` | Write (deep merge) |
| `getValue(path, key)` | Read |

📖 **Full details:** [docs/guides/SCOPE_COMMUNICATION.md](./docs/guides/SCOPE_COMMUNICATION.md)

---

## API Reference

### flowChart() - Factory Function (Recommended)

```typescript
import { flowChart } from 'footprint';

const chart = flowChart('entry', entryFn)
  .addFunction('process', processFn)
  .build();
```

### FlowChartBuilder - Class API

```typescript
import { FlowChartBuilder } from 'footprint';

const builder = new FlowChartBuilder()
  .start('entry', entryFn)
  .addFunction('process', processFn);

const chart = builder.build();
```

### FlowChartExecutor - Runtime Engine

```typescript
import { FlowChartExecutor } from 'footprint';

const executor = new FlowChartExecutor(
  chart,           // FlowChart from .build()
  scopeFactory,    // Creates scope instances
  defaults,        // Optional: default context values
  initial,         // Optional: initial context values
  readOnly,        // Optional: read-only context values
);

// Execute
const result = await executor.run();

// Introspection
const contextTree = executor.getContextTree();
const extractedData = executor.getExtractedResults();
const subflowResults = executor.getSubflowResults();

// Or, with enriched snapshots enabled:
const enrichedExecutor = new FlowChartExecutor(chart, scopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, true);
await enrichedExecutor.run();
const enriched = enrichedExecutor.getEnrichedResults(); // single-pass debug data
```

### Key Builder Methods

| Method | Description |
|--------|-------------|
| `start(name, fn?)` | Define root stage |
| `addFunction(name, fn?)` | Add linear next stage |
| `addListOfFunction(specs)` | Add parallel children (fork) |
| `addDecider(fn)` | Add single-choice branching |
| `addSelector(fn)` | Add multi-choice branching |
| `addSubFlowChart(id, flow)` | Mount subflow as child |
| `addSubFlowChartNext(id, flow)` | Mount subflow as next |
| `addStreamingFunction(name, streamId?, fn?)` | Add streaming stage |
| `addTraversalExtractor(fn)` | Register data extractor |
| `loopTo(stageId)` | Loop back to earlier stage |
| `build()` | Compile to FlowChart |
| `execute(scopeFactory)` | Build + run (convenience) |
| `toSpec()` | Export pure JSON (no functions) |

### Key Executor Methods

| Method | Description | When to Use |
|--------|-------------|-------------|
| `run()` | Execute the flowchart | Always — primary execution method |
| `getContextTree()` | Full context tree (legacy 2-pass) | Backward-compatible introspection |
| `getExtractedResults()` | Extractor results map | When using a traversal extractor |
| `getEnrichedResults()` | Enriched extractor results (single-pass) | **Recommended** when `enrichSnapshots: true` |
| `getSubflowResults()` | Subflow execution data | When composing subflows |
| `getExtractorErrors()` | Errors from extractor | Debugging extractor issues |

---

## Subflow Composition

Mount entire flowcharts as nodes in larger workflows:

```typescript
// Build reusable subflows
const faqFlow = flowChart('FAQ_Entry', faqEntryFn)
  .addFunction('FAQ_Answer', faqAnswerFn)
  .build();

const ragFlow = flowChart('RAG_Entry', ragEntryFn)
  .addFunction('RAG_Retrieve', ragRetrieveFn)
  .addFunction('RAG_Answer', ragAnswerFn)
  .build();

// Compose into main flow
const mainChart = flowChart('Router', routerFn)
  .addSubFlowChart('faq', faqFlow, 'FAQ Handler')
  .addSubFlowChart('rag', ragFlow, 'RAG Handler')
  .addFunction('Aggregate', aggregateFn)
  .build();
```

---

## Streaming Support

Built-in support for LLM token streaming:

```typescript
const chart = flowChart('PreparePrompt', prepareFn)
  .addStreamingFunction('AskLLM', 'llm-stream', askLLMFn)
  .onStream((streamId, token) => {
    process.stdout.write(token);
  })
  .onStreamEnd((streamId, fullText) => {
    console.log('\nComplete:', fullText);
  })
  .addFunction('ProcessResponse', processFn)
  .build();
```

---

## Traversal Extractors

Extract data from each stage for frontend consumption:

```typescript
const chart = flowChart('entry', entryFn)
  .addFunction('askLLM', askLLMFn)
  .addTraversalExtractor((snapshot) => {
    const { node, context } = snapshot;
    const scope = context.getScope();
    return {
      stageName: node.name,
      llmResponse: scope?.llmResponse,
      toolCalls: context.getDebugInfo()?.toolCalls,
    };
  })
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run();

// Get extracted data
const extracted = executor.getExtractedResults();
```

### Enriched Snapshots (Single-Pass Debug)

For debug UIs and observability tools, enable `enrichSnapshots` to capture scope state, debug metadata, stage output, and history index during traversal — eliminating the need for a separate `getContextTree()` walk.

```typescript
const chart = flowChart('entry', entryFn)
  .addFunction('process', processFn)
  .addTraversalExtractor((snapshot) => {
    // When enrichSnapshots is enabled, snapshot includes extra fields:
    const { node, stepNumber, structureMetadata, scopeState, debugInfo, stageOutput, historyIndex } = snapshot;
    return {
      stageName: node.name,
      stepNumber,
      type: structureMetadata.type,
      scopeState,      // committed scope at this point in execution
      debugInfo,       // { logs, errors, metrics, evals, flowMessages }
      stageOutput,     // the stage function's return value
      historyIndex,    // position in ExecutionHistory for replay
    };
  })
  .build();

// Enable enrichment via constructor param
const executor = new FlowChartExecutor(chart, scopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, true);
await executor.run();

// Use getEnrichedResults() — same data as getExtractedResults(), clearer intent
const enriched = executor.getEnrichedResults();
// Map { "entry" => { stageName, stepNumber, scopeState, ... }, "process" => { ... } }
```

When `enrichSnapshots` is disabled (the default), the extra fields are simply absent from the snapshot. Existing extractors work identically — zero cost when not opted in.

**When to use which:**

| Method | Use Case |
|--------|----------|
| `getContextTree()` | Legacy path, backward-compatible, walks StageContext linked list after execution |
| `getExtractedResults()` | Custom extractor without enrichment |
| `getEnrichedResults()` | Full debug data captured during traversal (recommended for debug UIs) |

---

## Stage Descriptions

Attach a human-readable `description` to any stage via the last positional parameter on builder methods (`start`, `addFunction`, `addStreamingFunction`, `addDeciderFunction`, and branch methods). The builder incrementally composes a full execution context description as stages are added — no tree walking required at read time.

```typescript
const chart = flowChart('SeedScope', seedFn, 'seed-scope', undefined, 'Initialize conversation history')
  .addFunction('AssemblePrompt', promptFn, 'assemble-prompt', undefined, 'Build LLM message array')
  .addStreamingFunction('CallLLM', 'llm-stream', llmFn, 'call-llm', undefined, 'Send messages to LLM provider')
  .addFunction('ParseResponse', parseFn, 'parse-response', undefined, 'Extract text or tool calls')
  .addDeciderFunction('RouteDecider', deciderFn, 'route-decider', undefined, 'Route based on tool calls')
    .addFunctionBranch('execute-tools', 'ExecuteTools', toolsFn, undefined, 'Run tools and loop back')
    .addFunctionBranch('finalize', 'Finalize', finalizeFn, undefined, 'Extract final response')
  .end()
  .build();

console.log(chart.description);
// Pipeline: SeedScope
// Steps:
// 1. SeedScope — Initialize conversation history
// 2. AssemblePrompt — Build LLM message array
// 3. CallLLM — Send messages to LLM provider
// 4. ParseResponse — Extract text or tool calls
// 5. RouteDecider — Route based on tool calls
//    → execute-tools: Run tools and loop back
//    → finalize: Extract final response
```

The built `FlowChart` exposes two fields:

| Field | Type | Description |
|-------|------|-------------|
| `flowChart.description` | `string` | Full numbered execution context description |
| `flowChart.stageDescriptions` | `Map<string, string>` | Individual stage descriptions keyed by stage name |

The description also covers parallel stages (`"Runs in parallel: A, B, C"`), subflows (`"[Sub-Execution: Name] — ..."`), and loop-backs (`"→ loops back to step M"`).

When a `FlowChart` is registered as a tool handler in `ToolRegistry`, the registry auto-extracts `flowChart.description` as the tool description — no manual duplication needed. An explicit description on the tool definition always takes precedence.

---

## Scope Types

FootPrint supports two approaches to typed scope:

### Direct Scope (Simple)

Extend `BaseState` with typed properties:

```typescript
class MyScope extends BaseState {
  get cartTotal(): number {
    return this.getValue(['pipeline'], 'cartTotal') ?? 0;
  }
  
  set cartTotal(value: number) {
    this.setObject(['pipeline'], 'cartTotal', value);
  }
}
```

### Zod Scope (Validated)

Use Zod schemas for runtime validation:

```typescript
import { z } from 'zod';

const PipelineSchema = z.object({
  cartTotal: z.number(),
  transactionId: z.string().optional(),
});

class ValidatedScope extends BaseState {
  setCartTotal(value: number) {
    PipelineSchema.shape.cartTotal.parse(value);
    this.setObject(['pipeline'], 'cartTotal', value);
  }
}
```

---

## Scope & Recorder System

FootPrint includes a composable observability layer built on two concepts: **Scope** (the runtime memory container) and **Recorders** (pluggable observers).

### Scope

The `Scope` class wraps GlobalStore with transactional writes, read-after-write consistency, and time-travel snapshots:

```typescript
import { Scope } from 'footprint';

// Scope is created internally by the pipeline runtime.
// Stages interact with it via getValue/setValue/commit:
scope.setValue(['config'], 'timeout', 5000);
const timeout = scope.getValue(['config'], 'timeout'); // 5000 (read-after-write)
scope.commit(); // Persists to GlobalStore + creates a snapshot
```

### Recorders

Recorders observe scope operations without modifying them. Implement any subset of 6 hooks:

```typescript
import { Recorder } from 'footprint';

const myRecorder: Recorder = {
  id: 'my-recorder',
  onWrite(event) {
    console.log(`${event.stageName} wrote ${event.key} at path ${event.path}`);
  },
  onStageEnd(event) {
    console.log(`${event.stageName} took ${event.duration}ms`);
  },
};

scope.attachRecorder(myRecorder);
```

Available hooks: `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`.

### Recorder Composition

Recorders compose freely — attach multiple recorders for different concerns:

```typescript
// Built-in recorders
import { DebugRecorder, MetricRecorder } from 'footprint';

const debug = new DebugRecorder({ verbosity: 'verbose' });
const metrics = new MetricRecorder();

scope.attachRecorder(debug);    // Captures errors, mutations, reads
scope.attachRecorder(metrics);  // Tracks operation counts and durations
```

Recorders can be scoped to specific stages:

```typescript
// Only observe the 'processData' stage
scope.attachStageRecorder('processData', new DebugRecorder({ verbosity: 'verbose' }));
```

### Building Custom Recorders

Implement the `Recorder` interface with only the hooks you need:

```typescript
import { Recorder, WriteEvent, StageEvent } from 'footprint';

class LLMRecorder implements Recorder {
  readonly id = 'llm-recorder';
  private stageStartTimes = new Map<string, number>();
  private entries: Array<{ model?: string; latencyMs: number; tokens?: number }> = [];

  onStageStart(event: StageEvent) {
    this.stageStartTimes.set(event.stageName, event.timestamp);
  }

  onWrite(event: WriteEvent) {
    // Only capture writes to a specific path
    if (event.key !== 'lastResponse') return;

    const startTime = this.stageStartTimes.get(event.stageName);
    const latencyMs = startTime ? event.timestamp - startTime : 0;
    const response = event.value as Record<string, unknown>;

    this.entries.push({
      model: response.model as string | undefined,
      latencyMs,
      tokens: (response.usage as any)?.totalTokens,
    });
  }

  getEntries() { return [...this.entries]; }
}
```

Error isolation is built in — if a recorder throws, the error is routed to `onError` hooks of other recorders, and the scope operation continues normally.

📖 **Architecture details:** [docs/architecture/SCOPE_INTEGRATION_PROPOSAL.md](./docs/architecture/SCOPE_INTEGRATION_PROPOSAL.md) and [docs/architecture/MEMORY_MODEL.md](./docs/architecture/MEMORY_MODEL.md)

---

## Examples

The `demo/` folder contains progressive examples:

| Demo | Pattern | Complexity | Key Concept |
|------|---------|------------|-------------|
| [1-payment](./demo/src/1-payment/) | Linear | ⭐ | Basic chaining |
| [2-llm-tool-loop](./demo/src/2-llm-tool-loop/) | Decider | ⭐⭐ | Conditional branching |
| [3-parallel](./demo/src/3-parallel/) | Fork | ⭐⭐ | Parallel execution |
| [4-selector](./demo/src/4-selector/) | Selector | ⭐⭐⭐ | Multi-choice parallel |
| [5-composed](./demo/src/5-composed/) | Composition | ⭐⭐⭐⭐ | Apps as building blocks |

```bash
# Run a demo
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
```

📖 **Demo guide:** [demo/README.md](./demo/README.md)

---

## Documentation

### Training (Start Here)

New to FootPrint? Build foundational understanding first:

| Module | Description |
|--------|-------------|
| [Functions](./docs/training/01-FUNCTIONS.md) | What is a function? |
| [Execution](./docs/training/02-EXECUTION.md) | Call stack and flow |
| [Memory](./docs/training/03-MEMORY.md) | Stack, heap, global |
| [Scope](./docs/training/04-SCOPE.md) | Visibility and lifetime |
| [Flowchart Execution](./docs/training/05-FLOWCHART_EXECUTION.md) | Bridge to FootPrint |

📖 **[Full Training Path](./docs/training/README.md)** (~2 hours)

### User Guides

| Document | Description |
|----------|-------------|
| [Getting Started](./docs/guides/GETTING_STARTED.md) | Installation and first pipeline |
| [Core Concepts](./docs/guides/CORE_CONCEPTS.md) | Architecture and memory model |
| [Patterns](./docs/guides/PATTERNS.md) | Fork, Decider, Selector patterns |
| [Dynamic Children](./docs/guides/DYNAMIC_CHILDREN.md) | Runtime node generation |
| [Scope Communication](./docs/guides/SCOPE_COMMUNICATION.md) | Cross-stage data sharing |

### Features

| Feature | Description |
|---------|-------------|
| [The Cascade](./docs/features/README.md) | How descriptions, observability, and narrative work together |
| [Stage Descriptions](./docs/features/stage-descriptions.md) | Self-documenting FlowCharts for LLM tool understanding |
| [Recorders](./docs/features/recorders.md) | Composable observers: DebugRecorder, MetricRecorder, NarrativeRecorder (+ LLMRecorder, CostRecorder in AgentFootPrints) |
| [Traversal Extractor](./docs/features/traversal-extractor.md) | Per-stage data capture during pipeline execution |
| [Observability](./docs/features/observability-enriched-snapshots.md) | The 3-layer observability model and enriched snapshots |
| [Narrative Generation](./docs/features/narrative-generation.md) | Plain-English execution stories for LLM context engineering |

### Technical Internals

| Document | Description |
|----------|-------------|
| [Terminology](./docs/TERMINOLOGY.md) | Comprehensive glossary |
| [Subgraph Architecture](./docs/SUBGRAPH_ARCHITECTURE.md) | Subflow design patterns |
| [Traversal Extractor](./docs/TRAVERSAL_EXTRACTOR.md) | Data extraction algorithms |
| [Scope Isolation Design](./docs/internals/SCOPE_ISOLATION_DESIGN.md) | Scope protection internals |
| [Control-Flow Model](./docs/internals/CONTROL_FLOW_MODEL.md) | Execution semantics |

---

## How FootPrint Compares

FootPrint occupies a unique space between simple async/await and full workflow orchestration:

| Aspect | async/await | FootPrint | Temporal/Step Functions |
|--------|-------------|-----------|------------------------|
| **Control Flow** | Implicit in code | Explicit flowchart | External orchestrator |
| **State** | Manual/global | Scoped & managed | Durable storage |
| **Debugging** | Stack traces | Time-travel | Event history |
| **Complexity** | Low | Medium | High |
| **Use Case** | Scripts | Applications | Distributed systems |

FootPrint gives you **explicit control flow** and **scoped state** without the operational overhead of distributed workflow systems.

---

## When to Use FootPrint

✅ **Use FootPrint when:**

- Your problem naturally fits a flowchart
- You need parallel + serial steps with explicit control
- You want scoped state without global variable bugs
- You need production observability and debugging
- You're building AI-compatible applications

❌ **Don't use FootPrint when:**

- Simple linear scripts (just use async/await)
- You need a full workflow orchestration system (use Temporal, Step Functions)
- You want an opaque agent to decide structure for you

---

## License

MIT

---

## Project Structure (For Contributors)

```
src/
├── core/                    # Public API layer
│   ├── builder/            # FlowChartBuilder DSL
│   ├── memory/             # StageContext, GlobalStore, PipelineRuntime
│   ├── executor/           # FlowChartExecutor, Pipeline
│   │   └── handlers/       # StageRunner, NodeResolver, handlers
│   ├── context/            # (deprecated re-exports → core/memory/)
│   └── pipeline/           # (deprecated re-exports → core/executor/)
├── internal/               # Library internals (not for consumers)
│   ├── memory/             # WriteBuffer, utils
│   └── history/            # ExecutionHistory
├── scope/                  # Consumer extensibility layer
│   ├── providers/          # Registry, resolve, guards
│   ├── recorders/          # DebugRecorder, MetricRecorder
│   ├── protection/         # Scope protection utilities
│   └── state/              # Zod integration
└── utils/                  # Shared utilities (logger, scopeLog)

test/
├── unit/                   # Unit tests mirroring src/ structure
├── properties/             # Property-based tests (fast-check)
└── scenarios/              # Cross-module integration tests
```

See [docs/architecture/FOLDER_REORGANIZATION_DESIGN.md](./docs/architecture/FOLDER_REORGANIZATION_DESIGN.md) for detailed architecture documentation.
