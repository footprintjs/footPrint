# TreeOfFunctionsLib Terminology Guide

This document explains the naming conventions and terminology used in TreeOfFunctionsLib. The library uses names inspired by compiler and runtime concepts to make the codebase intuitive for developers.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PipelineRuntime                                   │
│         (Top-level container - analogous to Runtime Environment)            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │
│  │    GlobalStore    │  │   StageContext    │  │   ExecutionHistory    │   │
│  │   (Shared State)  │  │   (Per-stage)     │  │    (Time-travel)      │   │
│  │                   │  │                   │  │                       │   │
│  │  Compiler:        │  │  Compiler:        │  │  Compiler:            │   │
│  │  Heap/Global      │  │  Activation       │  │  Execution Trace      │   │
│  │  Store            │  │  Record           │  │                       │   │
│  │                   │  │                   │  │  • record()           │   │
│  │  • get/set        │  │  ┌─────────────┐  │  │  • materialise()      │   │
│  │  • getState()     │  │  │ WriteBuffer │  │  │  • list()             │   │
│  │  • applyPatch()   │  │  │ (Staged     │  │  └───────────────────────┘   │
│  │                   │  │  │  Writes)    │  │                              │
│  └───────────────────┘  │  └─────────────┘  │                              │
│                         │  ┌─────────────┐  │                              │
│                         │  │StageMetadata│  │                              │
│                         │  │ (Logs/Errs) │  │                              │
│                         │  └─────────────┘  │                              │
│                         │                   │                              │
│                         │  • next/children  │                              │
│                         │  • commit()       │                              │
│                         └───────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          User-Facing Layer                                  │
│  ┌───────────────────┐      ┌───────────────────────────────────────────┐  │
│  │   ScopeFactory    │      │              Scope (TScope)               │  │
│  │                   │ ───▶ │                                           │  │
│  │  Transforms       │      │  What stage functions receive.            │  │
│  │  StageContext     │      │  Custom per-application.                  │  │
│  │  into user Scope  │      │                                           │  │
│  └───────────────────┘      └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Classes

### PipelineRuntime

**File:** `src/core/context/PipelineRuntime.ts`

**Purpose:** The top-level container that holds all execution state for a pipeline run. It orchestrates the GlobalStore, root StageContext, and ExecutionHistory.

**Compiler Analogy:** Runtime Environment - just like a language runtime provides the execution environment for programs, PipelineRuntime provides the execution environment for pipelines.

**Key Members:**
- `globalStore` - Shared state across all stages
- `rootStageContext` - Entry point for the stage tree
- `executionHistory` - Time-travel debugging support

**Key Methods:**
- `getSnapshot()` - Returns complete execution state for debugging

---

### StageContext

**File:** `src/core/context/StageContext.ts`

**Purpose:** Holds ephemeral state for a single stage execution. Manages reads/writes through a WriteBuffer and creates child/next contexts for branching execution.

**Compiler Analogy:** Activation Record (Stack Frame) - just like a function call creates an activation record on the stack, each stage execution creates a StageContext.

**Key Members:**
- `stageName` - Human-readable name for debugging
- `pipelineId` - Identifier for the pipeline namespace
- `parent/next/children` - Links for walking the stage tree
- `metadata` - Per-stage logs, errors, metrics

**Key Methods:**
- `get(path, key)` - Read value from staged or global state
- `set(path, key, value)` - Write value (staged until commit)
- `merge(path, key, value)` - Deep merge value (staged until commit)
- `commit()` - Flush staged writes to GlobalStore
- `createNext(name)` - Create linear successor stage
- `createChild(pipelineId, branchId, name)` - Create branch/fork stage
- `addLog(key, value)` - Add to log context
- `addError(key, value)` - Add to error context

---

### GlobalStore

**File:** `src/core/context/GlobalStore.ts`

**Purpose:** Shared state across all stages. The single source of truth that WriteBuffer patches get committed to.

**Compiler Analogy:** Heap / Global Store - just like the heap stores dynamically allocated data accessible from anywhere, GlobalStore holds shared state accessible from any stage.

**Key Methods:**
- `getValue(pipelineId, path, key)` - Read value
- `setValue(pipelineId, path, key, value)` - Write value
- `getState()` - Get current state as JSON
- `applyPatch(overwrite, updates, trace)` - Apply committed changes

---

### WriteBuffer

**File:** `src/core/stateManagement/WriteBuffer.ts`

**Purpose:** Collects staged writes before atomic commit to GlobalStore. Implements copy-on-write semantics for isolation between stages.

**Compiler Analogy:** Write Buffer / Transaction Log - just like a database transaction log batches writes before commit, WriteBuffer batches stage writes for atomic application.

**Key Methods:**
- `set(path, value)` - Stage a hard overwrite
- `merge(path, value)` - Stage a deep merge
- `get(path)` - Read from staged or base state
- `commit()` - Return all staged changes and reset

---

### StageMetadata

**File:** `src/core/context/StageMetadata.ts`

**Purpose:** Per-stage observability data including logs, errors, metrics, and evals. Not part of execution state - purely for debugging and monitoring.

**Compiler Analogy:** Metadata / Diagnostics - like compiler diagnostics that provide information about compilation without affecting the output.

**Key Members:**
- `logContext` - Debug log entries
- `errorContext` - Error entries
- `metricContext` - Performance metrics
- `evalContext` - Evaluation results

**Key Methods:**
- `addLog(key, value)` - Add to log context
- `setLog(key, value)` - Set in log context
- `addError(key, value)` - Add to error context
- `addMetric(key, value)` - Add to metric context
- `addEval(key, value)` - Add to eval context

---

### ExecutionHistory

**File:** `src/core/stateManagement/ExecutionHistory.ts`

**Purpose:** Stores commit bundles for time-travel debugging. Allows materializing state at any point in execution history.

**Compiler Analogy:** Execution Trace - like a debugger's execution trace that records program state over time.

**Key Methods:**
- `record(bundle)` - Store a commit bundle
- `materialise(stepIdx)` - Rebuild state at a specific step
- `list()` - Get all recorded bundles
- `clear()` - Reset history

---

## Types

### RuntimeSnapshot

**Purpose:** Complete snapshot of pipeline execution state for debugging and API responses.

```typescript
type RuntimeSnapshot = {
  globalStore: Record<string, unknown>;  // Current global state
  stages: StageSnapshot;                  // Tree of stage data
  history: CommitBundle[];                // Commit history
};
```

### StageSnapshot

**Purpose:** Serialized representation of a single stage's execution data.

```typescript
type StageSnapshot = {
  id: string;                             // Pipeline identifier
  name?: string;                          // Stage name
  isDecider?: boolean;                    // Is decider stage
  isFork?: boolean;                       // Is fork stage
  logs: Record<string, unknown>;          // Log entries
  errors: Record<string, unknown>;        // Error entries
  metrics: Record<string, unknown>;       // Metric entries
  evals: Record<string, unknown>;         // Eval entries
  next?: StageSnapshot;                   // Linear successor
  children?: StageSnapshot[];             // Branch children
};
```

---

## Internal vs External Concepts

### Internal (Library) Layer

These are internal library concepts that manage execution:

| Class | Purpose |
|-------|---------|
| `StageContext` | Per-stage execution state |
| `GlobalStore` | Shared state storage |
| `WriteBuffer` | Staged write batching |
| `StageMetadata` | Observability data |
| `ExecutionHistory` | Time-travel support |
| `PipelineRuntime` | Top-level container |

### External (User) Layer

These are user-facing concepts that consumers interact with:

| Concept | Purpose |
|---------|---------|
| `Scope` | What stage functions receive (custom per-app) |
| `ScopeFactory` | Transforms StageContext → user Scope |
| `PipelineStageFunction` | User-defined stage logic |

**Key Insight:** The library provides `StageContext` internally, but users work with their own `Scope` type. The `ScopeFactory` bridges these layers, allowing each application to define its own typed interface while the library handles execution mechanics.

---

## Naming Conventions

### Suffixes

| Suffix | Meaning | Example |
|--------|---------|---------|
| `Runtime` | Top-level execution environment | `PipelineRuntime` |
| `Store` | Shared state storage | `GlobalStore` |
| `Context` | Per-execution state | `StageContext` |
| `Buffer` | Staged/batched operations | `WriteBuffer` |
| `Metadata` | Observability/debugging data | `StageMetadata` |
| `History` | Time-ordered records | `ExecutionHistory` |
| `Snapshot` | Serialized state at a point in time | `RuntimeSnapshot`, `StageSnapshot` |
| `Factory` | Creates instances | `ScopeFactory` |

### Method Naming

| Pattern | Meaning | Example |
|---------|---------|---------|
| `get*` | Read operation | `getSnapshot()`, `getState()` |
| `set*` | Write operation (overwrite) | `set()`, `setLog()` |
| `add*` | Write operation (append/merge) | `addLog()`, `addError()` |
| `create*` | Factory method | `createNext()`, `createChild()` |
| `commit` | Flush staged changes | `commit()` |
| `record` | Store for history | `record()` |

---

## Public API Exports

The library exports a clean, well-organized public API. Internal implementation details are not exposed.

### FlowChart Factory (Recommended Entry Point)

The D3-style factory function is the recommended way to create flowcharts:

```typescript
import { flowChart, FlowChart, FlowChartExecutor } from 'tree-of-functions-lib';

// Create and build a flowchart
const chart: FlowChart = flowChart('entry', entryFn)
  .addFunction('process', processFn)
  .addFunction('output', outputFn)
  .build();

// Execute the flowchart
const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();
```

### FlowChartBuilder (Advanced API)

For more control, use the builder class directly:

```typescript
import { 
  FlowChartBuilder,
  FlowChartSpec,
  FlowChart,
  DeciderList,
  SelectorList,
} from 'tree-of-functions-lib';
```

**Builder Methods:**
| Method | Purpose |
|--------|---------|
| `start(name, fn?)` | Define the root function |
| `addFunction(name, fn?)` | Add a linear stage |
| `addListOfFunction(specs)` | Add parallel children (fork) |
| `addDecider(fn)` | Add single-choice branching |
| `addSelector(fn)` | Add multi-choice branching |
| `addSubFlowChart(id, flow)` | Mount subflow as child |
| `addSubFlowChartNext(id, flow)` | Mount subflow as continuation |
| `addStreamingFunction(name)` | Add streaming stage |
| `loopTo(stageId)` | Set loop target |
| `addTraversalExtractor(fn)` | Register data extractor |
| `into(childId)` | Navigate into child |
| `end()` | Navigate to parent |
| `build()` | Compile to FlowChart |
| `toSpec()` | Export pure JSON spec |
| `execute(factory)` | Build and run |

### FlowChart Type

The compiled output of `FlowChartBuilder.build()`:

```typescript
type FlowChart<TOut = any, TScope = any> = {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  extractor?: TraversalExtractor;
};
```

### FlowChartExecutor (Runtime Engine)

The recommended runtime engine for executing flowcharts:

```typescript
import { FlowChartExecutor } from 'tree-of-functions-lib';

const executor = new FlowChartExecutor(
  flowChart,      // FlowChart from build()
  scopeFactory,   // Creates scope for each stage
  defaults?,      // Optional default context values
  initial?,       // Optional initial context values
  readOnly?,      // Optional read-only context values
  throttlingChecker?, // Optional throttling error detector
  streamHandlers?,    // Optional streaming handlers
);

// Execute the flowchart
const result = await executor.run();

// Introspection methods
executor.getContextTree();      // Full execution context
executor.getExtractedResults(); // Extractor output
executor.getSubflowResults();   // Subflow execution data
```

### Context Classes

```typescript
import { 
  StageContext,
  PipelineRuntime,
  GlobalStore,
  StageMetadata,
} from 'tree-of-functions-lib';
```

### State Management

```typescript
import { 
  WriteBuffer,
  ExecutionHistory,
} from 'tree-of-functions-lib';
```

### Pipeline Engine (Legacy)

The original Pipeline class is still available for backward compatibility:

```typescript
import { 
  Pipeline,
  StageNode,
  Selector,
  Decider,
} from 'tree-of-functions-lib';
```

> **Note:** Prefer `FlowChartExecutor` for new code. `Pipeline` requires separate `root` and `stageMap` parameters, while `FlowChartExecutor` accepts a single `FlowChart` object.

### Scope System

```typescript
import { 
  BaseState,
  ScopeFactory,
  ScopeProvider,
} from 'tree-of-functions-lib';
```

---

## What's NOT Exported

The following are internal implementation details and are not part of the public API:

- `DELIM` - Internal path delimiter constant
- `applySmartMerge` - Internal merge utility
- Legacy aliases (`PatchedMemoryContext`, `MemoryHistory`, etc.)
- Internal node types (`_N`)
- Internal helper functions

---

## Migration from Old Names

| Old Name | New Name |
|----------|----------|
| `BuiltFlow` | `FlowChart` |
| `Pipeline` | `FlowChartExecutor` |
| `pipeline.execute()` | `executor.run()` |
| `new FlowChartBuilder().start()` | `flowChart()` |
| `TreePipelineContext` | `PipelineRuntime` |
| `GlobalContext` | `GlobalStore` |
| `PatchedMemoryContext` | `WriteBuffer` |
| `DebugContext` | `StageMetadata` |
| `MemoryHistory` | `ExecutionHistory` |
| `ContextTreeType` | `RuntimeSnapshot` |
| `StageType` | `StageSnapshot` |
| `getContextTree()` | `getSnapshot()` |
| `getMemoryContext()` | `getWriteBuffer()` |
| `commitPatch()` | `commit()` |
| `addDebugInfo()` | `addLog()` |
| `addErrorInfo()` | `addError()` |
