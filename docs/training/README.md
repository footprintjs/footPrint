# FootPrint Training

This training series builds foundational understanding from basic programming concepts to FootPrint's execution model. Each module builds on the previous one.

## Learning Path

| # | Module | Time | Prerequisites |
|---|--------|------|---------------|
| 1 | [Functions](./01-FUNCTIONS.md) | 15 min | Basic programming |
| 2 | [Execution](./02-EXECUTION.md) | 20 min | Module 1 |
| 3 | [Memory](./03-MEMORY.md) | 20 min | Module 2 |
| 4 | [Scope](./04-SCOPE.md) | 25 min | Module 3 |
| 5 | [Flowchart Execution](./05-FLOWCHART_EXECUTION.md) | 30 min | Module 4 |
| 6 | [Core Architecture](./06-CORE_ARCHITECTURE.md) | 35 min | Module 5 |

**Total time: ~2.5 hours**

---

## Module Overview

### Module 1: Functions
What is a function? How do functions receive input and produce output? Understanding functions as the building blocks of computation.

### Module 2: Execution
How does a function execute? What happens when you call a function? Understanding the call stack and execution flow.

### Module 3: Memory
Where does data live during execution? Understanding local variables, heap allocation, and the difference between stack and heap memory.

### Module 4: Scope
How do functions access data? Understanding local, protected (closure), and global scope. How scope controls visibility and lifetime.

### Module 5: Flowchart Execution
How FootPrint maps these concepts to flowchart-based execution. Understanding stages, scope objects, and the execution artifact.

### Module 6: Core Architecture
Deep dive into FootPrint's implementation. The four-layer architecture (Builder, Execution, Context, Scope), design patterns used, and source code mapping.

---

## The Bridge to FootPrint

After completing this training, you'll understand:

| Traditional Concept | FootPrint Equivalent |
|---------------------|---------------------|
| Function | Stage |
| Call Stack | Execution Tree |
| Local Variables | Node Context |
| Closure Variables | Path Context |
| Global Variables | Global Context |
| Return Value | Stage Output |
| Function Call | Stage Transition |

---

## Quick Reference

```
Traditional:                    FootPrint:
┌─────────────────┐            ┌─────────────────┐
│    function     │            │     stage       │
│  ┌───────────┐  │            │  ┌───────────┐  │
│  │  local    │  │            │  │   node    │  │
│  │ variables │  │            │  │  context  │  │
│  └───────────┘  │            │  └───────────┘  │
│  ┌───────────┐  │            │  ┌───────────┐  │
│  │  closure  │  │            │  │   path    │  │
│  │ variables │  │            │  │  context  │  │
│  └───────────┘  │            │  └───────────┘  │
│  ┌───────────┐  │            │  ┌───────────┐  │
│  │  global   │  │            │  │  global   │  │
│  │ variables │  │            │  │  context  │  │
│  └───────────┘  │            │  └───────────┘  │
└─────────────────┘            └─────────────────┘
```

---

## Next Steps

After completing training:
1. [Getting Started](../guides/GETTING_STARTED.md) - Build your first pipeline
2. [Demo Examples](../../demo/) - See patterns in action
3. [Core Concepts](../guides/CORE_CONCEPTS.md) - Deep dive into architecture
