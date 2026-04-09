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
├── recorder/  → CompositeRecorder, KeyedRecorder<T> base class, composition primitives
├── pause/     → Pause/Resume (PauseSignal, FlowchartCheckpoint, PausableHandler)
├── engine/    → DFS traversal + narrative + 13 handlers
├── runner/    → High-level executor (FlowChartExecutor)
└── contract/  → I/O schema + OpenAPI generation
```

Dependency DAG: `memory <- scope <- reactive <- engine <- runner`, `schema <- engine`, `builder (standalone) -> engine`, `contract <- schema`, `decide -> scope`

Three entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/trace'` — execution tracing: runtimeStageId, commitLog queries, KeyedRecorder
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
| `KeyedRecorder<T>` | abstract class | Base for Map-based recorders |

**KeyedRecorder<T>** — abstract base class for recorders that store data as `Map<runtimeStageId, T>`:

```typescript
import { KeyedRecorder } from 'footprintjs/trace';

class MyRecorder extends KeyedRecorder<MyEntry> {
  readonly id = 'my-recorder';  // required (abstract)
  onSomeEvent(event) {
    this.store(event.runtimeStageId, { ... });  // protected
  }
}
recorder.getByKey('call-llm#5');  // O(1) lookup
recorder.getMap();                // ReadonlyMap
recorder.values();                // MyEntry[] in insertion order
recorder.clear();                 // reset
```

**How runtimeStageId is generated:** A counter starts at 0 and increments by 1 for each stage execution across the entire run, including subflow stages. Subflow child traversers share the parent counter so indices are globally unique. Stages inside subflows have stageIds already prefixed by the builder (e.g., `sf-tools/execute-tool-calls`), so `buildRuntimeStageId` just appends `#index`.

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
