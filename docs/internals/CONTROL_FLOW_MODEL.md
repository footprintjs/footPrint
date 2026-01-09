# Control-Flow Model: Flowchart-Based Execution

This document describes the control-flow model used to define and execute workflows. The model is based on an explicit flowchart abstraction, where execution proceeds through a directed graph of nodes according to deterministic traversal rules.

The purpose of this model is to make control flow explicit, inspectable, and predictable, while supporting branching, looping, and early termination.

## Table of Contents

- [Flowchart as the Primary Control Abstraction](#flowchart-as-the-primary-control-abstraction)
- [Nodes as Execution Units](#nodes-as-execution-units)
- [Transitions and Deterministic Routing](#transitions-and-deterministic-routing)
- [Conditional Branching and Guards](#conditional-branching-and-guards)
- [Loop Constructs](#loop-constructs)
- [Structured Early Termination (BreakPipe)](#structured-early-termination-breakpipe)
- [Deterministic Traversal Guarantees](#deterministic-traversal-guarantees)
- [Technical References](#technical-references)
  - [Algorithms](#algorithms)
  - [Data Structures](#data-structures)
  - [Design Patterns](#design-patterns)
  - [External References](#external-references)

---

## Flowchart as the Primary Control Abstraction

A workflow is defined as a directed flowchart composed of execution nodes and transitions between them. The flowchart represents *how execution moves* through the system.

Each workflow has:

- A well-defined entry point
- One or more terminal exit points
- Explicit transitions between nodes

The flowchart is the authoritative description of execution order.

---

## Nodes as Execution Units

Each node represents a single execution unit.

A node:

- Encapsulates a function or computation
- Receives scoped execution context
- Produces updates to that context
- Completes atomically

Nodes do not directly invoke subsequent nodes. Control always returns to the flowchart runtime after a node completes.

---

## Transitions and Deterministic Routing

Transitions define how execution moves from one node to the next.

Transitions may be:

- **Linear** — single next node
- **Conditional** — selected based on runtime conditions
- **Parallel** — multiple branches executed independently

Routing decisions are deterministic given:

- The current node
- The committed execution context
- The transition logic defined in the flowchart

---

## Conditional Branching and Guards

Conditional transitions act as guards on control flow.

A guard:

- Evaluates execution context
- Selects the next transition
- Does not mutate state directly

Guards allow workflows to express decision points without embedding control logic inside node implementations.

---

## Loop Constructs

Loops are represented explicitly as graph cycles.

A loop:

- Is defined by a transition that returns execution to a previous node
- Uses guard logic to determine continuation or exit
- Preserves observability by remaining part of the flowchart structure

Loops are executed via traversal, not recursion, ensuring that iteration remains inspectable and replayable.

---

## Structured Early Termination (BreakPipe)

The control-flow model supports structured early termination via a `BreakPipe` mechanism.

When invoked inside a node:

1. The current node completes normally
2. Its execution context is committed
3. Further traversal is halted
4. No downstream nodes are executed

`BreakPipe` provides a safe and explicit way to exit workflows without corrupting execution state or skipping commit boundaries.

---

## Deterministic Traversal Guarantees

Execution proceeds strictly according to flowchart traversal rules.

Given the same:

- Flowchart definition
- Input context
- Guard outcomes

Execution order is **guaranteed to be deterministic**.

This determinism forms the foundation for:

- Reproducibility
- Inspection
- Replay at the execution level

---

## Summary

This control-flow model treats workflows as executable flowcharts with explicit structure, deterministic traversal, and well-defined termination semantics.

The model separates:

| Concern | Responsibility |
|---------|----------------|
| Control flow | Flowchart structure |
| Execution logic | Node behavior |

This separation enables clarity, robustness, and predictable execution behavior.

---

## Technical References

This section provides educational context for developers and students interested in the underlying computer science concepts used in this library.

### Algorithms

| Algorithm | Description | Code Reference |
|-----------|-------------|----------------|
| **Depth-First Search (DFS)** | Used for node lookup in the pipeline tree. The `findNodeById` method recursively traverses children and next nodes to locate a target node by ID. | [`Pipeline.ts:findNodeById`](../../src/core/pipeline/Pipeline.ts) |
| **State Machine Execution** | The pipeline engine implements a state machine where each node represents a state, and transitions are determined by node type (linear, fork, decider). | [`Pipeline.ts:executeNode`](../../src/core/pipeline/Pipeline.ts) |
| **Parallel Fan-Out / Fan-In** | Fork nodes execute children concurrently using `Promise.allSettled`, then aggregate results into a bundle object. | [`Pipeline.ts:executeNodeChildren`](../../src/core/pipeline/Pipeline.ts) |
| **Guard Evaluation** | Decider and Selector functions act as guards that evaluate runtime context to determine the next transition. | [`Pipeline.ts:getNextNode`](../../src/core/pipeline/Pipeline.ts) |

### Data Structures

| Structure | Description | Code Reference |
|-----------|-------------|----------------|
| **Directed Graph** | The `StageNode` type forms a directed graph where nodes have `next` (linear edge) and `children` (parallel edges). Cycles are supported via `loopTarget`. | [`Pipeline.ts:StageNode`](../../src/core/pipeline/Pipeline.ts) |
| **Scope Tree** | `StageContext` maintains a hierarchical tree of execution contexts. Each node creates child contexts that inherit from parents. | [`StageContext.ts`](../../src/core/context/StageContext.ts) |
| **Patch-Based State** | State updates are collected in a local patch during stage execution, then atomically committed via `commitPatch()`. This enables rollback on error. | [`StageContext.ts:commitPatch`](../../src/core/context/StageContext.ts) |
| **Iteration Counter Map** | A `Map<string, number>` tracks visit counts for each node ID, enabling loop iteration tracking (e.g., `askLLM.1`, `askLLM.2`). | [`Pipeline.ts:iterationCounters`](../../src/core/pipeline/Pipeline.ts) |

### Design Patterns

| Pattern | Description | Code Reference |
|---------|-------------|----------------|
| **Builder Pattern** | `FlowChartBuilder` provides a fluent API for constructing pipeline graphs. Methods like `start()`, `addFunction()`, `addDecider()` chain together to build complex flows. | [`FlowChartBuilder.ts`](../../src/builder/FlowChartBuilder.ts) |
| **Strategy Pattern** | Decider and Selector functions are interchangeable strategies for routing control flow. The engine delegates routing decisions to these pluggable functions. | [`Pipeline.ts:Decider`, `Pipeline.ts:Selector`](../../src/core/pipeline/Pipeline.ts) |
| **Command Pattern** | Each stage function encapsulates a computation as a command object. The pipeline engine invokes these commands in sequence without knowing their internals. | [`Pipeline.ts:executeStage`](../../src/core/pipeline/Pipeline.ts) |
| **Composite Pattern** | `StageNode` is a composite structure where nodes can contain children (fork) or a single next node (linear), forming a recursive tree. | [`Pipeline.ts:StageNode`](../../src/core/pipeline/Pipeline.ts) |
| **Factory Pattern** | `ScopeFactory` is a factory function that creates scope instances for each stage, injecting the appropriate context and read-only values. | [`BaseState.ts`](../../src/scope/core/BaseState.ts) |
| **Observer Pattern** | Stream handlers (`onToken`, `onStart`, `onEnd`) implement the observer pattern for streaming stages, allowing external listeners to react to token emissions. | [`FlowChartBuilder.ts:StreamHandlers`](../../src/builder/FlowChartBuilder.ts) |

### External References

- [Finite State Machine](https://en.wikipedia.org/wiki/Finite-state_machine) — Wikipedia
- [Directed Graph](https://en.wikipedia.org/wiki/Directed_graph) — Wikipedia
- [Depth-First Search](https://en.wikipedia.org/wiki/Depth-first_search) — Wikipedia
- [Builder Pattern](https://en.wikipedia.org/wiki/Builder_pattern) — Wikipedia
- [Strategy Pattern](https://en.wikipedia.org/wiki/Strategy_pattern) — Wikipedia
- [Command Pattern](https://en.wikipedia.org/wiki/Command_pattern) — Wikipedia
- [Composite Pattern](https://en.wikipedia.org/wiki/Composite_pattern) — Wikipedia

---

## Related Documentation

- [Execution Artifact](./EXECUTION_ARTIFACT.md) — Execution as a durable, inspectable artifact
- [Core Concepts](../guides/CORE_CONCEPTS.md) — Pipeline, stages, scope, and memory model
- [Patterns](../guides/PATTERNS.md) — Fork, Decider, Selector patterns
