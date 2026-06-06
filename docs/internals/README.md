# Internals

FootPrint is a library of focused libraries, each usable standalone. Every library has its own README with architecture details, design decisions, dependency graphs, and test coverage. The six libraries below form the core spine; the remaining libraries (see "New Libraries" further down) layer on top.

```
src/lib/
├── memory/    Transactional state (SharedMemory, StageContext, EventLog, TransactionBuffer)
├── schema/    Validation abstraction (Zod optional, duck-typed detection)
├── builder/   Fluent flowchart DSL (FlowChartBuilder, DeciderList, SelectorFnList)
├── scope/     Scope facades, recorders, protection, Zod integration
├── reactive/  TypedScope<T> deep Proxy (typed property access, $-methods)
├── decide/    decide()/select() decision evidence capture
├── recorder/  CompositeRecorder, stores, EmitRecorder, composition primitives
├── pause/     Pause/Resume (PauseSignal, FlowchartCheckpoint, PausableHandler)
├── detach/    Fire-and-forget child flowcharts (drivers, handles)
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
| **engine/** | FlowchartTraverser, Handlers (the specialists), FlowRecorder System | [src/lib/engine/README.md](../../src/lib/engine/README.md) |
| **runner/** | FlowChartExecutor | [src/lib/runner/README.md](../../src/lib/runner/README.md) |
| **contract/** | .contract(), schema normalization, OpenAPI generation | [src/lib/contract/](../../src/lib/contract/) |

## Dependency Graph

```
schema/   (standalone — validation abstraction)
     |
contract/ → builder/ + schema/
     |
builder/  → engine/ (types only)
     |
scope/  → memory/   (engine ExecutionEnv type only)
reactive/ → scope/
decide/  → scope/
     |
engine/ → memory/ + scope/
     |
runner/ → engine/ + memory/ + scope/ + schema/ (input validation)
```

## Test Architecture

Test tiers across all libraries:

| Tier | Purpose | Example |
|------|---------|---------|
| **unit/** | Individual class/function correctness | `SharedMemory.setValue` returns correct value |
| **scenario/** | Multi-step workflow correctness | Stage writes → commit → next stage reads |
| **property/** | Invariants hold for random inputs (fast-check) | Replay N commits = same state every time |
| **boundary/** | Edge cases and extremes | 10K-item arrays, 200 sequential commits |
| **security/** | Injection, leakage, redaction-bypass resistance | Redaction policy holds under crafted input |

Total: 2,700+ tests across 230+ suites.

## Core Principle: Collect During Traversal

All data in footprintjs — narrative, metrics, manifest, identity — is collected as a **side effect of the single traversal pass**. There is no post-processing step, no second tree walk, no separate analysis phase.

Observation fires on two phase-scoped channels — build-time + runtime — plus
the internal execution tree:

```
   BUILD (flowChart() ... .build())          RUNTIME (executor.run())
   ──────────────────────────────────        ────────────────────────────────
   StructureRecorder                         FlowRecorder
   (per-spec-node + per-edge events)         (per-stage transitions, runtime
                                              decision/fork/loop/error)

   onStageAdded, onEdgeAdded,                onStageExecuted, onDecision,
   onLoopEdgeAdded,                          onSubflowEntry, onError, ...
   onDeciderComplete,
   onSubflowMounted

                       ┌──────────────────────────┐
                       │  StageContext (internal) │
                       │  execution tree linked   │
                       │  list of stage state     │
                       └──────────────────────────┘
```

### StructureRecorder (build-phase event stream — v6.0+)

Pluggable build-time observer attached via `flowChart(..., { structureRecorders: [...] })` OR `.attachStructureRecorder(rec)`. Receives 5 events as the spec tree is built: `onStageAdded`, `onEdgeAdded`, `onLoopEdgeAdded`, `onDeciderComplete`, `onSubflowMounted`. Errors inspected via `builder.getStructureBuildErrors()`.

Best for: building xyflow/visualization shapes during construction; static chart-shape audits; topology indexes for streaming consumers.

### FlowRecorder (runtime event stream)

Pluggable observers attached via `executor.attachFlowRecorder(r)`. Receive high-level runtime events: `onStageExecuted`, `onDecision`, `onSubflowEntry`, `onError`, etc. Each event carries `traversalContext` with `runtimeStageId`, `iteration`, `runId`. Multiple recorders can be attached; each is error-isolated.

Best for: narrative generation, metrics collection, manifest building, audit trails.

### StageContext (execution tree accumulation)

Internal. Not pluggable. Each stage creates a `StageContext` linked to parent via `createNext()`/`createChild()`. Accumulates logs, errors, metrics, evals. After execution, `getSnapshot()` produces the tree for `RuntimeSnapshot.executionTree`.

### Design Rule

When proposing new features, always ask: *"Can this be collected during the existing traversal pass using StructureRecorder (build phase) or FlowRecorder (runtime phase)?"* If yes, use those hooks. If a new event type is needed, add it to the corresponding dispatcher — do not create a post-processing step, and do not introduce a third observer pattern.

## Shared Observer Pattern

Four observer channels independently implement the same observer pattern. The first two are the original pair; the third (`StructureRecorder`, build-phase) and fourth (`EmitRecorder`, consumer-emitted events) were added later:

| Aspect | scope/recorders (Data) | engine/narrative (Flow) |
|---|---|---|
| **Interface** | `ScopeRecorder` | `FlowRecorder` |
| **Hooks** | `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`, `onEmit` | `onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onLoop`, `onRunStart`, `onRunEnd`, `onRunFailed`, ... |
| **Dispatch** | `ScopeFacade._invokeHook()` | `FlowRecorderDispatcher` |
| **Attachment** | `executor.attachScopeRecorder(r)` | `executor.attachFlowRecorder(r)` |
| **Error isolation** | try/catch per recorder | try/catch per recorder |
| **Identity** | `readonly id: string` | `readonly id: string` |
| **All hooks optional** | Yes | Yes |

A `CombinedRecorder` lets one object implement hooks across all channels; the library routes it to the right dispatchers by method-shape detection (`executor.attachCombinedRecorder(r)`).

Both follow the same abstract machine: **observer with `{ id, optional hooks }` → dispatcher fans out to N observers → errors swallowed → attach/detach by id → fast-path when empty.**

### Why not a shared base class?

Considered and deliberately kept apart. The dispatchers differ structurally:

- `ScopeFacade` *is* the data dispatcher (inline `_invokeHook` with string-keyed dispatch); `EmitRecorder.onEmit` rides the same channel
- `FlowRecorderDispatcher` is a separate class that implements `IControlFlowNarrative` (adapter pattern)
- `StructureRecorderDispatcher` is the build-phase dispatcher, fired synchronously during builder operations

A generic `ObserverDispatcher<T>` would save duplication but add type complexity (`dispatch<K extends keyof T>` generics) and indirection. Each implementation is small, self-explanatory, and independently testable.

**Why still not unified:** even with four channels, the dispatchers were intentionally NOT collapsed into one base. Each channel has a distinct invariant set (build-phase vs runtime, fires-before vs fires-after a stage, pass-through vs buffered), so a shared base would couple unrelated lifecycles. The duplication cost stays lower than the wrong-abstraction cost.

For details on each system:
- Scope recorders: [docs/guides/scope.md](../guides/scope.md) → Recorders section
- Flow recorders: [docs/guides/flow-recorders.md](../guides/flow-recorders.md)

## New Libraries (v1.0)

### reactive/ — TypedScope Deep Proxy

Wraps ScopeFacade in a Proxy for typed property access (`scope.creditTier` instead of
`scope.getValue('creditTier') as string`). All scope infrastructure methods are $-prefixed
to prevent collision with state keys. See `src/lib/reactive/README.md`.

### decide/ — Decision Evidence Capture

`decide()` and `select()` helpers auto-capture evidence from decider/selector functions.
Two `when` formats: function (auto-captures reads via temp recorder) and Prisma-style
filter (captures operators + thresholds). See `src/lib/decide/README.md`.

## Decision Evidence Patterns

Three new patterns introduced with the decide/ library:

### 1. Object-level Symbol Branding

`DECISION_RESULT = Symbol('footprint:decide:result')` is embedded in `DecisionResult`
and `SelectionResult` objects. Unlike class-level brands (`ScopeFacade.BRAND = Symbol.for(...)`)
which use the global registry for cross-version detection, this is a private Symbol for
discriminating result types at the engine boundary. The engine checks via `Reflect.has()`.

### 2. Temporary Recorder (EvidenceCollector)

A minimal `ScopeRecorder` (`EvidenceCollector`) attached for one `when()` call, detached in `finally`.
Captures ReadEvent key + summarized value + redacted flag. The canonical example of single-lifecycle observation.

### 3. Scope Accessor Adaptation

Duck-typed accessor factories in `decide.ts` that bridge ScopeFacade and TypedScope without
importing either. `getRedactedFn` uses `$toRaw()` to escape the Proxy since `getRedactedKeys()`
is not in the $-method namespace or EXECUTOR_INTERNAL_METHODS.
