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
| **engine/** | FlowchartTraverser, Handlers (10 specialists), ControlFlowNarrativeGenerator | [src/lib/engine/README.md](../../src/lib/engine/README.md) |
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

Total: 400+ tests across 60+ suites.
