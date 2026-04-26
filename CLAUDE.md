# footprint.js — AI Coding Instructions

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection (narrative, metrics, manifest, identity) happens as side effects of the single DFS traversal pass. Never walk the tree again after execution.

## Architecture — Library of Libraries

```
src/lib/
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer, EventLog)
├── schema/    → Validation abstraction (Zod optional, duck-typed detection)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart(), DeciderList, SelectorFnList)
├── scope/     → Per-stage facades + recorders + providers
├── reactive/  → TypedScope<T> deep Proxy (typed property access, $-methods, cycle-safe)
├── decide/    → decide()/select() decision evidence capture (filter + function)
├── recorder/  → CompositeRecorder, KeyedRecorder<T>, SequenceRecorder<T>, composition primitives
├── pause/     → Pause/Resume (PauseSignal, FlowchartCheckpoint, PausableHandler)
├── engine/    → DFS traversal + narrative + 13 handlers
├── runner/    → High-level executor (FlowChartExecutor)
└── contract/  → I/O schema + OpenAPI generation
```

Dependency DAG: `memory <- scope <- reactive <- engine <- runner`, `schema <- engine`, `builder (standalone) -> engine`, `contract <- schema`, `decide -> scope`

Three entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/trace'` — execution tracing: runtimeStageId, commitLog queries, KeyedRecorder, SequenceRecorder
- `import { ... } from 'footprintjs/advanced'` — engine internals (also re-exports trace)

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

const chart = flowChart('Stage1', fn1, 'stage-1', undefined, 'Description')
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
const executor = new FlowChartExecutor(chart, { scopeFactory: myFactory, enrichSnapshots: true });
await executor.run({ input: data, env: { traceId: 'req-123' } });

executor.attachRecorder(recorder) // plug scope observer
executor.getNarrative()           // combined flow + data narrative
executor.getNarrativeEntries()    // structured entries with type/depth/stageName/stageId
executor.getFlowNarrative()       // flow-only (no data ops)
executor.getSnapshot()            // full memory state (includes recorder snapshots)
executor.attachFlowRecorder(r)    // plug flow observer
executor.setRedactionPolicy({})   // PII protection

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
- `resume()` reuses the execution runtime — narrative, metrics, execution tree all accumulate.
- `FlowRecorder.onPause`/`onResume` and `Recorder.onPause`/`onResume` fire on both observer systems.

### ComposableRunner & Snapshot Navigation

```typescript
import type { ComposableRunner } from 'footprintjs';
import { getSubtreeSnapshot, listSubflowPaths } from 'footprintjs';

const subtree = getSubtreeSnapshot(snapshot, 'sf-payment');
listSubflowPaths(snapshot); // ['sf-payment', 'sf-outer/sf-inner']
```

## Two Observer Systems

Both use `{ id, hooks } -> dispatcher -> error isolation -> attach/detach`. Intentionally NOT unified.

**Recorder ID contract:**
- `attachRecorder` is **idempotent by ID** — same ID replaces, different IDs coexist. Prevents accidental double-counting.
- Built-in recorders use auto-increment default IDs (`metrics-1`, `debug-1`, ...) so multiple instances with different configs coexist naturally.
- Frameworks that auto-attach recorders should use a well-known ID (e.g., `new MetricRecorder('metrics')`) so the consumer can override it by passing the same ID, or add a second instance with `new MetricRecorder()` (gets unique ID).

**Scope Recorder** (data ops — fires DURING stage execution):
- `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`
- Built-in: `MetricRecorder`, `DebugRecorder`

**FlowRecorder** (control flow — fires AFTER stage execution):
- `onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onSelected`, `onSubflowEntry/Exit`, `onLoop`, `onBreak`, `onError`
- All events carry `traversalContext: TraversalContext`
- `onDecision`/`onSelected` carry optional `evidence` from decide()/select()
- Built-in: 8 strategies (Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest, Silent)

**CombinedNarrativeRecorder** implements BOTH interfaces. Attached via `executor.recorder(narrative())` at runtime.

## Event Ordering

```
1. Recorder.onStageStart        — stage begins
2. Recorder.onRead/onWrite      — DURING execution (buffered per-stage)
3. Recorder.onCommit            — transaction flush
4. Recorder.onStageEnd          — stage completes
5. FlowRecorder.onStageExecuted — CombinedNarrativeRecorder flushes buffered ops
6. FlowRecorder.onNext/onDecision/onFork — control flow continues
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
| `parseRuntimeStageId(id)` | `{ stageId, executionIndex, subflowPath }` | Decompose an ID |
| `findCommit(commitLog, stageId, key?)` | `CommitBundle \| undefined` | Find first commit by stageId |
| `findCommits(commitLog, stageId)` | `CommitBundle[]` | Find all commits by stageId |
| `findLastWriter(commitLog, key, beforeIdx?)` | `CommitBundle \| undefined` | Search backwards for who wrote a key |
| `KeyedRecorder<T>` | abstract class | Base for 1:1 Map-based recorders |
| `SequenceRecorder<T>` | abstract class | Base for 1:N ordered sequence recorders (has `getEntryRanges()` for O(1) time-travel) |
| `topologyRecorder()` / `TopologyRecorder` | factory / class | Live composition graph for streaming consumers (subflow nodes + control-flow edges) |
| `inOutRecorder()` / `InOutRecorder` | factory / class | Chart in/out stream — `entry`/`exit` pairs at every chart boundary (top-level run + every subflow) |

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
- Not per-stage data — that's `MetricRecorder` / custom `KeyedRecorder<T>`
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

Example: [examples/flow-recorders/06-topology-recorder.ts](examples/flow-recorders/06-topology-recorder.ts)

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
- `SequenceRecorder<InOutEntry>` — flat ordered list + per-`runtimeStageId` index
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

Example: [examples/flow-recorders/07-inout-recorder.ts](examples/flow-recorders/07-inout-recorder.ts)

**Two recorder base classes** — choose based on data shape:

| Base Class | Relationship | Use When |
|------------|-------------|----------|
| `KeyedRecorder<T>` | 1:1 Map | Each step produces one record (MetricRecorder, TokenRecorder) |
| `SequenceRecorder<T>` | 1:N sequence + Map | Multiple records per step, ordering matters (CombinedNarrativeRecorder) |

```typescript
import { KeyedRecorder, SequenceRecorder } from 'footprintjs/trace';

// KeyedRecorder: one entry per step
class TokenRecorder extends KeyedRecorder<TokenEntry> {
  readonly id = 'tokens';
  onLLMCall(event) { this.store(event.runtimeStageId, { tokens: event.usage }); }
}
recorder.getByKey('call-llm#5');                               // Translate: per-step value
recorder.aggregate((sum, e) => sum + e.tokens, 0);             // Aggregate: grand total
recorder.accumulate((sum, e) => sum + e.tokens, 0, visibleKeys); // Accumulate: up to slider

// SequenceRecorder: multiple entries per step, ordered
class AuditRecorder extends SequenceRecorder<AuditEntry> {
  readonly id = 'audit';
  onRead(event) { this.emit({ runtimeStageId: event.runtimeStageId, type: 'read', key: event.key }); }
  onDecision(event) { this.emit({ runtimeStageId: event.traversalContext?.runtimeStageId, ... }); }
}
recorder.getEntriesForStep('call-llm#5');                      // Translate: per-step entries
recorder.aggregate((count, _) => count + 1, 0);                // Aggregate: grand total
recorder.getEntriesUpTo(visibleKeys);                           // Progressive: up to slider
recorder.getEntryRanges();                                      // Range index: O(1) slider sync
```

**`getEntryRanges()`** returns a precomputed `Map<runtimeStageId, {firstIdx, endIdx}>` maintained during `emit()`. Use for O(1) per-step range lookups during time-travel scrubbing. Same shape as `buildEntryRangeIndex()` in `footprint-explainable-ui`.

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

Built on `CombinedRecorder`: `CombinedNarrativeRecorder` (the `executor.enableNarrative()` default). Consumers implement ONLY the events they care about — `Partial<Recorder> & Partial<FlowRecorder>` under the hood.

**Detection rule:** only OWN event-method properties count (prototype methods are ignored for security — prevents accidental `Object.prototype` pollution from attaching handlers).

## Anti-Patterns

- Never post-process the tree — use recorders
- Don't use `getValue()`/`setValue()` in TypedScope stages — use typed property access
- Don't use `$`-prefixed state keys (e.g., `$break`) — they collide with ScopeMethods
- Don't use deprecated `CombinedNarrativeBuilder` — use `CombinedNarrativeRecorder`
- Don't extract shared base for Recorder/FlowRecorder — two instances = coincidence
- Don't use `getArgs()` for tracked data — use typed scope properties
- Don't put infrastructure data in `getArgs()` — use `getEnv()` via `run({ env })`
- Don't manually create `CombinedNarrativeRecorder` — `executor.recorder(narrative())` handles it
- Don't return full arrays from `outputMapper` without `arrayMerge: ArrayMergeMode.Replace` — default `applyOutputMapping` **concatenates** arrays (`[...parent, ...subflow]`). Either return only the **delta** (new items), or set `arrayMerge: ArrayMergeMode.Replace` on `SubflowMountOptions` to overwrite instead of concatenate. Scalars are always replaced regardless.

## Build & Test

```bash
npm run build    # tsc (CJS) + tsc -p tsconfig.esm.json (ESM)
npm test         # full suite
npm run test:unit
```

Dual output: CommonJS (`dist/`) + ESM (`dist/esm/`) + types (`dist/types/`)
