# Execution as an Artifact

This document describes the execution model produced by the flowchart runtime. Rather than treating execution as a transient process, execution is modeled as a durable artifact that can be inspected, replayed, and reasoned about after completion.

## Table of Contents

- [Execution Versus Results](#execution-versus-results)
- [Traversal-Defined Execution Order](#traversal-defined-execution-order)
- [Commit-Based State Progression](#commit-based-state-progression)
- [Context Tree as an Execution Artifact](#context-tree-as-an-execution-artifact)
- [Deterministic Replay and Time Travel](#deterministic-replay-and-time-travel)
- [Why This Is Not Logging](#why-this-is-not-logging)
- [Practical Implications](#practical-implications)
- [Technical References](#technical-references)
  - [Algorithms](#algorithms)
  - [Data Structures](#data-structures)
  - [Design Patterns](#design-patterns)
  - [External References](#external-references)

---

## Execution Versus Results

In many systems, execution exists only to produce a final result. Once execution finishes, intermediate steps are lost.

In this model, execution itself is a first-class output. The system produces not only results, but a structured representation of *how* those results were obtained.

| Traditional Model | FootPrint Model |
|-------------------|-----------------|
| Execution is transient | Execution is durable |
| Only final result persists | All intermediate states persist |
| Steps are lost after completion | Steps form an inspectable artifact |

---

## Traversal-Defined Execution Order

Execution proceeds through traversal of the workflow flowchart. Each traversal step corresponds to:

1. **Entering a node** — The runtime selects the next node to execute
2. **Executing node logic** — The stage function runs with scoped context
3. **Completing the node** — State is committed and control returns to runtime

Traversal order *is* execution order. This establishes a clear, linear notion of progression even in the presence of branching and loops.

---

## Commit-Based State Progression

Execution context is committed at the end of each node execution.

Key properties:

- **Commits occur only at node boundaries** — No mid-execution state is visible
- **Each commit produces a stable snapshot** — State is immutable once committed
- **No partial or in-flight state is persisted** — Atomicity is guaranteed

This ensures that every execution step has a well-defined before-and-after state.

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Node A  │───▶│ Commit  │───▶│ Node B  │───▶ ...
│ Execute │    │ State   │    │ Execute │
└─────────┘    └─────────┘    └─────────┘
```

---

## Context Tree as an Execution Artifact

Each committed execution step is linked to its predecessor according to traversal order. The result is a context tree that:

- **Mirrors the execution path** — Tree structure reflects actual traversal
- **Preserves branching and looping structure** — Parallel branches and iterations are captured
- **Encodes causal relationships between steps** — Parent-child relationships show data flow

This tree is not manually logged. It is derived directly from execution traversal.

```
                    ┌─────────────┐
                    │    Root     │
                    │   Context   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌─────────┐  ┌─────────┐  ┌─────────┐
        │ Stage A │  │ Stage B │  │ Stage C │
        │ Context │  │ Context │  │ Context │
        └─────────┘  └────┬────┘  └─────────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              ┌─────────┐ ┌─────────┐
              │ Child 1 │ │ Child 2 │
              └─────────┘ └─────────┘
```

---

## Deterministic Replay and Time Travel

Because execution steps are:

- **Discrete** — Each step is a complete unit
- **Ordered** — Traversal defines sequence
- **Committed** — State is immutable after commit

The execution artifact enables deterministic replay.

The system can:

| Capability | Description |
|------------|-------------|
| **Reconstruct execution** | Step through the artifact to see exactly what happened |
| **Inspect intermediate states** | View context at any point in execution |
| **Resume from prior step** | Continue execution from a historical state |
| **Explore alternative paths** | Branch from historical states to test different outcomes |

This capability enables **time-travel debugging**.

---

## Why This Is Not Logging

| Traditional Logging | Execution Artifact |
|---------------------|-------------------|
| Optional | Mandatory |
| Unstructured text | Structured tree |
| Does not preserve execution semantics | Encodes control flow and state transitions |
| Commentary about execution | Represents execution itself |

The execution artifact is not a log of what happened — it *is* what happened, in a form that can be inspected and replayed.

---

## Practical Implications

Treating execution as an artifact enables:

| Use Case | Benefit |
|----------|---------|
| **Step-by-step debugging** | Walk through execution one node at a time |
| **Deterministic reproduction** | Reproduce failures exactly as they occurred |
| **Structural observability** | Understand execution flow without manual instrumentation |
| **Safe early termination** | Stop execution without losing history |
| **Audit trails** | Complete record of how results were produced |

Execution becomes an inspectable system output rather than an opaque process.

---

## Summary

This execution model elevates traversal from an internal mechanism to a durable artifact.

Execution produces a structured, replayable representation that captures:

| Aspect | What is Captured |
|--------|------------------|
| **What ran** | Which nodes executed |
| **How it ran** | Traversal path through the flowchart |
| **In what order** | Sequence of execution steps |
| **With what state** | Context snapshot at each step |

---

## Technical References

This section provides educational context for developers and students interested in the underlying computer science concepts used in this library.

### Algorithms

| Algorithm | Description | Code Reference |
|-----------|-------------|----------------|
| **Tree Traversal** | The context tree is built through depth-first traversal of the pipeline. Each node creates child contexts that form the tree structure. | [`Pipeline.ts:executeNode`](../../src/core/pipeline/Pipeline.ts) |
| **Snapshot Isolation** | Each stage operates on an isolated patch that is atomically committed, preventing dirty reads between concurrent branches. | [`StageContext.ts:commitPatch`](../../src/core/context/StageContext.ts) |
| **Causal Ordering** | Execution order is determined by traversal, establishing happens-before relationships between commits. | [`Pipeline.ts:executeNode`](../../src/core/pipeline/Pipeline.ts) |

### Data Structures

| Structure | Description | Code Reference |
|-----------|-------------|----------------|
| **Context Tree** | A hierarchical tree where each node represents a stage's execution context. Parent-child relationships encode execution flow. | [`TreePipelineContext.ts`](../../src/core/context/TreePipelineContext.ts) |
| **Stage Context** | Encapsulates the state for a single stage execution, including local patch, committed state, and debug info. | [`StageContext.ts`](../../src/core/context/StageContext.ts) |
| **Execution Patch** | A local buffer that accumulates state changes during stage execution before atomic commit. | [`StageContext.ts:patch`](../../src/core/context/StageContext.ts) |
| **Context Snapshot** | An immutable view of committed state at a specific point in execution, enabling time-travel inspection. | [`StageContext.ts:getValue`](../../src/core/context/StageContext.ts) |

### Design Patterns

| Pattern | Description | Code Reference |
|---------|-------------|----------------|
| **Memento Pattern** | Each committed context acts as a memento, capturing state that can be restored for replay or debugging. | [`StageContext.ts`](../../src/core/context/StageContext.ts) |
| **Unit of Work** | Stage execution collects changes in a patch (unit of work) that is committed atomically at the end. | [`StageContext.ts:commitPatch`](../../src/core/context/StageContext.ts) |
| **Prototype Pattern** | Child contexts are created by cloning parent context, inheriting committed state while maintaining isolation. | [`StageContext.ts:createChildContext`](../../src/core/context/StageContext.ts) |
| **Visitor Pattern** | The pipeline engine visits each node in traversal order, executing stage logic and building the context tree. | [`Pipeline.ts:executeNode`](../../src/core/pipeline/Pipeline.ts) |

### External References

- [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) — Martin Fowler
- [Snapshot Isolation](https://en.wikipedia.org/wiki/Snapshot_isolation) — Wikipedia
- [Memento Pattern](https://en.wikipedia.org/wiki/Memento_pattern) — Wikipedia
- [Unit of Work](https://martinfowler.com/eaaCatalog/unitOfWork.html) — Martin Fowler
- [Time Travel Debugging](https://en.wikipedia.org/wiki/Time_travel_debugging) — Wikipedia
- [Causal Consistency](https://en.wikipedia.org/wiki/Causal_consistency) — Wikipedia

---

## Related Documentation

- [Control-Flow Model](./CONTROL_FLOW_MODEL.md) — Flowchart-based execution and traversal semantics
- [Core Concepts](../guides/CORE_CONCEPTS.md) — Pipeline, stages, scope, and memory model
- [Scope Communication](../guides/SCOPE_COMMUNICATION.md) — Cross-stage data sharing
