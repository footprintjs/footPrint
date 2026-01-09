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
new FlowChartBuilder()
  .start('Validate', validateFn)
  .addFunction('Process', processFn)
  .addFunction('Notify', notifyFn)
  .execute(scopeFactory);
```

---

## Why FootPrint?

### The Problem

Traditional code obscures control flow. Callbacks, promises, and async/await scatter your logic across files. When something breaks, you're left tracing through stack traces and console logs.

### The Solution

FootPrint makes control flow **explicit and inspectable**:

- **Visual → Code**: Your whiteboard flowchart becomes executable code
- **Execution as Artifact**: Every step is recorded, replayable, debuggable
- **Scoped State**: No more global state bugs or race conditions
- **Time-Travel Debugging**: Step backward and forward through execution

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
| **Composable Apps** | Mount entire applications as nodes in larger workflows |

---

## Installation

```bash
npm install footprint
```

---

## Quick Start

```typescript
import { FlowChartBuilder, BaseState } from 'footprint';

// Scope factory creates state containers for each stage
const scopeFactory = (ctx: any, stageName: string) => new BaseState(ctx, stageName);

// Build your flowchart
const builder = new FlowChartBuilder()
  .start('ValidateCart', async (scope) => {
    scope.setObject(['pipeline'], 'cartTotal', 79.98);
    return { valid: true };
  })
  .addFunction('ProcessPayment', async (scope) => {
    const total = scope.getValue(['pipeline'], 'cartTotal');
    return { success: true, amount: total };
  })
  .addFunction('SendReceipt', async () => {
    return { sent: true };
  });

// Execute
const result = await builder.execute(scopeFactory);
```

---

## Learning Curve

### Core Concepts (30 minutes)

1. **FlowChartBuilder** - Fluent API for building pipelines
2. **Stages** - Functions that receive scope and return output
3. **Scope** - State container with `setObject()`, `getValue()`, `updateObject()`

### Patterns (1 hour)

| Pattern | Method | Use Case |
|---------|--------|----------|
| Linear | `addFunction()` | Sequential steps |
| Fork | `addListOfFunction()` | Parallel execution |
| Decider | `addDecider()` | Single-choice routing |
| Selector | `addSelector()` | Multi-choice parallel |

### Advanced (2 hours)

- Composing apps with `addSubFlowChart()`
- Custom scope classes extending `BaseState`
- Zod validation for typed scope
- Time-travel debugging

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

## Scope Types

FootPrint supports two approaches to typed scope:

### Direct Scope (Simple)

Extend `BaseState` with typed properties:

```typescript
class MyScope extends BaseState {
  // Type-safe accessors
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
| [FlowChartBuilder API](./docs/guides/FLOWCHART_BUILDER.md) | Complete API reference |
| [Scope Communication](./docs/guides/SCOPE_COMMUNICATION.md) | Cross-stage data sharing |

### Technical Internals

| Document | Description |
|----------|-------------|
| [Control-Flow Model](./docs/internals/CONTROL_FLOW_MODEL.md) | Execution semantics and algorithms |
| [Execution Artifact](./docs/internals/EXECUTION_ARTIFACT.md) | Durable execution model |

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
