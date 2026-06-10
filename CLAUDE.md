# footprint.js — AI Coding Instructions

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection (narrative, metrics, manifest, identity) happens as side effects of the single DFS traversal pass. Never walk the tree again after execution.

## Architecture — Library of Libraries

```
src/lib/
├── capture/   → Value-capture/retention primitives (RetentionPolicy 'full'|'summary'|'off', read/write summary markers) — shared by the readTracking (#14) + writeTracking (#13c-A) dials; RFC-001 builds on it
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer, EventLog)
├── schema/    → Validation abstraction (Zod optional, duck-typed detection)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart(), DeciderList, SelectorFnList)
├── scope/     → Per-stage facades + recorders + providers
├── reactive/  → TypedScope<T> deep Proxy (typed property access, $-methods, cycle-safe)
├── decide/    → decide()/select() decision evidence capture (filter + function)
├── recorder/  → CompositeRecorder, stores (KeyedStore/SequenceStore/BoundaryStateStore), CommitRangeIndex, composition primitives
├── pause/     → Pause/Resume (PauseSignal, FlowchartCheckpoint, PausableHandler)
├── engine/    → DFS traversal + narrative + 13 handlers
├── runner/    → High-level executor (FlowChartExecutor)
└── contract/  → I/O schema + OpenAPI generation
```

Dependency DAG: `capture (standalone leaf) <- memory <- scope <- reactive <- engine <- runner`, `schema <- engine`, `builder (standalone) -> engine`, `contract <- schema`, `decide -> scope`

Entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/trace'` — execution tracing: runtimeStageId, commitLog queries, causal chain, recorder stores (`KeyedStore`/`SequenceStore`/`BoundaryStateStore`), `CommitRangeIndex`, `TopologyRecorder`/`InOutRecorder`/`QualityRecorder`
- `import { ... } from 'footprintjs/advanced'` — engine internals (also re-exports trace)
- `import { ... } from 'footprintjs/zod'` — **opt-in** zod-based scope helpers (`defineScopeFromZod`, `defineScopeSchema`, `isScopeSchema`, `createScopeProxyFromZod`, `ZodScopeResolver`). zod is an OPTIONAL peer — the core never imports it, so import these here and add `zod` to your deps. (Moved off the core barrels in 8.0.0 — see CHANGELOG.)

## Key API

### TypedScope (Recommended)

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface LoanState {
  creditTier: string;
  amount: number;
  customer: { name: string; address: { zip: string } };
  tags: string[];
  approved?: boolean;
}

const chart = flowChart<LoanState>('Intake', async (scope) => {
  scope.creditTier = 'A';                    // typed write
  scope.amount = 50000;                       // typed write
  scope.customer.address.zip = '90210';       // deep write (updateValue)
  scope.tags.push('vip');                     // array copy-on-write (single push)
  scope.$batchArray('tags', (arr) => {        // O(1) batch: 1 clone + 1 commit
    arr.push('vip', 'premium', 'verified');
  });
  scope.approved = true;                      // optional field

  // $-prefixed escape hatches
  scope.$debug('checkpoint', { step: 1 });
  scope.$metric('latency', 42);
  const args = scope.$getArgs<{ requestId: string }>();
  const env = scope.$getEnv();
  scope.$break();                             // stop pipeline
}, 'intake')
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run({ input: { requestId: 'req-123' } });
```

### decide() / select() — Decision Evidence Capture

```typescript
import { decide, select } from 'footprintjs';

// Inside a decider function — auto-captures which values led to the decision
.addDeciderFunction('ClassifyRisk', (scope) => {
  return decide(scope, [
    { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approved', label: 'Good credit' },
    { when: (s) => s.creditScore > 600, then: 'manual-review', label: 'Marginal' },
  ], 'rejected');
}, 'classify-risk')

// Narrative: "It evaluated Rule 0 'Good credit': creditScore 750 gt 700, and chose approved."
```

### Builder

```typescript
import { flowChart, FlowChartBuilder } from 'footprintjs';

const chart = flowChart('Stage1', fn1, 'stage-1', { description: 'Description' })
  .addFunction('Stage2', fn2, 'stage-2', 'Description')
  .addDeciderFunction('Decide', deciderFn, 'decide', 'Route based on risk')
    .addFunctionBranch('high', 'Reject', rejectFn)
    .addFunctionBranch('low', 'Approve', approveFn)
    .setDefault('high')
    .end()
  .build();
```

Methods: `start()`, `addFunction()`, `addStreamingFunction()`, `addDeciderFunction()`, `addSelectorFunction()`, `addListOfFunction()`, `addPausableFunction()`, `addSubFlowChart()`, `addSubFlowChartNext()`, `loopTo()`, `contract()`, `build()`, `toSpec()`, `toMermaid()`

### ScopeFacade (Internal — use TypedScope for new code)

```typescript
scope.getValue('key')              // tracked read
scope.setValue('key', value)        // tracked write
scope.getArgs<T>()                 // frozen readonly input (NOT tracked)
scope.getEnv()                     // frozen execution environment (NOT tracked)
```

**Three access tiers:**
- `getValue`/`setValue` — mutable shared state, tracked in narrative
- `getArgs()` — frozen business input from `run({ input })`, NOT tracked
- `getEnv()` — frozen infrastructure context from `run({ env })`, NOT tracked. Returns `ExecutionEnv { signal?, timeoutMs?, traceId? }`. Auto-inherited by subflows. Closed type.

### Executor

```typescript
const executor = new FlowChartExecutor(chart);
// With options (preferred over positional params):
const executor = new FlowChartExecutor(chart, { scopeFactory: myFactory });
await executor.run({ input: data, env: { traceId: 'req-123' } });

executor.attachScopeRecorder(recorder)  // plug scope (data) observer
executor.attachFlowRecorder(r)          // plug flow observer
executor.attachCombinedRecorder(r)      // plug observer across all channels (routed by method-shape)
executor.attachEmitRecorder(r)          // plug emit observer
executor.enableNarrative()              // turn on the built-in combined narrative recorder
executor.getNarrativeEntries()          // structured entries with type/depth/stageName/stageId
executor.getSnapshot()                  // full memory state (includes recorder snapshots)
executor.setRedactionPolicy({})         // PII protection

// Pause/Resume — human-in-the-loop
executor.isPaused()               // true if last run paused
executor.getCheckpoint()          // JSON-safe checkpoint (store in Redis/Postgres/etc.)
executor.resume(checkpoint, input) // continue from checkpoint with human's answer
```

### Pause/Resume (Human-in-the-Loop)

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

const handler: PausableHandler<MyState> = {
  execute: async (scope) => {
    // Return data = pause. Return nothing = continue.
    return { question: `Approve $${scope.amount}?` };
  },
  resume: async (scope, input) => {
    scope.approved = input.approved;
  },
};

// Pausable root stage (single-stage subflows):
const chart = flowChart<MyState>('Approve', handler, 'approve').build();

// Or chained after other stages:
const chart2 = flowChart<MyState>('Seed', seedFn, 'seed')
  .addPausableFunction('Approve', handler, 'approve')
  .addFunction('Process', processFn, 'process')
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run();

if (executor.isPaused()) {
  const checkpoint = executor.getCheckpoint(); // JSON-safe, store anywhere
  // Later (hours, different server):
  await executor.resume(checkpoint, { approved: true });
}
```

- `execute` returns data → pauses. Returns void → continues normally (conditional pause).
- Checkpoint is JSON-serializable — no functions, no class instances.
- Checkpoint is **deep-copied at creation** (one `structuredClone` of every field) — fully detached from engine state. Mutating a checkpoint you hold cannot corrupt the engine, and a same-executor resume cannot mutate a checkpoint you already persisted. `resume()` clones the checkpoint in too — the engine never holds a reference to your object.
- `getSnapshot().sharedState` is a zero-copy LIVE view in production — treat as read-only. Dev mode (`enableDevMode()`) returns a deep-frozen clone so consumer mutation throws.
- Checkpoints never capture recorder state: CROSS-executor resume (fresh executor from a stored checkpoint) starts with empty narrative — collect what you need before discarding the paused executor. SAME-executor resume preserves and accumulates narrative/recorder state (`preserveRecorders`). A fresh `runId` is generated for the resumed run either way.
- `FlowRecorder.onPause`/`onResume` and `Recorder.onPause`/`onResume` fire on both observer systems.

### ComposableRunner & Snapshot Navigation

```typescript
import type { ComposableRunner } from 'footprintjs';
import { getSubtreeSnapshot, listSubflowPaths } from 'footprintjs';

const subtree = getSubtreeSnapshot(snapshot, 'sf-payment');
listSubflowPaths(snapshot); // ['sf-payment', 'sf-outer/sf-inner']
```

## Observer Systems — three channels, one model

Three pluggable observer channels. All use the same dispatcher pattern
(`{ id, hooks } -> dispatcher -> error isolation -> attach/detach`).
Intentionally NOT unified into one giant interface — each channel has
a distinct invariant set.

**Recorder ID contract:**
- Every `attach*Recorder` call (`attachScopeRecorder` / `attachFlowRecorder` / `attachEmitRecorder` / `attachCombinedRecorder`) is **idempotent by ID** — same ID replaces, different IDs coexist. Prevents accidental double-counting.
- Built-in recorders use auto-increment default IDs (`metrics-1`, `debug-1`, ...) so multiple instances with different configs coexist naturally.
- Frameworks that auto-attach recorders should use a well-known ID (e.g., `new MetricRecorder('metrics')`) so the consumer can override it by passing the same ID, or add a second instance with `new MetricRecorder()` (gets unique ID).

**Delivery tiers (RFC-001):** every `attach*Recorder` accepts an options bag — `{ delivery: 'deferred', capture?, maxQueue?, overflow?, flushBudgetMs? }` (CombinedRecorder also honors the field form `{ id, delivery: 'deferred', ...hooks }`). Deferred observers are captured into ONE bounded, totally-ordered queue per executor (lazy — zero alloc without opt-in) and delivered at the next microtask checkpoint, "one beat behind"; the queue drains synchronously at run resolve/reject/pause (terminal flush) and `executor.drainObservers({timeoutMs})` settles async listeners. Capture happens strictly AFTER redaction at each dispatch site. Accounting: `snapshot.observerStats` (absent without opt-in). Default capture policy `'summary'` hands hooks a bounded `PayloadSummary` — use `'clone'` for inline-shape parity. Wiring lives in `runner/DeferredObserverTier.ts`; the pure pipeline in `lib/observer-queue/` + `lib/capture/envelope.ts` stays engine-import-free (the engine imports IT, never the reverse). Guide: [docs/guides/observers-deferred.md](docs/guides/observers-deferred.md).

**Scope Recorder** (`ScopeRecorder`; data ops — fires DURING stage execution):
- `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`, `onPause`/`onResume`, `onEmit`
- Built-in: `MetricRecorder`, `DebugRecorder`

**FlowRecorder** (control flow — fires AFTER stage execution):
- `onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onSelected`, `onSubflowEntry/Exit`, `onSubflowRegistered`, `onLoop`, `onBreak`, `onError`, `onPause`/`onResume`, `onRunStart`/`onRunEnd`, `onRunFailed` (terminal counterpart to `onRunEnd` — closes the run boundary on error)
- All events carry `traversalContext: TraversalContext`
- `onDecision`/`onSelected` carry optional `evidence` from decide()/select()
- **`onStageExecuted` fires UNIFORMLY for every stage kind** (linear / decider / fork / selector / subflow-mount) as of v6.0+ proposal #003. Event payload carries `stageType: 'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'`. Specialized events (`onDecision`/`onFork`/`onSelected`/`onSubflowEntry`) STILL fire — `onStageExecuted` is the universal "did this stage run" signal AFTER them.
- Built-in: 9 strategies (Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest, Silent)

**StructureRecorder** (build-time chart shape — fires SYNCHRONOUSLY during builder operations, NOT runtime):
- `onStageAdded`, `onEdgeAdded`, `onLoopEdgeAdded`, `onDeciderComplete`, `onSubflowMounted`
- Attach via options bag: `flowChart('seed', fn, 'seed', { structureRecorders: [rec] })` OR fluent `.attachStructureRecorder(rec)`.
- **MOUNT-ONLY contract**: a recorder attached to a builder receives ONLY that builder's events. Subflow internals fire to THEIR builder's recorder, not the parent's. The mount event delivers the full subflow context via `subflowSpec` + `subflowPath` (proposal #001) — consumers walk it via `walkSubflowSpec` from `footprintjs/trace`.
- `StructureRecorder` + 6 event types now exported from the main `footprintjs` barrel (also available from `footprintjs/advanced`).

**EmitRecorder** (consumer-emitted events — third channel, see "Emit Channel" section below).

**CombinedRecorder** is a union shape that routes by runtime method-shape detection — implement only the hooks you care about across all three channels; one `attachCombinedRecorder` call. `CombinedNarrativeRecorder` is the canonical built-in; attach via `chart.recorder(narrative())` (the chart's `.recorder()` sugar) or `executor.attachCombinedRecorder(narrative())`.

**Stage type discrimination on `onStageExecuted`** — under proposal #003, consumers wanting linear-only behavior must filter:
```ts
onStageExecuted(event) {
  if (event.stageType && event.stageType !== 'linear') return;  // ignore decider/fork/selector/subflow-mount
  // ... linear-stage logic
}
```
Built-in `NarrativeFlowRecorder` and `CombinedNarrativeRecorder` already gate this way — narrative output is byte-stable across the v6 transition.

## Event Ordering

```
1. Recorder.onStageStart        — stage begins
2. Recorder.onRead/onWrite      — DURING execution (buffered per-stage)
3. Recorder.onCommit            — transaction flush
4. Recorder.onStageEnd          — stage completes
5. FlowRecorder.onStageExecuted — CombinedNarrativeRecorder flushes buffered ops (LINEAR-only here; non-linear gated to specialized handlers — see above)
6. FlowRecorder.onNext/onDecision/onFork/onSelected — control flow events
7. FlowRecorder.onStageExecuted (with stageType !== 'linear') — fires for decider/fork/selector/subflow-mount AFTER the specialized event above
```

## Execution Tracing (`footprintjs/trace`)

Every stage execution gets a unique `runtimeStageId` — the universal key that links recorder events, commit log entries, and execution tree nodes.

**When to use:** Debugging (which stage set a value to something unexpected?), audit trails (trace every write to its source stage), custom recorders (correlate events with specific execution steps), quality trace backtracking (walk backwards to find where data quality dropped).

**Format:** `[subflowPath/]stageId#executionIndex`

```
seed#0                              — root stage
call-llm#5                          — 5th execution step
sf-tools/execute-tool-calls#8       — subflow stage
call-llm#9                          — same stageId, different execution (loop)
```

**The commitLog:** An ordered array of `CommitBundle` — one per stage commit, recording what each stage wrote to shared state. Get it from `executor.getSnapshot().commitLog`.

```typescript
import { parseRuntimeStageId, findLastWriter, findCommit } from 'footprintjs/trace';

// Parse a runtimeStageId into components
parseRuntimeStageId('sf-tools/execute-tool-calls#8');
// → { stageId: 'execute-tool-calls', executionIndex: 8, subflowPath: 'sf-tools' }

// Get the commit log after execution
const snapshot = executor.getSnapshot();
const commitLog = snapshot.commitLog; // CommitBundle[]

// Backtrack: who last wrote 'systemPrompt' before commitLog array index 8?
// beforeIdx is the CommitBundle.idx (array position), NOT the executionIndex from runtimeStageId.
const writer = findLastWriter(commitLog, 'systemPrompt', 8);
// → CommitBundle | undefined (has .stage, .stageId, .runtimeStageId, .trace, .overwrite, .updates)

// Find by stageId: use findCommit when you know the stage.
// Use findLastWriter when you know the key but not which stage wrote it.
const llmCommit = findCommit(commitLog, 'call-llm', 'adapterRawResponse');
```

**Exports from `footprintjs/trace`:**

| Export | Returns | Use |
|--------|---------|-----|
| `buildRuntimeStageId(stageId, idx, subflowPath?)` | `string` | Construct an ID from components |
| `parseRuntimeStageId(id)` | `{ stageId, executionIndex, subflowPath }` | Decompose a runtimeStageId. `stageId` is LOCAL (not the full-prefixed form on `spec.id`) — use `splitStageId` for those |
| `splitStageId(prefixedStageId)` | `{ localStageId, subflowPath }` | Decompose a bare prefixed id (`spec.id`, `CommitBundle.stageId`, segment of `runtimeStageId` before `#`). Mirrors `parseRuntimeStageId`'s decomposition rule. Added in #002 |
| `walkSubflowSpec(spec, subflowPath, opts?)` | `Generator<WalkerItem>` | Walk a subflow spec delivered on `StructureSubflowMountedEvent.subflowSpec`. Yields `subflow-start` marker first, then `stage`/`edge`/`loop`/`subflow` items mirroring Structure event payload shapes. Auto-recurses with composed paths; `{recurse:false}` for single-level. Added in #001 |
| `findCommit(commitLog, stageId, key?)` | `CommitBundle \| undefined` | Find first commit by stageId |
| `findCommits(commitLog, stageId)` | `CommitBundle[]` | Find all commits by stageId |
| `findLastWriter(commitLog, key, beforeIdx?)` | `CommitBundle \| undefined` | Search backwards for who wrote a key |
| `causalChain` / `flattenCausalDAG` / `formatCausalChain` | functions | Backward program slicing over the commit-log DAG |
| `KeyedStore<T>` | class | **Primary** 1:1 Map store — own as a field on your recorder |
| `SequenceStore<T>` | class | **Primary** 1:N ordered store (has `getEntryRanges()` for O(1) time-travel) |
| `BoundaryStateStore<T>` | class | **Primary** transient bracket-scoped state store |
| `CommitRangeIndex<TLabel>` | class | Interval index over commit indices (`open`/`close`/`enclosing`/`overlapping`) |
| `topologyRecorder()` / `TopologyRecorder` | factory / class | Live composition graph for streaming consumers (subflow nodes + control-flow edges) |
| `inOutRecorder()` / `InOutRecorder` | factory / class | Chart in/out stream — `entry`/`exit` pairs at every chart boundary (top-level run + every subflow) |
| `QualityRecorder` + `qualityTrace`/`formatQualityTrace` | class / functions | Per-step quality scoring + Quality Stack Trace backtracking |

### TopologyRecorder — Composition Graph for Streaming Consumers

**One-liner:** reconstructs a live, queryable mini-flowchart of what your run actually traced, built from the 3 primitive recorder channels during traversal.

**Mental model:**

```
flowChart() builder      →  STATIC flowchart (design-time definition)
                                       │
                                       ▼ executor runs it
                         Traversal emits events on 3 channels:
                            Recorder · FlowRecorder · EmitRecorder
                                       │
                                       ▼ TopologyRecorder listens
                         DYNAMIC flowchart (runtime shape):
                            Nodes = composition points
                               (subflow / fork-branch / decision-branch)
                            Edges = transitions
                               (next / fork / decision / loop)
                            Queryable any moment — during or after run
```

**What it IS:**
- Live composition graph derived from 3 primitive channels
- Each node = one composition-significant moment (subflow entered, fork child, decision chosen)
- Each edge = a control-flow transition, timestamped with `runtimeStageId`
- Works identically during or after a run

**What it ISN'T:**
- Not a full execution tree — that's `StageContext` / `executor.getSnapshot()`
- Not per-stage data — that's `MetricRecorder` / a custom recorder composing `KeyedStore<T>`
- Not agent-specific — agentfootprint composes it; footprintjs owns it

**Why live consumers need it:** The executor already has the topology internally (execution tree in `StageContext`). But streaming consumers can't access that tree mid-run — they only see events. `TopologyRecorder` = "the tree, reconstructed from events, live-queryable."

Fills the gap between "post-run snapshot (full tree available)" and "live event stream (only point observations)." Attach once; query `getTopology()` anytime during or after a run.

```typescript
import { topologyRecorder } from 'footprintjs/trace';

const topo = topologyRecorder();
executor.attachCombinedRecorder(topo); // auto-routes to FlowRecorder channel

await executor.run({ input });

const { nodes, edges, activeNodeId, rootId } = topo.getTopology();
topo.getSubflowNodes();          // agent-centric view
topo.getByKind('fork-branch');   // all parallel branches
topo.getParallelSiblings(id);    // siblings of a parallel branch
```

**Three node kinds — complete composition coverage:**

| Kind | Fires on | Represents |
|---|---|---|
| `subflow` | `onSubflowEntry` | Mounted subflow boundary (with stable `subflowId`) |
| `fork-branch` | `onFork` (synthesized one per child) | One branch of a parallel split — works for plain stages AND subflows |
| `decision-branch` | `onDecision` (synthesized for chosen) | The chosen branch of a conditional |

When a fork-branch or decision-branch target is also a subflow, the subsequent `onSubflowEntry` creates a subflow CHILD of the synthetic node. Layered shape preserves both "who branched" and "what the branch ran."

**Edges:** one per control-flow transition. `edge.kind ∈ 'next' | 'fork-branch' | 'decision-branch' | 'loop-iteration'`. Each carries `at: runtimeStageId` for time correlation.

**Correlation rules:**
- `onFork({ parent, children })` → N `fork-branch` nodes synthesized up-front; subsequent matching `onSubflowEntry` nests under the right fork-branch
- `onDecision({ chosen })` → `decision-branch` node synthesized up-front; matching `onSubflowEntry` nests under it
- Pending correlation clears on `onSubflowExit` so state doesn't leak across scopes
- `onLoop` → self-edge on the currently-active subflow (synthetic nodes don't participate)
- Re-entry of same `subflowId` (loop body) disambiguates via `id#n` suffix

**What it does NOT track:** plain sequential stages. Use `MetricRecorder` / `StageContext` for per-stage data. Topology is a graph of control-flow branching, not a full execution tree.

**For downstream libraries:** compose, don't duplicate. An agent-shaped recorder should wrap a `topologyRecorder()` internally and translate topology nodes into agent semantics — not re-implement subflow-stack + fork + decision tracking.

Example: [examples/runtime-features/flow-recorder/06-topology.ts](examples/runtime-features/flow-recorder/06-topology.ts)

### InOutRecorder — Chart In/Out Stream (every chart boundary, root + subflows)

**One-liner:** captures every chart execution (top-level run AND every subflow) as an `entry`/`exit` boundary pair, with the `inputMapper`/`outputMapper` payloads attached. Combined with `TopologyRecorder` (composition shape) this gives downstream layers the universal "step" primitive — `runtimeStageId` binds them.

**Mental model:**

```
   user input ─►┌───────────────── run ─────────────────┐ ◄─ user output
                │  __root__#0   onRunStart / onRunEnd   │
                │                                        │
                │   inputMapper          outputMapper    │
                │       │                     │          │
                │  parent ──►┤ subflow ├──► parent       │
                │       │                     │          │
                │       └── runtimeStageId ───┘          │
                │                                        │
                └────────────────────────────────────────┘
```

Each chart execution → 2 boundaries:
- **Root** — `onRunStart` / `onRunEnd` fire ONCE per `executor.run()`. `subflowId: '__root__'`, `depth: 0`, `isRoot: true`.
- **Subflow** — `onSubflowEntry` / `onSubflowExit` fire once per mounted subflow. Nested under root in the path tree (`['__root__', 'sf-x']`, depth 1+).

Loop re-entry produces distinct pairs because the parent stage's executionIndex increments.

**What it IS:**
- composes `SequenceStore<InOutEntry>` — flat ordered list + per-`runtimeStageId` index
- Captures the **payloads** at every chart boundary (what flowed IN and OUT)
- Path-aware: `subflowPath` is decomposed from the engine's path-prefixed `subflowId` and rooted under `__root__`
- Domain-agnostic — knows nothing about LLMs, tools, agents

**What it ISN'T:**
- Not a composition graph — that's `TopologyRecorder` (shape) vs this (data crossing each boundary)
- Not a full execution tree — that's `StageContext`
- Not agent-specific — domain libraries (e.g. agentfootprint) compose it; footprintjs owns it

```typescript
import { inOutRecorder, ROOT_SUBFLOW_ID } from 'footprintjs/trace';

const inOut = inOutRecorder();
executor.attachCombinedRecorder(inOut);

await executor.run({ input });

inOut.getSteps();                    // entry boundaries (timeline; root is first step)
inOut.getBoundary(runtimeStageId);   // { entry, exit } pair for one execution
inOut.getRootBoundary();             // { entry, exit } for the top-level run
inOut.getBoundaries();               // flat list (entry+exit interleaved)
inOut.getEntryRanges();              // O(1) per-step range index for time-travel
```

**`InOutEntry` shape:**

| Field | Description |
|---|---|
| `runtimeStageId` | Same value for the entry/exit pair of one execution. Top-level run uses `'__root__#0'`. |
| `subflowId` | Path-prefixed engine id. Top-level → `'__root__'`. Subflow → `'sf-outer'` or `'sf-outer/sf-inner'`. |
| `localSubflowId` | Last segment of `subflowId` |
| `subflowName` | Human-readable display name (`'Run'` for the top-level run) |
| `description` | Build-time description (carries taxonomy markers like `'Agent: ReAct loop'`). Undefined for root. |
| `subflowPath` | Decomposition of `subflowId` rooted under `__root__`: `['__root__']` for root, `['__root__', 'sf-x']` for top-level subflow |
| `depth` | Root → 0. First-level subflow → 1. |
| `phase` | `'entry'` or `'exit'` |
| `payload` | `entry`: `inputMapper` result (subflow) or `run({input})` (root); `exit`: shared state at exit (subflow) or chart return value (root) |
| `isRoot` | True only for the synthetic root pair from `onRunStart` / `onRunEnd` |

**Pause semantics:** when a stage pauses inside a subflow, the engine re-throws without firing `onSubflowExit` (or `onRunEnd`). The chart has an `entry` with no matching `exit` until resume completes. `getBoundary()` returns `{ entry, exit: undefined }` in that case.

**Engine events:** `FlowRecorder.onRunStart(event)` and `onRunEnd(event)` carry `event.payload` (the run's input or output). Fire ONCE per top-level `executor.run()` — not for subflow traversers (those fire `onSubflowEntry`/`onSubflowExit` instead). Available on the `IControlFlowNarrative` interface and the `FlowRecorderDispatcher`.

**For downstream libraries:** compose, don't duplicate. A domain-flavored step graph (e.g., agentfootprint's `StepGraph`) should consume `InOutRecorder` output and label each entry by inspecting the payload through domain semantics — not re-walk subflow events.

Example: [examples/runtime-features/flow-recorder/07-inout.ts](examples/runtime-features/flow-recorder/07-inout.ts)

**Three storage primitives (the v5 recorder model)** — choose by data shape. A recorder OWNS a store as a field and implements its channel interface (Convention 1 — "one purpose per recorder"). There are NO abstract base classes; composition is the only model.

| Store | Relationship | Use When |
|-------|-------------|----------|
| `KeyedStore<T>` | 1:1 Map | Each step produces one record (MetricRecorder, TokenRecorder) |
| `SequenceStore<T>` | 1:N sequence + Map | Multiple records per step, ordering matters (CombinedNarrativeRecorder) |
| `BoundaryStateStore<T>` | bracket-scoped state | Live transient state during a `[start, stop]` event interval |

```typescript
import { KeyedStore, SequenceStore } from 'footprintjs/trace';
import type { ScopeRecorder } from 'footprintjs';

// KeyedStore: one entry per step
class TokenRecorder implements ScopeRecorder {
  readonly id = 'tokens';
  private readonly store = new KeyedStore<TokenEntry>();
  onLLMCall(event) { this.store.set(event.runtimeStageId, { tokens: event.usage }); }

  getForStep(id) { return this.store.get(id); }                                         // Translate: per-step value
  getTotal() { return this.store.aggregate((sum, e) => sum + e.tokens, 0); }            // Aggregate: grand total
  getUpTo(keys) { return this.store.accumulate((sum, e) => sum + e.tokens, 0, keys); }  // Accumulate: up to slider
  clear() { this.store.clear(); }
}

// SequenceStore: multiple entries per step, ordered
class AuditRecorder implements ScopeRecorder {
  readonly id = 'audit';
  private readonly store = new SequenceStore<AuditEntry>();
  onRead(event) { this.store.push({ runtimeStageId: event.runtimeStageId, type: 'read', key: event.key }); }

  getForStep(id) { return this.store.getByKey(id); }                       // Translate: per-step entries
  getCount() { return this.store.aggregate((count, _) => count + 1, 0); }  // Aggregate: grand total
  getUpTo(keys) { return this.store.getEntriesUpTo(keys); }                // Progressive: up to slider
  getRanges() { return this.store.getEntryRanges(); }                      // Range index: O(1) slider sync
  clear() { this.store.clear(); }
}
```

**`getEntryRanges()`** returns a precomputed `Map<runtimeStageId, {firstIdx, endIdx}>` maintained during `push()`. Use for O(1) per-step range lookups during time-travel scrubbing. Same shape as `buildEntryRangeIndex()` in `footprint-explainable-ui`.

**`CombinedNarrativeEntry.direction`** — subflow entries carry `direction: 'entry' | 'exit'`. Use for programmatic subflow boundary detection instead of text scanning (which breaks with custom `NarrativeRenderer`).

**`footprint-explainable-ui` narrative utilities** — for consumers building custom shells without `ExplainableShell`:
- `buildEntryRangeIndex(entries)` — build range index from flat array (when no recorder access)
- `computeRevealedEntryCount(entries, snapshots, idx, rangeIndex?)` — slider position → entry count
- `extractSubflowNarrative(entries, subflowId)` — three-tier subflow entry extraction

**How runtimeStageId is generated:** A counter starts at 0 and increments by 1 for each stage execution across the entire run, including subflow stages. Subflow child traversers share the parent counter so indices are globally unique. Stages inside subflows have stageIds already prefixed by the builder (e.g., `sf-tools/execute-tool-calls`), so `buildRuntimeStageId` just appends `#index`.

## Dev Mode

One global flag (`enableDevMode()` / `disableDevMode()` / `isDevMode()`) controls every developer-only diagnostic across the library. OFF by default — production pays zero overhead.

```ts
import { enableDevMode } from 'footprintjs';
if (process.env.NODE_ENV !== 'production') enableDevMode();
```

Gated diagnostics:
- **Circular-ref detection** in `ScopeFacade.setValue()` — O(n) WeakSet traversal per write
- **Empty-recorder warning** in `attachCombinedRecorder(r)` — catches `r` with no `on*` handler
- **Suspicious predicates** in `decide()` / `select()`
- **Snapshot integrity** in `getSubtreeSnapshot()`
- **Snapshot mutation guard** in `FlowChartExecutor.getSnapshot()` — `sharedState` becomes a deep-frozen CLONE (mutation throws); production returns the zero-copy live view (treat as read-only)

Convention: when adding a new dev-only check, gate on `isDevMode()` (from `scope/detectCircular.ts`). Do NOT use `process.env.NODE_ENV` inline — consumers control dev tooling centrally via `enableDevMode()`/`disableDevMode()`, and inline env checks break that contract.

## Break + Propagation

`scope.$break(reason?)` takes an optional free-form reason string that surfaces on `FlowBreakEvent.reason`. Recorders and narrative consumers see it.

By default, an inner subflow's `$break` stops ONLY the subflow; the parent continues. Opt into propagation via `SubflowMountOptions.propagateBreak: true`:

```ts
builder.addSubFlowChartNext('sf-escalate', escalateChart, 'Escalate', {
  inputMapper: ..., outputMapper: ...,
  propagateBreak: true,  // ← inner $break → parent $break, with reason
});
```

Semantics:
- **Linear chain:** inner `$break(reason)` → parent's `breakFlag` flips → next parent stage does NOT run → `FlowBreakEvent` fires at parent-mount level with `propagatedFromSubflow` + reason.
- **Nested chain:** propagates through every hop that opted in. Reason survives.
- **outputMapper still runs** before propagation — subflow's partial state lands in parent before the break. Escape hatch: early-return `{}` from outputMapper when the break state is set.
- **Parallel/fan-out:** existing ChildrenExecutor rule applies — parent breaks only when ALL fork children broke. `propagateBreak: true` on a single child contributes to that count; doesn't terminate the fork alone.

Example: [examples/runtime-features/break/04-subflow-propagate.ts](examples/runtime-features/break/04-subflow-propagate.ts).

## Parallel Fan-Out Error Semantics (`failFast`)

When a selector picks ≥2 branches — or `addListOfFunction` lists several — they run **in parallel** via `ChildrenExecutor`. One branch throwing has two meanings; the **fan-out node's `failFast` flag** picks which:

- **DEFAULT** (`failFast` unset/false) → `Promise.allSettled`: best-effort. A branch error is **collected, not rethrown**; every sibling finishes, the run **resolves**, and the post-fan-out convergence stage still runs.
- **`failFast: true`** → `Promise.all`: the **first** branch error **rejects the whole run** (aborts before convergence). Use when every selected branch is **REQUIRED**.

**The footgun:** under the default, a *required* parallel branch that throws is **silently swallowed** — the run resolves with a half-built result (this is exactly what swallowed a failing Tools slot in the agent request-assembly fork). Set `failFast: true` so the failure surfaces.

**Set it on the fan-out node** — honored uniformly across plain-function branches, **subflow** branches (`addSubFlowChartBranch`), and `addListOfFunction`:

```ts
flowChartSelector('Pick', selectorFn, 'pick', { failFast: true })          // root selector
builder.addSelectorFunction('Pick', selectorFn, 'pick', 'desc', { failFast: true })  // mid-chain (5th arg)
builder.addListOfFunction([...], { failFast: true })                        // bare parallel list
```

Defaults to `false` everywhere — existing charts are unchanged. `failFast` (a branch *threw*) is orthogonal to `$break` (a branch *chose* to stop). Full guide: [docs/guides/error-handling.md](docs/guides/error-handling.md#parallel-fan-out-error-semantics). Example: [examples/runtime-features/parallel/01-failfast.ts](examples/runtime-features/parallel/01-failfast.ts).

## Emit Channel (Phase 3)

Third observer channel alongside `Recorder` (data-flow) and `FlowRecorder` (control-flow). Consumer stage code emits structured events; `EmitRecorder.onEmit(event)` fires synchronously with auto-enriched context.

```ts
import type { EmitRecorder, EmitEvent } from 'footprintjs';

// Inside a stage:
scope.$emit('myapp.llm.tokens', { input: 100, output: 50 });

// Recorder observes:
const rec: EmitRecorder = {
  id: 'token-meter',
  onEmit: (e) => { if (e.name === 'myapp.llm.tokens') tally(e.payload); },
};
executor.attachEmitRecorder(rec);
```

### Semantics
- **Pass-through.** Delivered synchronously, in call order. Zero allocation when no recorder attached (fast-path in `ScopeFacade.emitEvent`).
- **Auto-enriched.** Events carry `stageName`, `runtimeStageId`, `subflowPath`, `pipelineId`, `timestamp` — parsed from `runtimeStageId` for subflow context.
- **Error-isolated.** A throwing `onEmit` doesn't propagate; errors route to `onError` on other recorders.
- **Redactable.** `RedactionPolicy.emitPatterns: RegExp[]` matches `event.name`; matched payloads become `'[REDACTED]'` before dispatch.
- **Buffered in narrative.** `CombinedNarrativeRecorder.onEmit` buffers alongside reads/writes; flushed in `flushOps` so emit entries appear AFTER the stage header in ordered narrative.

### Naming convention
Hierarchical dotted names — `<namespace>.<category>.<event>`. Examples:
- `'agentfootprint.llm.tokens'`, `'agentfootprint.llm.request'`
- `'myapp.billing.spend'`, `'myapp.auth.check'`

### Legacy primitives route through this channel
`$debug`, `$metric`, `$error`, `$eval`, `$log` also dispatch on the emit channel (in addition to their existing `DiagnosticCollector` side-bag writes for snapshot inclusion):

```
$debug(key, value)    → emits 'log.debug.${key}'
$error(key, value)    → emits 'log.error.${key}'
$metric(name, value)  → emits 'metric.${name}'
$eval (name, value)   → emits 'eval.${name}'
```

This closes the long-standing gap where `$metric` / `$debug` went to side bags no recorder observed. Backward-compat: the side bags still populate for consumers that inspect snapshots directly.

### Customizing narrative rendering
`NarrativeFormatter.renderEmit?(ctx)` hook renders an emit event into a narrative line. Return `string` to use, `null` to exclude, `undefined` to fall back to the default `[emit] name: payloadSummary`.

Example: [examples/runtime-features/emit/01-custom-events.ts](examples/runtime-features/emit/01-custom-events.ts).

## Detach — Fire-and-Forget Child Flowcharts (`footprintjs/detach`)

Schedule a child chart on a chosen **driver** without blocking the parent stage. Two semantics + two surfaces:

| Method                                | Returns        | Caller                                   |
|---------------------------------------|----------------|------------------------------------------|
| `scope.$detachAndJoinLater(d, c, i)`  | `DetachHandle` | Inside a stage (refId = stage's runtimeStageId) |
| `scope.$detachAndForget(d, c, i)`     | `void`         | Inside a stage (handle discarded)        |
| `executor.detachAndJoinLater(d, c, i)`| `DetachHandle` | Outside any chart (refId prefix `__executor__`) |
| `executor.detachAndForget(d, c, i)`   | `void`         | Outside any chart                        |

```ts
import { microtaskBatchDriver } from 'footprintjs/detach';

flowChart('process', async (scope) => {
  scope.result = await heavyWork();
  scope.$detachAndForget(microtaskBatchDriver, telemetryChart, { event: 'done' });
}, 'process').build();
```

**Built-in drivers** (more in v4.17.1):
- `microtaskBatchDriver` — coalesces N detaches into one `queueMicrotask` flush. Default for in-process.
- `immediateDriver` — runs sync inside `schedule()`. Test fixture / debugging aid.

**Custom drivers**: `createMicrotaskBatchDriver(runChild)` / `createImmediateDriver(runChild)` accept a custom `ChildRunner` so consumers can wrap the executor (e.g., for tracing context). Drivers are **passed explicitly** as the first arg — no library-default to keep the engine free of driver imports.

**Handle**: `{ id, status: 'queued'|'running'|'done'|'failed', result?, error?, wait() }`. NOT Promise-shaped (no `.then()` — defeats fire-and-forget). Status is sync property; `wait()` returns a CACHED Promise on every call.

**Graceful shutdown**: `flushAllDetached({ timeoutMs })` drains every in-flight handle to terminal. Use in SIGTERM handlers / test cleanup. Returns `{ done, failed, pending }` — `pending === 0` means full drain.

**Gotcha**: don't store handles in shared state — `StageContext.setValue` calls `structuredClone`, which drops the handle's class prototype (and `.wait()` method). Keep handles in closure-local variables. The builder-native `addDetachAndJoinLater` enforces this by delivering the handle to a consumer-supplied `onHandle` callback rather than to a shared-state key.

**Builder-native composition** — make detach a labeled chart stage (visible in narrative + visualizations):

```ts
const handles: DetachHandle[] = [];
const chart = flowChart('process', processFn, 'process')
  .addDetachAndForget('telemetry', telemetryChart, {
    driver: microtaskBatchDriver,
    inputMapper: (scope) => ({ event: 'processed', orderId: scope.orderId }),
  })
  .addDetachAndJoinLater('eval', evalChart, {
    driver: microtaskBatchDriver,
    inputMapper: (s) => s.input,
    onHandle: (h) => handles.push(h),
  })
  .addFunction('join', async (scope) => {
    const settled = await Promise.all(handles.map((h) => h.wait()));
    scope.results = settled.map((r) => r.result);
  }, 'join')
  .build();
```

Pure sugar over `addFunction` — zero engine changes. For server-side concurrent runs, allocate a fresh `handles` closure per run (factory-build the chart) so handles don't bleed across requests.

Examples: [examples/runtime-features/detach/](examples/runtime-features/detach/) — 7 scenarios (telemetry, fan-out, bare-executor, immediate driver, error handling, status polling, graceful shutdown).

## Combined Recorder

A `CombinedRecorder` is an observer that hooks into multiple event streams (scope data-flow, control-flow, AND emit — all three channels). One object, one `id`, one `attachCombinedRecorder()` call — the library routes to the right channels via runtime method-shape detection.

```ts
import type { CombinedRecorder } from 'footprintjs';
import { isFlowEvent } from 'footprintjs';

const audit: CombinedRecorder = {
  id: 'audit',
  onWrite: (e) => log('scope write', e.key),       // Recorder stream
  onDecision: (e) => log('routed to', e.chosen),   // FlowRecorder stream
  onError: (e) => {
    // Shared method — union payload. Discriminate with isFlowEvent():
    if (isFlowEvent(e)) log('flow error in', e.stageName);
    else log('scope error during', e.operation);
  },
};

executor.attachCombinedRecorder(audit);
```

Built on `CombinedRecorder`: `CombinedNarrativeRecorder` (the `executor.enableNarrative()` default). Consumers implement ONLY the events they care about — `Partial<ScopeRecorder> & Partial<FlowRecorder> & Partial<EmitRecorder>` under the hood.

**Detection rule:** only OWN event-method properties count (prototype methods are ignored for security — prevents accidental `Object.prototype` pollution from attaching handlers).

## Anti-Patterns

- Never post-process the tree — use recorders
- Don't use `getValue()`/`setValue()` in TypedScope stages — use typed property access
- Don't use `$`-prefixed state keys (e.g., `$break`) — they collide with ScopeMethods
- Don't use deprecated `CombinedNarrativeBuilder` — use `CombinedNarrativeRecorder`
- Don't extract shared base for ScopeRecorder/FlowRecorder — two instances = coincidence
- Don't use `getArgs()` for tracked data — use typed scope properties
- Don't put infrastructure data in `getArgs()` — use `getEnv()` via `run({ env })`
- Don't manually create `CombinedNarrativeRecorder` — `chart.recorder(narrative())` (or `executor.attachCombinedRecorder(narrative())`) handles it
- Don't return full arrays from `outputMapper` without `arrayMerge: ArrayMergeMode.Replace` — default `applyOutputMapping` **concatenates** arrays (`[...parent, ...subflow]`). Either return only the **delta** (new items), or set `arrayMerge: ArrayMergeMode.Replace` on `SubflowMountOptions` to overwrite instead of concatenate. Scalars are always replaced regardless.

## Project conventions (5.0+)

### Convention 1 — One purpose per recorder

A recorder owns exactly ONE concern (storage, OR event ingestion, OR state machine, OR projection). Multi-concern recorders MUST be decomposed into single-purpose pieces and composed via a thin facade.

Use composition: own a `SequenceStore<T>` / `KeyedStore<T>` / `BoundaryStateStore<T>` field, implement the relevant `ScopeRecorder` / `FlowRecorder` / `EmitRecorder` / `CombinedRecorder` interface, delegate event handling to internal helpers, delegate storage to the store. See `examples/recorders/` for canonical patterns.

Composition is the ONLY recorder model. The abstract base classes (`SequenceRecorder`, `KeyedRecorder`, `BoundaryStateTracker`) were removed in 7.0.0 — there is no inheritance path. Every recorder (including the built-ins `MetricRecorder`, `QualityRecorder`, `InOutRecorder`, `CombinedNarrativeRecorder`) owns a store as a field.

### Convention 2 — Examples are mandatory integration tests

Every library-surface change MUST include:

1. Unit tests (per-pattern coverage, all 7 test types — see Convention 3).
2. **Integration tests via `examples/`** — runnable end-to-end demos that exercise the feature in realistic scenarios. Each example file is treated as part of the test suite.
3. Documentation update (relevant README + `CLAUDE.md` if architectural).

PRs without all three are incomplete. Examples are not optional polish — they ARE the integration-test layer that catches "works in unit tests, fails in real usage" bugs.

### Convention 3 — 7 test types per feature

Every new piece (each store, each recorder, each runtime feature) ships with the following test types. One test file per type when natural, or sections in one file for tightly-scoped primitives.

| Type | Asks |
|---|---|
| **Unit** | Does this single function/class behave correctly in isolation? |
| **Functional** | Does this feature work end-to-end on the happy path? |
| **Integration** | Do multiple components cooperate correctly? |
| **Property** | Does the invariant hold for ANY input (randomized fuzzing)? |
| **Security** | Does this protect against injection, leakage, redaction bypass? |
| **Performance** | Is the latency / memory within budget? |
| **Load** | Does it sustain throughput at scale? |

### Convention 4 — `runId` for per-run scoping

Every event the engine fires carries a `runId` in `traversalContext`. Generated fresh per `executor.run()` and per `executor.resume()`; shared across all events of one run; differs across consecutive runs of the same executor. Recorders that accumulate state across runs detect "new run" via `event.traversalContext.runId !== this.lastRunId` and reset transient bookkeeping. See `examples/runtime-features/run-id/`.

## Build & Test

```bash
npm run build    # tsc (CJS) + tsc -p tsconfig.esm.json (ESM)
npm test         # full suite
npm run test:unit
```

Dual output: CommonJS (`dist/`) + ESM (`dist/esm/`) + types (`dist/types/`)
