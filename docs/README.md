# FootPrint Documentation

Welcome to the FootPrint documentation. FootPrint is a tiny, production-minded runtime for building flowchart-like pipelines where each node is just a function.

## Documentation Structure

```
docs/
├── README.md              ← You are here
├── training/              ← Foundational concepts
│   ├── README.md          ← Training index
│   ├── 01-FUNCTIONS.md
│   ├── 02-EXECUTION.md
│   ├── 03-MEMORY.md
│   ├── 04-SCOPE.md
│   └── 05-FLOWCHART_EXECUTION.md
├── guides/                ← How to use FootPrint
│   ├── README.md          ← Guide index
│   ├── GETTING_STARTED.md
│   ├── CORE_CONCEPTS.md
│   ├── PATTERNS.md
│   ├── FLOWCHART_BUILDER.md
│   └── SCOPE_COMMUNICATION.md
└── internals/             ← How FootPrint works
    ├── README.md          ← Internals index
    ├── CONTROL_FLOW_MODEL.md
    └── EXECUTION_ARTIFACT.md
```

---

## Training (Start Here)

New to FootPrint? Start with the training modules to build foundational understanding.

| # | Module | Time | Description |
|---|--------|------|-------------|
| 1 | [Functions](./training/01-FUNCTIONS.md) | 15 min | What is a function? Input/output |
| 2 | [Execution](./training/02-EXECUTION.md) | 20 min | Call stack and execution flow |
| 3 | [Memory](./training/03-MEMORY.md) | 20 min | Stack, heap, and global memory |
| 4 | [Scope](./training/04-SCOPE.md) | 25 min | Local, closure, and global scope |
| 5 | [Flowchart Execution](./training/05-FLOWCHART_EXECUTION.md) | 30 min | Bridge to FootPrint concepts |

📖 **[Training Index](./training/README.md)** - Complete learning path (~2 hours)

---

## User Guides

Practical guides for building applications with FootPrint.

| Document | Description | Time |
|----------|-------------|------|
| [Getting Started](./guides/GETTING_STARTED.md) | Installation and first pipeline | 10 min |
| [Core Concepts](./guides/CORE_CONCEPTS.md) | Architecture and memory model | 20 min |
| [Patterns](./guides/PATTERNS.md) | Fork, Decider, Selector patterns | 30 min |
| [Dynamic Children](./guides/DYNAMIC_CHILDREN.md) | Runtime-created children | 15 min |
| [FlowChartBuilder API](./guides/FLOWCHART_BUILDER.md) | Complete API reference | Reference |
| [Scope Communication](./guides/SCOPE_COMMUNICATION.md) | Cross-stage data sharing | 15 min |

📖 **[Guide Index](./guides/README.md)** - Learning path and quick reference

---

## Technical Internals

Educational documentation for developers interested in the underlying computer science.

| Document | Description |
|----------|-------------|
| [Control-Flow Model](./internals/CONTROL_FLOW_MODEL.md) | Flowchart execution and traversal semantics |
| [Execution Artifact](./internals/EXECUTION_ARTIFACT.md) | Execution as a durable, inspectable artifact |

Each internal document includes:
- Algorithms used (DFS, State Machine, etc.)
- Data structures (Directed Graph, Scope Tree, etc.)
- Design patterns (Builder, Strategy, Command, etc.)
- Code references to source files

📖 **[Internals Index](./internals/README.md)** - Architecture overview

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Not a DAG** | Supports loops, re-entry, and partial/resumed execution |
| **Parallel Fan-Out/In** | Fork pattern with automatic aggregation |
| **Three-Level Scope** | Global → Path → Node memory isolation |
| **Patch-Based State** | Atomic commits, safe merges |
| **First-Class Observability** | Connected logs, traces, time-travel debugging |

---

## Quick Links

- [GitHub Repository](https://github.com/sanjay1909/footPrint)
- [npm Package](https://www.npmjs.com/package/footprint)
- [Demo Examples](../demo/) - Progressive examples from simple to complex
