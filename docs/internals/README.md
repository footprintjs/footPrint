# Internals

FootPrint is six independent libraries, each usable standalone. Every library has its own README with architecture details, design decisions, dependency graphs, and test coverage.

```
src/lib/
├── memory/    Transactional state (SharedMemory, StageContext, EventLog, TransactionBuffer)
├── builder/   Fluent flowchart DSL (FlowChartBuilder, DeciderList, SelectorFnList)
├── scope/     Scope facades, recorders, protection, Zod integration
├── engine/    DFS traversal, handlers, narrative generators
├── runner/    Execution convenience (FlowChartExecutor, ExecutionRuntime)
└── contract/  I/O schemas, Zod→JSON Schema, OpenAPI 3.1 generation
```

## Library READMEs

Each README follows a consistent pattern: *Why This Exists → The N Primitives → How They Work Together → Design Decisions → Dependency Graph → Test Coverage*.

| Library | Primitives | README |
|---------|-----------|--------|
| **memory/** | SharedMemory, TransactionBuffer, EventLog, StageContext, DiagnosticCollector | [src/lib/memory/README.md](../../src/lib/memory/README.md) |
| **builder/** | FlowChartBuilder, DeciderList, SelectorFnList | [src/lib/builder/README.md](../../src/lib/builder/README.md) |
| **scope/** | ScopeFacade, Recorders, Protection, Providers, Zod Integration | [src/lib/scope/README.md](../../src/lib/scope/README.md) |
| **engine/** | FlowchartTraverser, Handlers (10 specialists), FlowRecorder System | [src/lib/engine/README.md](../../src/lib/engine/README.md) |
| **runner/** | FlowChartExecutor | [src/lib/runner/README.md](../../src/lib/runner/README.md) |
| **contract/** | defineContract, schema normalization, OpenAPI generation | [src/lib/contract/](../../src/lib/contract/) |

## Dependency Graph

```
contract/  (standalone — uses builder types only)
     |
builder/  (standalone — zero internal deps)
     |
scope/  → memory/
     |
engine/ → memory/ + scope/
     |
runner/ → engine/ + memory/ + scope/
```

## Test Architecture

Four test tiers across all libraries:

| Tier | Purpose | Example |
|------|---------|---------|
| **unit/** | Individual class/function correctness | `SharedMemory.setValue` returns correct value |
| **scenario/** | Multi-step workflow correctness | Stage writes → commit → next stage reads |
| **property/** | Invariants hold for random inputs (fast-check) | Replay N commits = same state every time |
| **boundary/** | Edge cases and extremes | 10K-item arrays, 200 sequential commits |

Total: 900+ tests across 85+ suites.

## Shared Observer Pattern

Two libraries independently implement the same observer pattern:

| Aspect | scope/recorders (Data) | engine/narrative (Flow) |
|---|---|---|
| **Interface** | `Recorder` | `FlowRecorder` |
| **Hooks** | `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd` | `onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onLoop`, ... |
| **Dispatch** | `ScopeFacade._invokeHook()` | `FlowRecorderDispatcher` |
| **Attachment** | `scope.attachRecorder(r)` | `executor.attachFlowRecorder(r)` |
| **Error isolation** | try/catch per recorder | try/catch per recorder |
| **Identity** | `readonly id: string` | `readonly id: string` |
| **All hooks optional** | Yes | Yes |

Both follow the same abstract machine: **observer with `{ id, optional hooks }` → dispatcher fans out to N observers → errors swallowed → attach/detach by id → fast-path when empty.**

### Why not a shared base class?

Considered and deliberately deferred. The two dispatchers differ structurally:

- `ScopeFacade` *is* the dispatcher (inline `_invokeHook` with string-keyed dispatch)
- `FlowRecorderDispatcher` is a separate class that implements `IControlFlowNarrative` (adapter pattern)

A generic `ObserverDispatcher<T>` would save ~30 lines of duplication but add type complexity (`dispatch<K extends keyof T>` generics) and indirection. The current implementations are each ~40 lines, completely self-explanatory, and independently testable.

**Rule of three:** Two instances are a coincidence. If a third observer system is added (e.g., `BuilderRecorder` for the fluent DSL), that's the signal to extract the shared base. Until then, the duplication cost is lower than the wrong-abstraction cost.

For details on each system:
- Scope recorders: [docs/guides/scope.md](../guides/scope.md) → Recorders section
- Flow recorders: [docs/guides/flow-recorders.md](../guides/flow-recorders.md)
