# runner/

The convenience layer that connects builder output to engine execution. Takes a compiled FlowChart, wires up the runtime, runs the traversal, and exposes the results.

Depends on `engine/` (traversal), `memory/` (state management), and `scope/` (state access).

---

## Why This Exists

The engine library (`engine/`) is the traversal algorithm. It needs a `FlowchartTraverser` configured with a root node, a stage map, a scope factory, a ExecutionRuntime, a logger, a narrative generator, and several optional flags. That's a lot of wiring.

Consumers don't want to do that wiring. They want:

```typescript
const chart = flowChart('validate', validateFn)
  .addFunction('process', processFn)
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();
```

That's what this module provides. It takes the FlowChart (output of `builder/`) and a scope factory (from `scope/`), creates the runtime internally, and delegates to the engine. Build → Run. Two lines.

Without this layer, every consumer would need to:
1. Create a ExecutionRuntime with the right initial state
2. Construct a FlowchartTraverser with 12+ options
3. Call `execute()` and then query multiple introspection methods
4. Handle narrative enablement and runtime recreation

The runner absorbs all of that.

---

## The Primitive

### FlowChartExecutor — "The Ignition Key"

Takes a compiled FlowChart and a scope factory. Wires up the engine. Provides `run()` and post-execution introspection.

**Why it connects to the main goal:** The executor is where the trace starts. Before `run()`, the flowchart is a static graph. After `run()`, the engine has walked every node, recorded every decision, and produced both the result and the narrative. The executor's job is to make this transition trivial — one method call, full trace output.

**Why it lives in runner/, not engine/:** The engine's boundary is `FlowchartTraverser` — the pure traversal algorithm. The executor is consumer convenience: runtime creation, option resolution, narrative toggling. Mixing convenience code with the traversal algorithm would blur the engine's clean boundary. Same reason `graphql()` (the convenience function) lives in `graphql/` root, not in `graphql/execution`.

```typescript
const executor = new FlowChartExecutor(chart, scopeFactory);

// Optional: enable flow narrative capture
executor.enableNarrative();

// Run the flowchart
const result = await executor.run();

// Introspection — what happened?
executor.getSnapshot();          // full runtime state (global + per-stage)
executor.getRuntime();           // raw ExecutionRuntime (advanced)
executor.getNarrative();         // flow narrative sentences
executor.getRuntimeRoot();       // graph as executed (may differ from build-time)
executor.getRuntimeStructure();  // serialized graph shape for visualization
executor.getBranchIds();         // child branch IDs from fan-out
executor.getSubflowResults();    // per-subflow results
executor.getExtractedResults();  // per-stage extractor output
executor.getExtractorErrors();   // any errors during extraction
```

**Key design decision:** `run()` recreates the traverser each time. This means `enableNarrative()` can be called between construction and execution — the flag gets picked up on the next `run()`. It also means each `run()` starts fresh with a new ExecutionRuntime, which prevents state leakage between runs.

---

## How It Works

```
1. Consumer calls new FlowChartExecutor(chart, scopeFactory, ...)
   → stores constructor args for later recreation

2. Consumer optionally calls executor.enableNarrative()
   → sets a flag (no work yet)

3. Consumer calls executor.run()
   → creates fresh ExecutionRuntime (SharedMemory + EventLog)
   → creates FlowchartTraverser with full TraverserOptions
   → calls traverser.execute() (engine takes over)
   → returns TraversalResult

4. Consumer queries results
   → executor.getSnapshot()     → traverser.getSnapshot()     → runtime.getSnapshot()
   → executor.getNarrative()    → traverser.getNarrative()    → narrative.getSentences()
   → executor.getRuntimeRoot()  → traverser.getRuntimeRoot()  → root StageNode
```

The executor is a thin delegation layer. Every introspection method forwards to the traverser, which forwards to the appropriate internal component. No logic lives here — just wiring and forwarding.

---

## Design Decisions

| Decision | Why | How it serves the goal |
|---|---|---|
| Positional constructor params (matching old API) | Backwards-compatible with existing consumers | Migration path: swap import, everything works |
| `run()` recreates traverser | Fresh runtime per execution, no state leakage | Each run produces a clean, independent trace |
| `enableNarrative()` as opt-in | Zero cost in production (NullControlFlowNarrativeGenerator) | Only pay for narrative when you need it |
| Introspection methods on executor | Consumer doesn't need to know about traverser internals | One object to query after execution |
| Static import of ExecutionRuntime | Clean dependency, no dynamic require | Runtime wiring is explicit and traceable |

---

## Dependency Graph

```
  FlowChartExecutor
       |
  engine/FlowchartTraverser (traversal algorithm)
       |
  runner/ExecutionRuntime (runtime state)
  scope/ (ScopeProtectionMode)
```

---

## What's Next (Phase 5 completion)

The current FlowChartExecutor is a god object — it's the runner AND the session. `run()` returns a `TraversalResult`, and you query the same executor object for introspection.

The planned separation:

```typescript
// Future: run() returns an ExecutionSession
const session = await executor.run();

session.getSnapshot();        // introspection on the session, not the executor
session.getNarrative();       // the session owns its results
session.getRuntimeRoot();     // can compare sessions from multiple runs
```

`ExecutionSession` would wrap the traverser's post-execution state as an immutable value object. The executor becomes stateless between runs. You can run twice and compare sessions. You can pass a session to another component without passing the executor.
