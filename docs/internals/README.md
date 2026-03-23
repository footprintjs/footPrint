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

## Core Principle: Collect During Traversal

All data in footprintjs — narrative, metrics, manifest, identity — is collected as a **side effect of the single traversal pass**. There is no post-processing step, no second tree walk, no separate analysis phase.

Three observation systems fire during traversal:

```
                    Traversal (single pass)
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   FlowRecorder      TraversalExtractor   StageContext
   (narrative,        (per-stage data)    (execution tree)
    manifest,
    metrics)

   Recorder builds       Extractor captures    Context accumulates
   manifest as          full snapshots         the linked list of
   side effect of       with node metadata     execution state
   observing events
```

### FlowRecorder (lightweight event stream)

Pluggable observers attached via `executor.attachFlowRecorder(r)`. Receive high-level events: `onStageExecuted`, `onDecision`, `onSubflowEntry`, `onError`, etc. Each event carries just enough data for the recorder to do its job (stage name, description, decision rationale). Multiple recorders can be attached; each is error-isolated.

Best for: narrative generation, metrics collection, manifest building, audit trails.

### TraversalExtractor (per-stage snapshot extraction)

Single extractor function called after each stage executes. Receives a `StageSnapshot` containing the full `StageNode`, `StageContext`, `RuntimeStructureMetadata` (subflowId, isSubflowRoot, etc.), stage output, and optionally the full scope state.

Best for: detailed per-stage data extraction, custom analytics, schema validation.

### StageContext (execution tree accumulation)

Internal. Not pluggable. Each stage creates a `StageContext` linked to parent via `createNext()`/`createChild()`. Accumulates logs, errors, metrics, evals. After execution, `getSnapshot()` produces the tree for `RuntimeSnapshot.executionTree`.

### Design Rule

When proposing new features, always ask: *"Can this be collected during the existing traversal pass using FlowRecorder or TraversalExtractor?"* If yes, use those hooks. If a new event type is needed, add it to the existing dispatcher — do not create a post-processing step.

## Shared Observer Pattern

Two libraries independently implement the same observer pattern:

| Aspect | scope/recorders (Data) | engine/narrative (Flow) |
|---|---|---|
| **Interface** | `Recorder` | `FlowRecorder` |
| **Hooks** | `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd` | `onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onLoop`, ... |
| **Dispatch** | `ScopeFacade._invokeHook()` | `FlowRecorderDispatcher` |
| **Attachment** | `executor.attachRecorder(r)` | `executor.attachFlowRecorder(r)` |
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

A minimal Recorder attached for one `when()` call, detached in `finally`. Captures ReadEvent
key + summarized value + redacted flag. The canonical example of single-lifecycle observation.

### 3. Scope Accessor Adaptation

Duck-typed accessor factories in `decide.ts` that bridge ScopeFacade and TypedScope without
importing either. `getRedactedFn` uses `$toRaw()` to escape the Proxy since `getRedactedKeys()`
is not in the $-method namespace or EXECUTOR_INTERNAL_METHODS.
