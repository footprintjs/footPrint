# runner/

The convenience layer that connects builder output to engine execution. Takes a compiled FlowChart, wires up the runtime, runs the traversal, and exposes the results.

Depends on `engine/` (traversal), `memory/` (state management), and `scope/` (state access).

`RunnableChart · makeRunnable` also owns the built chart's self-description methods. `chart.toOpenAPI()` is the sole OpenAPI generator: it reads builder-prepared metadata, normalizes schemas through `contract/`, and caches only calls without options. It never walks `buildTimeStructure`. `chart.toMCPTool()` shares schema normalization, not a second OpenAPI implementation.

---

## Why This Exists

The engine library (`engine/`) is the traversal algorithm. It needs a `FlowchartTraverser` configured with a root node, a stage map, a scope factory, a ExecutionRuntime, a logger, a narrative generator, and several optional flags. That's a lot of wiring.

Consumers don't want to do that wiring. They want:

```typescript
const chart = flowChart('validate', validateFn)
  .addFunction('process', processFn)
  .build();

const executor = new FlowChartExecutor(chart);
const result = await executor.run();
```

That's what this module provides. It takes the FlowChart (output of `builder/`) and an optional scope factory (defaults to `ScopeFacade`), creates the runtime internally, and delegates to the engine. Build → Run. Two lines.

Without this layer, every consumer would need to:
1. Create a ExecutionRuntime with the right initial state
2. Construct a FlowchartTraverser with 12+ options
3. Call `execute()` and then query multiple introspection methods
4. Handle narrative enablement and runtime recreation

The runner absorbs all of that.

---

## The Primitive

### FlowChartExecutor — "The Ignition Key"

Takes a compiled FlowChart and an optional scope factory (defaults to `ScopeFacade`). Wires up the engine. Provides `run()` and post-execution introspection.

**Why it connects to the main goal:** The executor is where the trace starts. Before `run()`, the flowchart is a static graph. After `run()`, the engine has walked every node, recorded every decision, and produced both the result and the narrative. The executor's job is to make this transition trivial — one method call, full trace output.

**Why it lives in runner/, not engine/:** The engine's boundary is `FlowchartTraverser` — the pure traversal algorithm. The executor is consumer convenience: runtime creation, option resolution, narrative toggling. Mixing convenience code with the traversal algorithm would blur the engine's clean boundary. Same reason `graphql()` (the convenience function) lives in `graphql/` root, not in `graphql/execution`.

```typescript
const executor = new FlowChartExecutor(chart);  // uses default ScopeFacade
// or: new FlowChartExecutor(chart, customScopeFactory);

// Optional: enable flow narrative capture
executor.enableNarrative();

// Run the flowchart
const result = await executor.run();

// Introspection — what happened?
executor.getSnapshot();          // full runtime state (global + per-stage)
executor.getRuntime();           // raw ExecutionRuntime (advanced)
executor.getNarrativeEntries();  // structured narrative entries (.map(e => e.text) for strings)
executor.getRuntimeRoot();       // graph as executed (may differ from build-time)
executor.getRuntimeStructure();  // serialized graph shape for visualization
executor.getBranchIds();         // child branch IDs from fan-out
executor.getSubflowResults();    // per-subflow results
```

**Key design decision:** `run()` recreates the traverser each time. This means `enableNarrative()` can be called between construction and execution — the flag gets picked up on the next `run()`. It also means each `run()` starts fresh with a new ExecutionRuntime, which prevents state leakage between runs.

---

## How It Works

```
1. Consumer calls new FlowChartExecutor(chart)  // or (chart, scopeFactory, ...)
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
   → executor.getNarrativeEntries() → executor-owned combined recorder (standalone flow fallback if absent)
   → executor.getRuntimeRoot()  → traverser.getRuntimeRoot()  → root StageNode
```

The executor is a thin delegation layer. Every introspection method forwards to the traverser, which forwards to the appropriate internal component. No logic lives here — just wiring and forwarding.

The narrative view is owned by `RunObservers`: `enableNarrative(options)` configures it, and attaching any flow recorder also enables it. An attached `narrative(options)` has a separate default identity and formatting policy; read that view through `recorder.getEntries()`. Default narrators no longer displace the executor's narrator; custom recorder IDs must avoid the generated `combined-narrative-N` namespace. A fresh `run()` resets both views, a same-executor `resume()` retains their history, and a fresh-executor `resume()` records only the resumed leg. Only explicitly attached recorders appear in `getSnapshot().recorders`.

### The executor's modules (F9)

`FlowChartExecutor.ts` keeps the per-run state (traverser, runId, counters, checkpoint) and the run lifecycle
that threads it. Each other job is one module it composes:

| Module | One job |
|---|---|
| `options.ts` | `FlowChartExecutorOptions` + `resolveExecutorArgs` — either constructor form → the args every leg reads |
| `attach.ts` | `RunObservers` — the narrative recorder, the inline scope/flow lists, the deferred tier; the `attach*Recorder` family delegates here, and each leg asks it for the composed scope factory and flow list |
| `resume.ts` | `planResume` (decode → find the paused stage → stand-in → `ResumeEntry.plan`; every refusal before any state moves), `seedCounters`, `announceResume` (the executor-made `onResume`) |
| `checkpoint.ts` | `buildPauseCheckpoint` — the LEAN checkpoint (format 2): what resume reads and the pause's record, read straight off the stores (no snapshot built), in one detached `structuredClone` stamped with the codec's version (`pause/record.ts`); names a consumer-data violation |
| `snapshot.ts` | `servedSnapshot` + `collectRecorderSnapshots` — one recorder row per id across channels and tiers |

```typescript
// resume(), read top to bottom — the executor only threads state between the steps:
const plan = planResume(chart, checkpoint, input);   // refuses here, nothing touched yet
seedCounters(plan.checkpoint, counter, visitCounts); // mutate, never replace (shared by reference)
traverser = createTraverser({ resume: plan.entry });
announceResume(plan, input, { runId, executionCount, observers });
```

**A pause leaves the state, not the story.** `buildPauseCheckpoint` reads the root store and the signal's
captures and builds no snapshot — format 1 built the run's whole execution tree to carry it (97% of an
agent run's checkpoint) and resume never read it (`bench/checkpoint-size.ts`). The story stays on the
executor, served by `getSnapshot()`:

```typescript
await executor.run();
if (executor.isPaused()) {
  await sessions.put(id, JSON.stringify(executor.getCheckpoint())); // the state + a small record
  await runs.put(id, JSON.stringify(executor.getSnapshot()));       // the run so far, if you keep runs
}
```

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

## ComposableRunner — Subflow Composition Interface

An interface for runners that expose their internal flowChart for subflow mounting. Any runner implementing `ComposableRunner` can be mounted in a parent flowChart via `addSubFlowChart()`, enabling full UI drill-down into nested execution.

```typescript
import { flowChart, FlowChartExecutor, type ComposableRunner } from 'footprintjs';

interface AgentResult { answer: string }

class MyAgent implements ComposableRunner<string, AgentResult> {
  // Local response for this composition example; no model service is called.
  private chart = flowChart<AgentResult>('Respond', (scope) => {
    scope.answer = scope.$getArgs<{ prompt: string }>().prompt.toUpperCase();
  }, 'respond').build();
  toFlowChart() { return this.chart; }
  async run(input: string): Promise<AgentResult> {
    const executor = new FlowChartExecutor(this.chart);
    await executor.run({ input: { prompt: input } });
    const answer = executor.getSnapshot().sharedState.answer;
    if (typeof answer !== 'string') throw new Error('The response stage did not produce an answer');
    return { answer };
  }
}

// Mount in a parent chart — UI can drill into MyAgent's internal stages
const agent = new MyAgent();
flowChart('Seed', () => {}, 'seed')
  .addSubFlowChart('sf-agent', agent.toFlowChart(), 'Agent', {
    inputMapper: () => ({ prompt: 'Hello' }),
  })
  .build();
```

## getSubtreeSnapshot — Snapshot Navigation

Navigate the execution snapshot tree by subflow path. Useful for LLM drill-down: instead of dumping the full trace, fetch only the relevant subtree.

```typescript
import { getSubtreeSnapshot, type RuntimeSnapshot } from 'footprintjs';

// Application boundary: pass a completed executor.getSnapshot() result.
function paymentDetails(snapshot: RuntimeSnapshot) {
  const payment = getSubtreeSnapshot(snapshot, 'sf-payment');
  // payment?.executionTree → the payment subflow's execution tree, if present
  // payment?.sharedState   → the payment subflow's scope state, if present
  const validation = getSubtreeSnapshot(snapshot, 'sf-payment/sf-validation');
  return { payment, validation };
}
```

Subflow paths use slash-separated subflow IDs, matching how footprintjs stores nested subflow results internally. Returns `undefined` if the path is not found.

---

## Dependency Graph

```
  FlowChartExecutor ── options · attach · resume · checkpoint · snapshot
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
