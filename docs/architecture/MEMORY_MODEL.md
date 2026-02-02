# Memory Model: Structured vs Unstructured

This document explains why TreeOfFunctions uses **structured memory** (GlobalStore with namespacing) instead of **unstructured memory** (flat key-value store like Relay).

## The Question

> "In Relay-style programming, memory starts as zero, grows during execution, clears at the end, and return value passes to next stage. Functions inside that session grow memory by reading and writing. Structure is irrelevant there. Why do we need structure?"

## Unstructured Memory (Relay Model)

In Relay and similar execution frameworks, memory is a simple flat store:

```typescript
// Relay-style execution
let memory = {};  // starts empty

fn1(memory);  // writes { x: 1 }
fn2(memory);  // reads x, writes { x: 1, y: 2 }
fn3(memory);  // reads y, returns result

// End: memory cleared, only return value matters
```

### How Relay Handles Parallel Execution

When functions run in parallel (Promise.all), Relay isolates them:

```typescript
// Each parallel function gets:
// - Its own COPY of input (snapshot at start)
// - Its own local variables
// - Returns its own result

const results = await Promise.all([fn1(), fn2(), fn3()]);
// Results merged AFTER all complete: [result1, result2, result3]
```

**Key insight**: Parallel functions are **isolated by design**. They:
1. Receive input as **immutable snapshot**
2. Cannot see each other's writes during execution
3. Return values are **merged after** all complete

No race conditions because **no shared mutable state**.

## Why We Need Structured Memory

TreeOfFunctions uses structured memory (GlobalStore with stage namespacing) for three reasons that Relay doesn't need:

### 1. Observability / Debugging

When something goes wrong, you need to know:
- "What did stage X see when it ran?"
- "What did stage Y write?"
- "Why did the decider choose branch A?"

**Unstructured**: Just a blob `{ x: 1, y: 2, z: 3 }` - who wrote what?

**Structured**:
```typescript
{
  pipelines: {
    "useQuestion": { expandedQuestion: "..." },
    "askLLM": { response: "...", toolCalls: [...] },
    "toolBranch": { toolResults: [...] }
  }
}
```

Each stage's writes are namespaced, so you can inspect exactly what each stage saw and wrote.

### 2. Time-Travel (FootprintsDebugUI)

The debug UI lets users:
- Click on a stage node
- See the scope state **at that moment**
- Step forward/backward through execution

This requires knowing: "At stage 3, the memory looked like THIS"

Without structure, you can't reconstruct intermediate states.

### 3. Branching / Parallel Merge Strategy

When you have branching (deciders) or parallel execution:

```
stage1 → decider → [branchA, branchB]
```

**Unstructured merge problem**:
```typescript
branchA writes: { result: "A" }
branchB writes: { result: "B" }  // overwrites!
// Final: { result: "B" } - branchA's result lost!
```

**Structured merge**:
```typescript
{
  branchA: { result: "A" },
  branchB: { result: "B" }
}
// Both preserved, consumer decides how to use
```

## Comparison Table

| Aspect | Relay (Unstructured) | TreeOfFunctions (Structured) |
|--------|---------------------|------------------------------|
| **Goal** | Run functions, get result | Run + Debug + Visualize |
| **Memory** | Temporary scratch | Audit trail |
| **Parallel isolation** | Implicit (copy-on-read) | Explicit (namespaced) |
| **Merge after parallel** | Array of results | Structured merge by stage |
| **Observability** | None (black box) | Full (who wrote what, when) |
| **Time-travel/replay** | Not supported | Core feature |
| **Branching** | Not supported | First-class (deciders) |

## The Core Difference

**Relay is for computation. TreeOfFunctions is for orchestration + observability.**

Relay's model works because it's **fire-and-forget** - you don't care about intermediate state, only the final result.

We care because we're building a **debuggable, observable** system where you can:
- Inspect any stage at any point
- See exactly what data flowed where
- Replay and debug complex multi-stage flows
- Visualize execution in real-time

## TL;DR

> "We use structured memory because we're not just running code - we're building an observable, debuggable orchestration system. The structure lets us show you exactly what each stage saw and wrote, enable time-travel debugging, and handle branching without collisions."

## Schema-Guided Dynamic Memory

We use a **hybrid approach** that combines the benefits of typed schemas with runtime flexibility:

| Aspect | Static Typed | Dynamic | What We Do |
|--------|-------------|---------|------------|
| Schema defined upfront | ✅ | ❌ | **Optional** (ScopeType interface) |
| Values start undefined | ✅ | ✅ | ✅ Yes |
| Can add new keys at runtime | ❌ | ✅ | ✅ Yes (`setObject` any key) |
| Type safety | ✅ | ❌ | **Partial** (interface exists but not enforced at runtime) |

### Why This Approach?

- **Schema exists** (ScopeType interface) for:
  - Documentation ("what fields does this flow use?")
  - IDE autocomplete
  - Type hints when reading

- **Runtime is dynamic** because:
  - Stages can write any key
  - No runtime validation against schema
  - Structure grows as execution proceeds

This is similar to TypeScript itself - you define types, but at runtime it's just JavaScript objects.

### Example

```typescript
// ScopeType = Blueprint (static, for documentation & autocomplete)
interface ChatScope {
  userQuestion?: string;           // all optional = can be undefined
  expandedQuestion?: string;
  llmResponse?: string;
}

// Scope = Runtime memory (dynamic, grows as stages write)
// Starts as {} and grows: { userQuestion: "...", expandedQuestion: "..." }
```

## Terminology

| Term | Meaning |
|------|---------|
| **ScopeType** | Interface defining expected fields (blueprint) |
| **Scope** | Runtime memory instance (actual data) |
| **GlobalStore** | Internal implementation (the actual storage) |
| **readOnlyContext** | Initial values passed to scope (immutable input) |

## Scope System Layers

The scope system has three distinct layers:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CONSUMER LAYER                                    │
│  BaseState / Custom Scope - What flow developers see and extend         │
├─────────────────────────────────────────────────────────────────────────┤
│                        BRIDGE LAYER                                      │
│  ScopeFactory - Converts engine context to consumer scope               │
├─────────────────────────────────────────────────────────────────────────┤
│                        ENGINE LAYER                                      │
│  StageContext / Scope - Memory manager (tree nav, commits, namespacing) │
│  GlobalStore - The actual shared state container                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### StageContext vs Scope (Engine Layer)

| Component | Role | Analogy |
|-----------|------|---------|
| **StageContext** | Memory engineer - creates contexts, builds execution tree | Compiler's stack frame allocator |
| **Scope** (new) | Memory engineer + pluggable recorders | StageContext + observer pattern |
| **GlobalStore** | The actual heap - holds all state | Runtime's heap memory |

**Key insight:** StageContext is like a programming engine that creates memory for functions. Consumers never directly instantiate it - they work with BaseState/custom scopes that wrap it.

### BaseState vs Custom Scope (Consumer Layer)

| Component | Role |
|-----------|------|
| **BaseState** | Library-provided base class with debug/metric helpers |
| **Custom Scope** | Consumer-defined class extending BaseState with typed properties |

In the past, consumers could randomly set their structure in memory. With BaseState, we provided Debug/Metric as internal structure offerings. Now with the new Scope + Recorders, that's flexible too - consumers can attach any recorder they want.

See [SCOPE_INTEGRATION_PROPOSAL.md](./SCOPE_INTEGRATION_PROPOSAL.md) for the detailed integration plan.

## Related Documentation

- [Scope System README](../../src/scope/README.md) - How scope works
- [Internal Memory README](../../src/internal/memory/README.md) - History and write buffering
- [Subflow = Pure Function Mental Model](../../src/core/executor/handlers/SubflowInputMapper.ts) - How subflows use isolated memory
- [FootprintsDebugUI](../../../FootprintsDebugUI/README.md) - The debug UI that relies on structured memory
- [SCOPE_INTEGRATION_PROPOSAL.md](./SCOPE_INTEGRATION_PROPOSAL.md) - How to integrate new Scope with existing pipeline
