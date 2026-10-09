# footprint.js — AI Coding Instructions

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

> Every TypeScript block in this file is type-checked (strict) and run against the built package (footprintjs 9.32.0); the `// …` lines under a `console.log` are that run's real output.

## Core Principle

**Collect during traversal, never post-process.** All data collection (narrative, metrics, manifest, topology, in/out boundaries) happens as side effects of the single DFS traversal pass. Never walk the tree again after execution.

## Architecture — Library of Libraries

`package.json` `exports` has seven doors — import from the one that owns the symbol:

| Import | What it is for |
|---|---|
| `footprintjs` | The main door: `flowChart`, `FlowChartExecutor`, `decide` / `select`, `narrative`, the built-in recorder classes, `interrupt`, and the public types |
| `footprintjs/recorders` | Recorder factories — `narrative()`, `metrics()`, `debug()`, `manifest()`, `adaptive()`, `milestone()`, `windowed()` — and `CompositeRecorder` |
| `footprintjs/trace` | Execution tracing: the record's shapes (`CommitBundle`, `TraceEntry`, `MemoryPatch`), runtimeStageId helpers, commit-log queries (`findCommit`, `findLastWriter`, `applySmartMerge`, `causalChain`, `sliceForKey`, `stateAt`, `timeTravel`), the storage primitives (`KeyedStore`, `SequenceStore`, `BoundaryStateStore`), `topologyRecorder()` / `inOutRecorder()`, `HONESTY_CODES` |
| `footprintjs/write` | Writing a record yourself: the record layer the engine writes with — `SharedMemory` (the heap), `EventLog` (the log), `RecordFrame` (one step's frame) and their option types |
| `footprintjs/advanced` | Engine internals (`StageContext`, `FlowchartTraverser`, `ScopeFacade`, scope providers, `SCOPE_METHOD_NAMES`, `ArrayMergeMode`, the run policy and `RedactionRule`). Until 10.0.0 it also keeps the record names it handed out before 9.47.0 — import those from `trace` or `write`; the nine record internals among them (`TransactionBuffer`, `deepSmartMerge`, …, `redactPatch`) have no other door and leave the public surface at 10.0.0 |
| `footprintjs/detach` | Fire-and-forget child charts and their drivers |
| `footprintjs/zod` | Opt-in zod bridge (`defineScopeFromZod`, …) — the core never imports zod |

The module map (one line per `src/lib/` directory) and the layering rule — a file imports only its own layer or below — live in one place each, so this file keeps no copy that can drift: `CLAUDE.md` ("Module map" and "The fence", shipped with the package) and the layer table in `scripts/layering.config.cjs`, enforced by lint (`import/no-restricted-paths` zones + `import/no-cycle`) and `npm run check:layering` (value-level cycles + upward runtime edges + the closed record: a `RECORD_FILES` file imports only record files, by value or by type).

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
  scope.customer = { name: 'Ana', address: { zip: '10001' } };
  scope.tags = [];
  scope.customer.address.zip = '90210';       // deep write (recorded as an update of `customer`)
  scope.tags.push('vip');                     // array copy-on-write (single push)
  scope.$batchArray('tags', (arr) => {        // batch: one clone + one commit however many mutations
    arr.push('premium', 'verified');
  });
  scope.approved = true;                      // optional field

  // $-prefixed escape hatches
  scope.$debug('checkpoint', { step: 1 });
  scope.$metric('latency', 42);
  const args = scope.$getArgs<{ requestId: string }>();
  const env = scope.$getEnv();
  console.log(args.requestId, env.traceId);
  // req-123 trace-1
  scope.$break();                             // stop the run
}, 'intake')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input: { requestId: 'req-123' }, env: { traceId: 'trace-1' } });

console.log(JSON.stringify(executor.getSnapshot().sharedState));
// {"creditTier":"A","amount":50000,"customer":{"name":"Ana","address":{"zip":"90210"}},"tags":["vip","premium","verified"],"approved":true}
// the batch is ONE write; the single push before it is another
console.log(JSON.stringify(executor.getNarrativeEntries().filter((e) => e.text.includes('Write tags')).map((e) => e.text)));
// ["Step 4: Write tags = []","Step 8: Write tags = (1 item)","Step 10: Write tags = (3 items)"]
```

### decide() / select() — Decision Evidence Capture

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface RiskState {
  creditScore: number;
  dti: number;
}

const chart = flowChart<RiskState>('Intake', (scope) => {
    scope.creditScore = 750;
    scope.dti = 0.35;
  }, 'intake')
  // Inside a decider function — auto-captures which values led to the decision
  .addDeciderFunction('ClassifyRisk', (scope) => {
    return decide(scope, [
      { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approved', label: 'Good credit' },
      { when: (s) => s.creditScore > 600, then: 'manual-review', label: 'Marginal' },
    ], 'rejected');
  }, 'classify-risk')
    .addFunctionBranch('approved', 'Approve', () => {})
    .addFunctionBranch('manual-review', 'Review', () => {})
    .addFunctionBranch('rejected', 'Reject', () => {})
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();
console.log(executor.getNarrativeEntries().find((e) => e.type === 'condition')?.text);
// [Condition]: It evaluated Rule 0 "Good credit": creditScore 750 gt 700 ✓, dti 0.35 lt 0.43 ✓, and chose Approve.
```

Filter operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`. `decide()` returns `{ branch, evidence }`; the narrative names the chosen branch by its **name** (`Approve`), the evidence by its **id** (`approved`).

`select()` is the multi-pick twin — every matching rule picks its branch (not first-match), and the picked branches run in parallel:

```typescript
import { flowChart, FlowChartExecutor, select } from 'footprintjs';

const chart = flowChart<{ glucose: number; bmi: number }>('Intake', (scope) => {
    scope.glucose = 120;
    scope.bmi = 31;
  }, 'intake')
  .addSelectorFunction('Screen', (scope) => select(scope, [
      { when: { glucose: { gt: 100 } }, then: 'diabetes', label: 'High glucose' },
      { when: { bmi: { gt: 30 } }, then: 'obesity', label: 'High BMI' },
    ]), 'screen')
    .addFunctionBranch('diabetes', 'DiabetesPath', () => {})
    .addFunctionBranch('obesity', 'ObesityPath', () => {})
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();
console.log(executor.getNarrativeEntries().find((e) => e.type === 'fork')?.text);
// [Parallel]: Forking into 2 parallel paths: DiabetesPath, ObesityPath.
```

**Naming the default branch.** The default is chosen by no rule, so no
`rules[].label` can describe it — it is the one branch evidence cannot
otherwise name. Declare it beside the rules by passing an object instead of a
string; the label lands on `DecisionEvidence.defaultLabel` and is recorded on
every decision, not just the runs that fell through.

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

for (const creditScore of [750, 100]) {
  const chart = flowChart<{ creditScore: number }>('Intake', (scope) => { scope.creditScore = creditScore; }, 'intake')
    .addDeciderFunction('ClassifyRisk', (scope) => decide(scope, [
        { when: { creditScore: { gt: 700 } }, then: 'approved', label: 'Good credit' },
      ], { branch: 'rejected', label: 'No rule fired — application rejected' }), 'classify-risk')
      .addFunctionBranch('approved', 'Approve', () => {})
      .addFunctionBranch('rejected', 'Reject', () => {})
      .end()
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder({
    id: 'evidence',
    onDecision: (e) => console.log(e.evidence?.chosen, '|', e.evidence?.defaultLabel),
  });
  await executor.run();
}
// approved | No rule fired — application rejected
// rejected | No rule fired — application rejected
// a bare string default still works: decide(scope, rules, 'rejected') — the evidence then has no `defaultLabel` key
```

### Builder

```typescript
import { flowChart } from 'footprintjs';

const chart = flowChart('Stage1', () => {}, 'stage-1', { description: 'Description' })
  .addFunction('Stage2', () => {}, 'stage-2', 'Description')
  .addDeciderFunction('Decide', () => 'high', 'decide', 'Route based on risk')
    .addFunctionBranch('high', 'Reject', () => {})
    .addFunctionBranch('low', 'Approve', () => {})
    .setDefault('high')
    .end()
  .build();
```

The first stage is `flowChart(name, fn, id, { description?, structureRecorders? })`; every later stage is `.addFunction(name, fn, id, description?)`.

Methods (not exhaustive): `start()`, `addFunction()`, `addStreamingFunction()`, `addDeciderFunction()`, `addSelectorFunction()`, `addListOfFunction()`, `addParallelForEach()`, `addPausableFunction()`, `addSubFlowChart()`, `addSubFlowChartNext()`, `addLazySubFlowChart()`, `addDetachAndForget()`, `addDetachAndJoinLater()`, `retry()`, `tag()`, `loopTo()`, `contract()`, `attachStructureRecorder()`, `build()`, `toSpec()`, `toMermaid()`. `toOpenAPI()` and `toMCPTool()` are on the built chart.

### ScopeFacade (Internal — use TypedScope for new code)

`ScopeFacade` (from `footprintjs/advanced`) is the engine's own scope; `TypedScope` wraps it. A stage only receives a `ScopeFacade` when you supply a custom `scopeFactory`. In a TypedScope stage the same operations are `scope.$getValue(key)` / `scope.$setValue(key, value)` / `scope.$getArgs()` / `scope.$getEnv()` — plain `scope.getValue` does not exist there.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { ScopeFacade } from 'footprintjs/advanced';

// TypedScope stage: dynamic keys go through the $ methods
const typed = flowChart<Record<string, unknown>>('Typed', (scope) => {
  scope.$setValue('dyn', 41);
  scope.$setValue('dyn', (scope.$getValue('dyn') as number) + 1);
}, 'typed').build();
const typedRun = new FlowChartExecutor(typed);
await typedRun.run();
console.log(JSON.stringify(typedRun.getSnapshot().sharedState));
// {"dyn":42}

// ScopeFacade stage: getValue / setValue / getArgs / getEnv
const facade = flowChart<any>('Facade', (scope: any) => {
  const s = scope as ScopeFacade;
  s.setValue('key', { v: 1 });
  console.log(JSON.stringify([s.getValue('key'), s.getArgs(), s.getEnv()]));
}, 'facade').build();
const facadeRun = new FlowChartExecutor(facade, {
  scopeFactory: (ctx, stageName, readOnly, env) => new ScopeFacade(ctx, stageName, readOnly, env),
});
await facadeRun.run({ input: { requestId: 'req-9' }, env: { traceId: 'trace-9' } });
// [{"v":1},{"requestId":"req-9"},{"traceId":"trace-9"}]
```

**Three access tiers:**
- `scope.amount = 50000` (ScopeFacade: `getValue`/`setValue`) — mutable shared state, tracked in the narrative
- `$getArgs()` (ScopeFacade: `getArgs()`) — frozen business input from `run({ input })`, NOT tracked. Its keys are read-only for the run: a stage that writes a state key with the same name throws `Cannot write to readonly input key "requestId"`. A subflow's `inputMapper` result is its input and follows the same rule
- `$getEnv()` (ScopeFacade: `getEnv()`) — frozen infrastructure context from `run({ env })`, NOT tracked. Returns `ExecutionEnv { signal?, timeoutMs?, traceId? }`. Auto-inherited by subflows. Closed type

### Executor

Custom factory objects (including standalone scopes passed to `decide`/`select`) must register their infrastructure port with `registerScopeRuntime(scope, { target, handlesAssignments, setBreak? })` from `footprintjs/advanced`. `ScopeFacade`, TypedScope, `attachScopeMethods` and canonical Zod factories register automatically. The engine asks that port, never probes a strict user proxy for lifecycle names. Prefer one backing `ScopeFacade` as `target`; it owns recording, redaction, input protection and commit sealing. A deliberately data-only `{}` port has none of those scope-level hooks. See `docs/guides/scope.md` for the migration example; do not restore property-name guessing.

```typescript
import { flowChart, FlowChartExecutor, MetricRecorder, NarrativeFlowRecorder } from 'footprintjs';

const chart = flowChart<{ n: number }>('One', (scope) => { scope.n = scope.$getArgs<{ x: number }>().x; }, 'one')
  .addFunction('Two', (scope) => { scope.n = scope.n + 1; }, 'two')
  .build();

// With options (preferred over positional params): scopeFactory, readTracking, writeTracking, commitValues, …
const executor = new FlowChartExecutor(chart, { readTracking: 'full' });
executor.enableNarrative();                                // before run() — the narrative is off by default
executor.attachScopeRecorder(new MetricRecorder());        // plug scope observer
executor.attachFlowRecorder(new NarrativeFlowRecorder());  // plug flow observer
executor.setRedactionPolicy({ keys: ['secret'] });         // PII protection

await executor.run({ input: { x: 1 }, env: { traceId: 'req-123' } });

// CombinedNarrativeEntry[] — combined flow + data narrative
console.log(executor.getNarrativeEntries().length);
// 5
// flow-only (no data ops): drop the read/write steps
console.log(JSON.stringify(executor.getNarrativeEntries().filter((e) => e.type !== 'step').map((e) => e.text)));
// ["Stage 1: The process began with One.","Stage 2: Next, it moved on to Two."]
// full memory state (includes recorder snapshots)
console.log(JSON.stringify(Object.keys(executor.getSnapshot())));
// ["sharedState","executionTree","initialState","commitLog","commitValues","writeProvenance","runId","recorders"]

// Pause/Resume — human-in-the-loop (next section)
// executor.isPaused()                // true if last run paused
// executor.getCheckpoint()           // JSON-safe checkpoint (store in Redis/Postgres/etc.)
// executor.resume(checkpoint, input) // continue from checkpoint with human's answer
```

`getNarrativeEntries()` returns entries (`type`, `text`, `depth`, `stageName`, `stageId`, …), not strings: `.map((e) => e.text)` for plain lines. One executor runs one execution at a time — create one per concurrent run.

### Pause/Resume (Human-in-the-Loop)

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface MyState {
  amount: number;
  approved?: boolean;
  done?: boolean;
}

const handler: PausableHandler<MyState> = {
  execute: async (scope) => {
    // Return data = pause. Return nothing = continue.
    return { question: `Approve $${scope.amount}?` };
  },
  resume: async (scope, input) => {
    scope.approved = (input as { approved: boolean }).approved;
  },
};

// Pausable root stage (single-stage subflows):
const single = flowChart<MyState>('Approve', handler, 'approve').build();

// Or chained after other stages:
const chart = flowChart<MyState>('Seed', (scope) => { scope.amount = 500; }, 'seed')
  .addPausableFunction('Approve', handler, 'approve')
  .addFunction('Process', (scope) => { scope.done = scope.approved === true; }, 'process')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();
console.log(executor.isPaused());
// true

if (executor.isPaused()) {
  const checkpoint = executor.getCheckpoint()!; // JSON-safe, store anywhere
  console.log(checkpoint.pausedStageId, JSON.stringify(checkpoint.pauseData));
  // approve {"question":"Approve $500?"}
  const stored = JSON.stringify(checkpoint);
  // Later (hours, different server):
  await executor.resume(JSON.parse(stored), { approved: true });
}
console.log(executor.isPaused(), JSON.stringify(executor.getSnapshot().sharedState));
// false {"amount":500,"approved":true,"done":true}
console.log(executor.getNarrativeEntries().filter((e) => e.type === 'pause' || e.type === 'resume').map((e) => e.text));
// [
//   'Execution paused at Approve.',
//   'Execution resumed at Approve with input.'
// ]
void single;
```

- `execute` returns data → pauses. Returns void → continues normally (conditional pause).
- Checkpoint is JSON-serializable — no functions, no class instances. A fresh executor resumes it too (`new FlowChartExecutor(chart).resume(JSON.parse(stored), input)`).
- `resume()` on the SAME executor reuses its runtime — narrative, metrics, execution tree all accumulate; a fresh executor seeds a new runtime from `checkpoint.sharedState`.
- A resume re-enters ONCE, then the run is the chart as built: a `loopTo` back to the paused stage runs that stage again (it pauses again — a re-ask), and the next pass through a subflow mount is a fresh entry (its inputMapper runs). A pause several subflows deep does not re-run the outer subflows' earlier stages, and a subflow mounted as a decider/selector branch or a fork child hands back to its parent's continuation (the decider's `next`, the fork's join). (Since 9.28.0.)
- Two parallel siblings that pause in one fan-out are asked IN TURN: the checkpoint asks the first and carries the others in `checkpoint.pendingPauses`; each resume answers one; the join runs after the last. (Since 9.28.0.)
- Not resumable yet: a pause inside a LAZY subflow or an `addParallelForEach` branch — `resume()` rejects (`Cannot resume: stage 'lz/sf-ask' not found in flowchart`). A subflow id mounted twice in one chart — `resume()` refuses a pause inside it (give each mount its own id).
- `FlowRecorder.onPause`/`onResume` and `ScopeRecorder.onPause`/`onResume` fire on both observer systems.

### ComposableRunner & Snapshot Navigation

`ComposableRunner<TIn, TOut>` is the interface for a runner that exposes its internal chart so a parent can mount it as a subflow: `toFlowChart()` and `run(input, options?)`.

```typescript
import { flowChart, FlowChartExecutor, getSubtreeSnapshot, listSubflowPaths } from 'footprintjs';
import type { ComposableRunner } from 'footprintjs';

class Doubler implements ComposableRunner<number, number> {
  toFlowChart() {
    return flowChart<{ out?: number }>('Double', (scope) => { scope.out = scope.$getArgs<{ n: number }>().n * 2; }, 'double').build();
  }
  async run(input: number): Promise<number> {
    const executor = new FlowChartExecutor(this.toFlowChart());
    await executor.run({ input: { n: input } });
    return (executor.getSnapshot().sharedState as { out: number }).out;
  }
}

const outer = flowChart<{ out?: number }>('Outer', () => {}, 'outer')
  .addSubFlowChartNext('sf-doubler', new Doubler().toFlowChart(), 'Doubler', {
    inputMapper: () => ({ n: 21 }),
    outputMapper: (sub: { out?: number }) => ({ out: sub.out }),
  })
  .build();
const root = flowChart<{ out?: number }>('Root', () => {}, 'root')
  .addSubFlowChartNext('sf-outer', outer, 'OuterMount', { outputMapper: (sub: { out?: number }) => ({ out: sub.out }) })
  .build();

const executor = new FlowChartExecutor(root);
await executor.run();
const snapshot = executor.getSnapshot();

console.log(await new Doubler().run(4));
// 8
console.log(listSubflowPaths(snapshot));
// [ 'sf-outer/sf-doubler', 'sf-outer' ]
const subtree = getSubtreeSnapshot(snapshot, 'sf-outer/sf-doubler');
console.log(Object.keys(subtree ?? {}), JSON.stringify(subtree?.sharedState));
// [
//   'subflowId',
//   'executionTree',
//   'sharedState',
//   'history',
//   'initialState',
//   'narrativeEntries'
// ] {"n":21,"out":42}
```

## Observer Channels

Four pluggable observer channels — three fire at runtime (Scope, Flow, Emit) and one fires at build time (Structure). The runtime channels share `{ id, hooks } -> dispatcher -> error isolation -> attach/detach` (the Structure channel has `attachStructureRecorder` only). `attachCombinedRecorder(r)` routes a recorder to channels by runtime duck-typing of its `on*` methods. Intentionally NOT unified into one interface — each channel has a distinct invariant set.

**Recorder ID contract:**
- `attachScopeRecorder` / `attachFlowRecorder` / `attachEmitRecorder` / `attachCombinedRecorder` are **idempotent by ID** — same ID replaces, different IDs coexist. Prevents accidental double-counting.
- Built-in recorders use auto-increment default IDs (`metrics-1`, `debug-1`, ...) so multiple instances with different configs coexist naturally.
- Frameworks that auto-attach recorders should use a well-known ID (e.g., `new MetricRecorder('metrics')`) so the consumer can override it by passing the same ID, or add a second instance with `new MetricRecorder()` (gets unique ID).

```typescript
import { flowChart, FlowChartExecutor, MetricRecorder, DebugRecorder } from 'footprintjs';

console.log(new MetricRecorder().id, new MetricRecorder().id, new MetricRecorder('metrics').id, new DebugRecorder({ id: 'dbg' }).id);
// metrics-1 metrics-2 metrics dbg

const executor = new FlowChartExecutor(flowChart<{ a: number }>('One', (scope) => { scope.a = 1; }, 'one').build());
let first = 0;
let second = 0;
executor.attachScopeRecorder({ id: 'same', onWrite: () => { first++; } });
executor.attachScopeRecorder({ id: 'same', onWrite: () => { second++; } }); // same id: replaces the first
await executor.run();
console.log(first, second);
// 0 1
```

**Scope Recorder** (data ops — `onStageStart` → `onRead`/`onWrite` DURING the stage function → `onStageEnd` → `onCommit`):
- `onStageStart`, `onRead`, `onWrite`, `onStageEnd`, `onCommit`, `onError`, `onPause`, `onResume`
- Built-in: `MetricRecorder`, `DebugRecorder`

**FlowRecorder** (control flow — fires AFTER the stage's commit):
- `onStageExecuted` (universal "did this stage run", carries `stageType: 'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'`), `onNext`, `onDecision`, `onFork`, `onSelected`, `onSubflowEntry/Exit`, `onSubflowRegistered`, `onLoop`, `onBreak`, `onStageRetry`, `onError`, `onPause`/`onResume`, `onRunStart`/`onRunEnd`, `onRunFailed`
- Events carry an optional `traversalContext: TraversalContext` (includes per-run `runId`)
- `onDecision`/`onSelected` carry optional `evidence` from decide()/select()
- Built-in: 9 strategies (Narrative, Adaptive, Windowed, RLE, Milestone, Progressive, Separate, Manifest, Silent)

**Emit Recorder** (consumer-emitted events — fired by `scope.$emit(name, payload)`):
- `onEmit(EmitEvent)` — see the "Emit Channel" section below.

**Structure Recorder** (build-time chart shape — fires SYNCHRONOUSLY during builder operations, NOT runtime):
- `onStageAdded`, `onStageTagged`, `onEdgeAdded`, `onLoopEdgeAdded`, `onDeciderComplete`, `onSubflowMounted`
- Attach via options bag — `flowChart('seed', fn, 'seed', { structureRecorders: [rec] })` — or fluent `.attachStructureRecorder(rec)`. MOUNT-ONLY: a builder's recorder sees only that builder's events; subflow internals arrive via the mount event's `subflowSpec` (walk with `walkSubflowSpec` from `footprintjs/trace`). The types are exported from the main `footprintjs` barrel.

```typescript
import { flowChart } from 'footprintjs';
import type { StructureRecorder, StructureSubflowMountedEvent } from 'footprintjs';
import { walkSubflowSpec } from 'footprintjs/trace';

const events: string[] = [];
let mounted: StructureSubflowMountedEvent | undefined;
const recorder: StructureRecorder = {
  id: 'structure',
  onStageAdded: (e) => { events.push(`stage ${e.spec.id}`); },
  onEdgeAdded: (e) => { events.push(`edge ${e.from} -> ${e.to} (${e.kind})`); },
  onSubflowMounted: (e) => { events.push(`mounted ${e.subflowId}`); mounted = e; },
};

const sub = flowChart<object>('SubA', () => {}, 'sub-a').addFunction('SubB', () => {}, 'sub-b').build();
flowChart<object>('Seed', () => {}, 'seed', { structureRecorders: [recorder] })
  .addSubFlowChartNext('sf', sub, 'Sub')
  .build();

console.log(events); // the subflow's own stages (sub-a, sub-b) are NOT reported here
// [ 'stage seed', 'stage sf', 'edge seed -> sf (next)', 'mounted sf' ]
for (const item of walkSubflowSpec(mounted!.subflowSpec!, mounted!.subflowPath ?? mounted!.subflowId)) {
  console.log(item.kind);
}
// subflow-start
// stage
// edge
// stage
```

**CombinedNarrativeRecorder** implements the Scope + Flow + Emit interfaces. `executor.enableNarrative(options)` configures the executor-owned view (read it with `executor.getNarrativeEntries()`). Attaching any flow recorder also enables that view. `chart.recorder(narrative())` attaches a separate instance for a one-shot run, and `executor.attachCombinedRecorder(narrative())` works too — read its configured view from `recorder.getEntries()`, not the executor getter. Each default instance has a distinct generated ID; detach using `recorder.id`. Same-executor resume preserves narrative history; a fresh executor records only its resumed leg. The class is not exported from the public doors.

## Event Ordering

```
0. FlowRecorder.onRunStart       — once per executor.run(), before any stage; event.payload = the run input
   Per stage, ScopeRecorder events:
1. Recorder.onStageStart         — stage begins
2. Recorder.onRead/onWrite       — DURING execution, before the commit
3. Recorder.onStageEnd           — the stage function returned
4. Recorder.onCommit             — transaction flush
   Then FlowRecorder events, by stage kind:
5. linear stage    onStageExecuted → onNext
   decider         onDecision → onStageExecuted
   selector        onSelected → onStageExecuted → onFork
   fork parent     onStageExecuted → onFork → onStageExecuted (stageType 'fork')
   subflow mount   onNext → onSubflowEntry → onStageExecuted (stageType 'subflow-mount')
                   → the subflow's own stages → onSubflowExit
6. FlowRecorder.onRunEnd (clean; event.payload = the chart's return value) or onRunFailed (error; event.structuredError) — once per run, closes the boundary symmetrically
```

`CombinedNarrativeRecorder` flushes a stage's buffered reads and writes when that stage's flow event arrives: `onStageExecuted` for LINEAR stages, `onDecision` / `onSelected` / `onFork` / `onSubflowEntry` for the others.

## Execution Tracing (`footprintjs/trace`)

Every stage execution gets a unique `runtimeStageId` — the universal key that links recorder events, commit log entries, and execution tree nodes.

**When to use:** Debugging (which stage set a value to something unexpected?), audit trails (trace every write to its source stage), custom recorders (correlate events with specific execution steps), quality trace backtracking (walk backwards to find where data quality dropped).

**Format:** `[subflowPath/]stageId#executionIndex` — the index starts at 0 and counts every stage execution across the run (a loop revisits the same stageId with a higher index):

```
seed#0                              — root stage, the first execution
tick#6                              — the seventh execution
sf-outer/sf-inner/inner-end#5       — a stage inside a nested subflow
tick#9                              — same stageId, different execution (loop)
```

**The commitLog:** An ordered array of `CommitBundle` — one per stage commit, recording what each stage wrote to shared state. Get it from `executor.getSnapshot().commitLog`. A subflow mount appears twice in the root log under one runtimeStageId; the subflow's own stage commits are in its subtree history (`getSubtreeSnapshot(snapshot, path).history`).

```typescript
import { flowChart, FlowChartExecutor, decide, getSubtreeSnapshot } from 'footprintjs';
import { parseRuntimeStageId, buildRuntimeStageId, splitStageId, findLastWriter, findCommit, findCommits, isCommitBundle } from 'footprintjs/trace';

const inner = flowChart<{ v: number; t?: number; out?: number }>('InnerStart', (scope) => { scope.t = scope.v + 1; }, 'inner-start')
  .addFunction('InnerEnd', (scope) => { scope.out = (scope.t ?? 0) * 2; }, 'inner-end')
  .build();
const outer = flowChart<{ n: number; w?: number; out?: number }>('OuterStart', (scope) => { scope.w = scope.n; }, 'outer-start')
  .addSubFlowChartNext('sf-inner', inner, 'Inner', {
    inputMapper: (parent: { w?: number }) => ({ v: parent.w }),
    outputMapper: (sub: { out?: number }) => ({ out: sub.out }),
  })
  .build();
const chart = flowChart<{ n: number; count: number }>('Seed', (scope) => { scope.n = 1; scope.count = 0; }, 'seed')
  .addSubFlowChartNext('sf-outer', outer, 'Outer', {
    inputMapper: (parent: { n: number }) => ({ n: parent.n }),
    outputMapper: (sub: { out?: number }) => ({ out: sub.out }),
  })
  .addFunction('Tick', (scope) => { scope.count = scope.count + 1; }, 'tick')
  .addDeciderFunction('Route', (scope) => decide(scope, [
      { when: { count: { lt: 2 } }, then: 'again', label: 'under 2' },
    ], 'done'), 'route')
    .addFunctionBranch('again', 'Again', () => {})
    .loopTo('tick')
    .addFunctionBranch('done', 'Done', () => {})
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run();

// Get the commit log after execution
const snapshot = executor.getSnapshot();
const commitLog = snapshot.commitLog; // CommitBundle[]
console.log(commitLog.map((bundle) => bundle.runtimeStageId).join(' '));
// seed#0 sf-outer#1 sf-outer#1 tick#6 route#7 again#8 tick#9 route#10 done#11

// A subflow's own stage commits live in its subtree history, not in the root log
const innerHistory = (getSubtreeSnapshot(snapshot, 'sf-outer/sf-inner')?.history ?? []).filter(isCommitBundle);
console.log(innerHistory.map((bundle) => bundle.runtimeStageId).join(' '));
//  sf-outer/sf-inner/inner-start#4 sf-outer/sf-inner/inner-end#5

// Parse a runtimeStageId into components
console.log(JSON.stringify(parseRuntimeStageId(innerHistory[1].runtimeStageId)));
// {"stageId":"inner-start","executionIndex":4,"subflowPath":"sf-outer/sf-inner"}
console.log(buildRuntimeStageId('inner-end', 5, 'sf-outer/sf-inner'), JSON.stringify(splitStageId('sf-outer/sf-inner/inner-end')));
// sf-outer/sf-inner/inner-end#5 {"localStageId":"inner-end","subflowPath":"sf-outer/sf-inner"}

// Backtrack: who last wrote 'count' before commitLog array index 6?
// beforeIdx is the CommitBundle.idx (array position), NOT the executionIndex from runtimeStageId.
const writer = findLastWriter(commitLog, 'count', 6);
console.log(writer?.runtimeStageId, writer?.idx, JSON.stringify(writer?.trace));
// tick#6 3 [{"path":"count","verb":"set"}]
// → CommitBundle | undefined (has .idx, .stage, .stageId, .runtimeStageId, .trace, .overwrite, .updates, .redactedPaths)

// Find by stageId: use findCommit when you know the stage.
// Use findLastWriter when you know the key but not which stage wrote it.
console.log(findCommit(commitLog, 'tick', 'count')?.runtimeStageId, findCommits(commitLog, 'tick').map((bundle) => bundle.runtimeStageId));
// tick#6 [ 'tick#6', 'tick#9' ]
```

**Exports from `footprintjs/trace`** (the door has many more — causal chains, slices, time travel, honesty codes, `ControlDepRecorder`, `QualityRecorder`; see `src/lib/slice/README.md` and `src/lib/time-travel/README.md`):

| Export | Returns | Use |
|--------|---------|-----|
| `buildRuntimeStageId(stageId, idx, subflowPath?)` | `string` | Construct an ID from components |
| `parseRuntimeStageId(id)` | `{ stageId, executionIndex, subflowPath }` (`subflowPath` is `undefined` at top level) | Decompose an ID |
| `findCommit(commitLog, stageId, key?)` | `CommitBundle \| undefined` | Find the first commit by stageId (that wrote `key`, if given) |
| `findCommits(commitLog, stageId)` | `CommitBundle[]` | Find all commits by stageId |
| `findLastWriter(commitLog, key, beforeIdx?)` | `CommitBundle \| undefined` | Search backwards for who wrote a key |
| `splitStageId(prefixedId)` | `{ localStageId, subflowPath }` | Decompose a bare prefixed id (`spec.id`, `CommitBundle.stageId`) |
| `walkSubflowSpec(spec, subflowPath, opts?)` | `Generator<WalkerItem>` | Walk a subflow spec from `StructureSubflowMountedEvent.subflowSpec` |
| `KeyedStore<T>` | class (since 5.0.0) | Storage shelf for 1:1 Map keyed by runtimeStageId (`set`/`get`/`aggregate`/`accumulate`/`filterByKeys`) |
| `SequenceStore<T>` | class (since 5.0.0) | Storage shelf for 1:N ordered entries (`push`/`getByKey`/`getEntryRanges()` for O(1) time-travel/`getEntriesUpTo`) |
| `BoundaryStateStore<TState>` | class (since 5.0.0) | Storage shelf for transient bracket-scoped state — live state DURING a `[start, stop]` interval; clears on stop. O(1) reads via `get` / `hasActive` / `activeCount`; lifecycle via `start` / `update` / `stop`. |
| `KeyedRecorder<T>` / `SequenceRecorder<T>` / `BoundaryStateTracker<TState>` | abstract bases — **REMOVED in 7.0.0** | Gone — no inheritance path remains. Superseded by the `*Store` classes above: own a store as a field and implement the channel interface yourself. |
| `CommitRangeIndex<TLabel>` | class | Interval index over commit indices (`open`/`close`/`enclosing`/`overlapping`) |
| `topologyRecorder()` / `TopologyRecorder` | factory / class | Live composition graph for streaming consumers (subflow nodes + control-flow edges) |
| `inOutRecorder()` / `InOutRecorder` | factory / class | Chart in/out stream — `entry`/`exit` pairs at every chart boundary (top-level run + every subflow) |

### TopologyRecorder — Composition Graph for Streaming Consumers

**One-liner:** reconstructs a live, queryable mini-flowchart of what your run actually traced, built from FlowRecorder events (`onSubflowEntry`/`onSubflowExit`, `onFork`, `onDecision`, `onLoop`) during traversal.

**Mental model:**

```
flowChart() builder      →  STATIC flowchart (design-time definition)
                                       │
                                       ▼ executor runs it
                         Traversal emits FlowRecorder events
                                       │
                                       ▼ TopologyRecorder listens
                         DYNAMIC flowchart (runtime shape):
                            Nodes = composition points
                               (subflow / fork-branch / decision-branch)
                            Edges = transitions
                               (next / fork-branch / decision-branch / loop-iteration)
                            Queryable any moment — during or after run
```

**What it IS:**
- Live composition graph derived from flow events
- Each node = one composition-significant moment (subflow entered, fork child, decision chosen)
- Each edge = a control-flow transition, stamped with the `runtimeStageId` it happened at (`edge.at`)
- Works identically during or after a run

**What it ISN'T:**
- Not a full execution tree — that's `StageContext` / `executor.getSnapshot()`
- Not per-stage data — that's `MetricRecorder` / a custom recorder composing `KeyedStore<T>`
- Not agent-specific — agentfootprint composes it; footprintjs owns it

**Why live consumers need it:** The executor already has the topology internally (execution tree in `StageContext`). But streaming consumers can't access that tree mid-run — they only see events. `TopologyRecorder` = "the tree, reconstructed from events, live-queryable."

Fills the gap between "post-run snapshot (full tree available)" and "live event stream (only point observations)." Attach once; query `getTopology()` anytime during or after a run.

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import { topologyRecorder } from 'footprintjs/trace';

const agent = flowChart<{ count: number }>('Start', (scope) => { scope.count = 0; }, 'start')
  .addFunction('Tick', (scope) => { scope.count = scope.count + 1; }, 'tick')
  .addDeciderFunction('Check', (scope) => decide(scope, [
      { when: { count: { lt: 2 } }, then: 'again', label: 'under 2' },
    ], 'done'), 'check')
    .addFunctionBranch('again', 'Again', () => {})
    .loopTo('tick')
    .addFunctionBranch('done', 'Done', () => {})
    .end()
  .build();
const fanOut = flowChart<object>('Host', () => {}, 'host')
  .addListOfFunction([
    { id: 'x', name: 'X', fn: () => {} },
    { id: 'y', name: 'Y', fn: () => {} },
  ])
  .build();
const chart = flowChart<object>('Seed', () => {}, 'seed')
  .addSubFlowChartNext('sf-agent', agent, 'Agent')
  .addSubFlowChartNext('sf-fanout', fanOut, 'FanOut')
  .build();

const executor = new FlowChartExecutor(chart);
const topo = topologyRecorder();
executor.attachCombinedRecorder(topo); // auto-routes to FlowRecorder channel

await executor.run();

const { nodes, edges, activeNodeId, rootId } = topo.getTopology();
console.log(nodes.map((node) => `${node.kind} ${node.id}`));
// [
//   'subflow sf-agent',
//   'decision-branch decision-sf-agent/check#4-sf-agent/Again',
//   'decision-branch decision-sf-agent/check#7-sf-agent/Done',
//   'subflow sf-fanout',
//   'fork-branch fork-sf-fanout/host#10-0-sf-fanout/X',
//   'fork-branch fork-sf-fanout/host#10-1-sf-fanout/Y'
// ]
console.log(edges.map((edge) => `${edge.kind}: ${edge.from} -> ${edge.to}`));
// [
//   'decision-branch: sf-agent -> decision-sf-agent/check#4-sf-agent/Again',
//   'loop-iteration: sf-agent -> sf-agent',
//   'decision-branch: sf-agent -> decision-sf-agent/check#7-sf-agent/Done',
//   'next: sf-agent -> sf-fanout',
//   'fork-branch: sf-fanout -> fork-sf-fanout/host#10-0-sf-fanout/X',
//   'fork-branch: sf-fanout -> fork-sf-fanout/host#10-1-sf-fanout/Y'
// ]
console.log(activeNodeId, rootId);
// null sf-agent
console.log(topo.getSubflowNodes().map((node) => node.id));   // agent-centric view
// [ 'sf-agent', 'sf-fanout' ]
console.log(topo.getByKind('fork-branch').map((node) => node.name));   // all parallel branches
// [ 'sf-fanout/X', 'sf-fanout/Y' ]
// topo.getParallelSiblings(id) — siblings of a parallel branch; topo.getChildren(id) — direct children
```

**Three node kinds — complete composition coverage:**

| Kind | Fires on | Represents |
|---|---|---|
| `subflow` | `onSubflowEntry` | Mounted subflow boundary (with stable `subflowId`) |
| `fork-branch` | `onFork` (synthesized one per child) | One branch of a parallel split — works for plain stages AND subflows |
| `decision-branch` | `onDecision` (synthesized for chosen) | The chosen branch of a conditional |

When a fork-branch or decision-branch target is also a subflow, the subsequent `onSubflowEntry` creates a subflow CHILD of the synthetic node (verified for a fork/decider at the top level of a run; inside another subflow the branch names carry the subflow path prefix and the subflow node attaches to the enclosing subflow instead). Layered shape preserves both "who branched" and "what the branch ran."

**Edges:** `edge.kind ∈ 'next' | 'fork-branch' | 'decision-branch' | 'loop-iteration'`. Each carries `at: runtimeStageId` for time correlation. Fork, decision and loop edges are recorded only while a subflow is active — a fork or decision at the top level of the run still creates its nodes, but no edge — and a `loopTo` outside any subflow adds nothing.

**Correlation rules:**
- `onFork({ parent, children })` → N `fork-branch` nodes synthesized up-front; subsequent matching `onSubflowEntry` nests under the right fork-branch
- `onDecision({ chosen })` → `decision-branch` node synthesized up-front; matching `onSubflowEntry` nests under it
- A pending decision clears on `onSubflowExit` so it can't match an unrelated subflow later; pending fork-sibling entries survive scope exits (a sibling's inner subflow may exit before the next sibling enters) and clear on the next `onFork` or on a match
- `onLoop` → self-edge on the currently-active subflow (synthetic nodes don't participate)
- Re-entry of same `subflowId` (loop body) disambiguates via `id#n` suffix (`sf-body`, `sf-body#1`)

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

Loop re-entry produces distinct pairs because the parent stage's executionIndex increments (`sf-body#2`, `sf-body#7`).

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
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { inOutRecorder, ROOT_SUBFLOW_ID } from 'footprintjs/trace';

const sub = flowChart<{ q: number; r?: number }>('Double', (scope) => { scope.r = scope.q * 2; }, 'double').build();
const chart = flowChart<{ n: number; out?: number }>('Seed', (scope) => { scope.n = 21; }, 'seed')
  .addSubFlowChartNext('sf-double', sub, 'Doubler', {
    inputMapper: (parent: { n: number }) => ({ q: parent.n }),
    outputMapper: (out: { r?: number }) => ({ out: out.r }),
  })
  .build();

const executor = new FlowChartExecutor(chart);
const inOut = inOutRecorder();
executor.attachCombinedRecorder(inOut);

await executor.run({ input: { start: true } });

console.log(inOut.getSteps().map((step) => step.runtimeStageId), ROOT_SUBFLOW_ID); // entry boundaries (timeline; root is first step)
// [ '__root__#0', 'sf-double#1' ] __root__
const { entry, exit } = inOut.getBoundary('sf-double#1')!;    // { entry, exit } pair for one execution
console.log(JSON.stringify(entry?.payload), JSON.stringify(exit?.payload));
// {"q":21} {"q":21,"r":42}
const rootBoundary = inOut.getRootBoundary();                  // { entry, exit } for the top-level run
console.log(JSON.stringify(rootBoundary?.entry?.payload), rootBoundary?.exit?.payload);
// {"start":true} undefined
// inOut.getBoundaries()   — flat list (entry+exit interleaved)
// inOut.getEntryRanges()  — O(1) per-step range index for time-travel
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

**Pause semantics:** when a stage pauses inside a subflow, the engine re-throws without firing `onSubflowExit` (or `onRunEnd`). The chart has an `entry` with no matching `exit`: `getBoundary()` returns `{ entry, exit: undefined }`. Resuming on the same executor appends a second root pair and a fresh pair for the re-entered subflow (new runtimeStageId) — the first leg's dangling `entry` stays as recorded.

**Engine events:** `FlowRecorder.onRunStart(event)` and `onRunEnd(event)` carry `event.payload` (the run's input or output). Fire ONCE per top-level `executor.run()` — not for subflow traversers (those fire `onSubflowEntry`/`onSubflowExit` instead). Available on the `IControlFlowNarrative` interface and the `FlowRecorderDispatcher`.

**For downstream libraries:** compose, don't duplicate. A domain-flavored step graph (e.g., agentfootprint's `StepGraph`) should consume `InOutRecorder` output and label each entry by inspecting the payload through domain semantics — not re-walk subflow events.

Example: [examples/runtime-features/flow-recorder/07-inout.ts](examples/runtime-features/flow-recorder/07-inout.ts)

**Three recorder STORAGE PRIMITIVES (since 5.0.0)** — "one purpose per recorder": a store is storage ONLY. You own one as a field and implement the channel interface (`ScopeRecorder` / `FlowRecorder` / `EmitRecorder` / `CombinedRecorder`) yourself, delegating storage to the store. The abstract base classes (`KeyedRecorder` / `SequenceRecorder` / `BoundaryStateTracker`) were REMOVED in 7.0.0 — composition is the only model. Choose a store by data shape and durability:

| Store | Relationship | Time scope | Use When |
|------------|-------------|------------|----------|
| `KeyedStore<T>` | 1:1 Map | durable | Each step produces one record (token totals per step) |
| `SequenceStore<T>` | 1:N sequence + Map | durable | Multiple records per step, ordering matters (narrative, audit) |
| `BoundaryStateStore<TState>` | Map\<key, TState\> active bracket | transient — clears on stop | Live state DURING a `[start, stop]` bracket (LLM stream partial, tool args streaming) |

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { FlowRecorder, EmitRecorder, EmitEvent, FlowStageEvent, FlowDecisionEvent } from 'footprintjs';
import { KeyedStore, SequenceStore, BoundaryStateStore } from 'footprintjs/trace';

// KeyedStore: one entry per step. Own the store; implement the channel.
class TokenRecorder implements FlowRecorder {
  readonly id = 'tokens';
  private store = new KeyedStore<{ tokens: number }>();
  onStageExecuted(e: FlowStageEvent) {
    const rid = e.traversalContext?.runtimeStageId;
    if (rid) this.store.set(rid, { tokens: 10 });
  }
  byStep(rid: string) { return this.store.get(rid); }                       // Translate: per-step value
  total() { return this.store.aggregate((sum, e) => sum + e.tokens, 0); }   // Aggregate: grand total
  upTo(keys: ReadonlySet<string>) {                                          // Accumulate: up to slider
    return this.store.accumulate((sum, e) => sum + e.tokens, 0, keys);
  }
}

// SequenceStore: multiple entries per step, ordered.
class AuditRecorder implements FlowRecorder {
  readonly id = 'audit';
  private store = new SequenceStore<{ runtimeStageId: string; type: string }>();
  onDecision(e: FlowDecisionEvent) {
    this.store.push({ runtimeStageId: e.traversalContext?.runtimeStageId ?? '', type: 'decision' });
  }
  forStep(rid: string) { return this.store.getByKey(rid); }                  // Translate: per-step entries
  upTo(keys: ReadonlySet<string>) { return this.store.getEntriesUpTo(keys); } // Progressive: up to slider
  ranges() { return this.store.getEntryRanges(); }                           // Range index: O(1) slider sync
}

// BoundaryStateStore: transient state DURING a bracket; clears on stop.
class LiveLLMTracker implements EmitRecorder {
  readonly id = 'live-llm';
  private store = new BoundaryStateStore<{ partial: string; tokens: number }>();
  onEmit(e: EmitEvent) {
    const payload = e.payload as { content?: string };
    if (e.name === 'llm.start') this.store.start(e.runtimeStageId, { partial: '', tokens: 0 });
    if (e.name === 'llm.token') this.store.update(e.runtimeStageId, (s) => ({ partial: s.partial + (payload.content ?? ''), tokens: s.tokens + 1 }));
    if (e.name === 'llm.end')   this.store.stop(e.runtimeStageId);
  }
  isInFlight() { return this.store.hasActive; }                              // O(1) — live read
  getPartial(rid: string) { return this.store.get(rid)?.partial ?? ''; }     // O(1) — current state of one boundary
  concurrent() { return this.store.activeCount; }                            // O(1) — how many concurrent boundaries
}
// Lifecycle: call store.clear() between runs; dev-mode warns on leaked-stop bugs.

const tokens = new TokenRecorder();
const audit = new AuditRecorder();
const live = new LiveLLMTracker();

const chart = flowChart<object>('Ask', (scope) => {
    scope.$emit('llm.start', {});
    scope.$emit('llm.token', { content: 'Hel' });
    scope.$emit('llm.token', { content: 'lo' });
    console.log(live.isInFlight(), live.concurrent(), live.getPartial('ask#0')); // mid-bracket
    scope.$emit('llm.end', {});
  }, 'ask')
  .addDeciderFunction('Check', () => 'ok', 'check')
    .addFunctionBranch('ok', 'Ok', () => {})
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(tokens);
executor.attachFlowRecorder(audit);
executor.attachEmitRecorder(live);
await executor.run();

console.log(tokens.total(), tokens.byStep('ask#0'), tokens.upTo(new Set(['ask#0'])));
console.log(live.isInFlight(), live.concurrent(), JSON.stringify(audit.forStep('check#1')), audit.ranges().size);
// true 1 Hello
// 30 { tokens: 10 } 10
// false 0 [{"runtimeStageId":"check#1","type":"decision"}] 1
```

**`getEntryRanges()`** returns a precomputed `Map<runtimeStageId, {firstIdx, endIdx}>` maintained during `push()`. Use for O(1) per-step range lookups during time-travel scrubbing. Same shape as `buildEntryRangeIndex()` in `footprint-explainable-ui`.

**`CombinedNarrativeEntry.direction`** — subflow entries carry `direction: 'entry' | 'exit'` (and `subflowId`). Use for programmatic subflow boundary detection instead of text scanning (which breaks with a custom `NarrativeFormatter`; `NarrativeRenderer` is its deprecated alias).

**`footprint-explainable-ui` narrative utilities** (read from that package's source, 0.38.0) — for consumers building custom shells without `ExplainableShell`:
- `buildEntryRangeIndex(entries)` — build range index from flat array (when no recorder access)
- `computeRevealedEntryCount(entries, snapshots, idx, rangeIndex?)` — slider position → entry count
- `extractSubflowNarrative(entries, subflowId)` — three-tier subflow entry extraction

**How runtimeStageId is generated:** A counter starts at 0 and increments by 1 for each stage execution across the entire run, including subflow stages. Subflow child traversers share the parent counter so indices are globally unique. Stages inside subflows have stageIds already prefixed by the builder (e.g., `sf-tools/execute-tool-calls`), so the engine's `buildRuntimeStageId(prefixedId, idx)` just appends `#index`.

## Dev Mode

One global flag (`enableDevMode()` / `disableDevMode()` / `isDevMode()`) controls every developer-only diagnostic across the library. OFF by default — the diagnostics below run only when it is on.

```typescript
import { flowChart, FlowChartExecutor, enableDevMode, disableDevMode, isDevMode } from 'footprintjs';

console.log(isDevMode());
// false
enableDevMode(); // in a real app: if (process.env.NODE_ENV !== 'production') enableDevMode();

const warnings: string[] = [];
console.warn = (message: string) => { warnings.push(message.split(' — ')[0]); };

const executor = new FlowChartExecutor(flowChart<{ n: number }>('Seed', (scope) => { scope.n = 1; }, 'seed').build());
executor.attachCombinedRecorder({ id: 'empty' }); // no on* handler: warns
await executor.run();
console.log(warnings);
// [
//   "[footprintjs] attachCombinedRecorder: recorder 'empty' has no observer event methods"
// ]
console.log(Object.isFrozen(executor.getSnapshot().sharedState)); // dev mode: a deep-frozen clone, not the live state
// true
disableDevMode();
```

Gated diagnostics (not exhaustive; each is gated on `isDevMode()` in the source):
- **Circular-ref detection** in scope writes (`ScopeFacade.setValue()`) — O(n) WeakSet traversal per write
- **Empty-recorder warning** in `attachCombinedRecorder(r)` — catches `r` with no `on*` handler
- **`decide()` / `select()` rules** that throw while evaluating, or filter ops that are not one of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn` (the rule counts as not matched)
- **Snapshot integrity** in `getSubtreeSnapshot()`
- **Recorder hook errors** — a recorder hook that throws is isolated and, in dev mode, warned about; it does not abort the run — except `onResume`, which the executor calls unguarded (a throw rejects `resume()`), and, in dev mode, a hook that throws a value that cannot be stringified (a null-prototype object rejects `run()`).
- **`getSnapshot().sharedState`** becomes a deep-frozen clone, so a mutation throws instead of corrupting engine state
- **A subflow id mounted twice** — warned at build time (a pause inside it could not be resumed)

Convention: when adding a new dev-only check, gate on `isDevMode()` (from `lib/devMode.ts`). Do NOT use `process.env.NODE_ENV` inline — consumers control dev tooling centrally via `enableDevMode()`/`disableDevMode()`, and inline env checks break that contract.

## Break + Propagation

`scope.$break(reason?)` takes an optional free-form reason string that surfaces on `FlowBreakEvent.reason`. Recorders and narrative consumers see it.

By default, an inner subflow's `$break` stops ONLY the subflow; the parent continues. Opt into propagation via `SubflowMountOptions.propagateBreak: true`:

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const escalateChart = flowChart<{ partial?: string; later?: boolean }>('Escalate', (scope) => {
    scope.partial = 'from-subflow';
    scope.$break('policy violation');
  }, 'escalate')
  .addFunction('NeverRuns', (scope) => { scope.later = true; }, 'never-runs')
  .build();

for (const propagateBreak of [false, true]) {
  const chart = flowChart<{ seed?: boolean; got?: string; after?: boolean }>('Seed', (scope) => { scope.seed = true; }, 'seed')
    .addSubFlowChartNext('sf-escalate', escalateChart, 'Escalate', {
      outputMapper: (sub: { partial?: string }) => ({ got: sub.partial }),
      propagateBreak,                // ← inner $break → parent $break, with reason
    })
    .addFunction('After', (scope) => { scope.after = true; }, 'after')
    .build();
  const executor = new FlowChartExecutor(chart);
  const breaks: string[] = [];
  executor.attachFlowRecorder({
    id: 'breaks',
    onBreak: (e) => { breaks.push(`${e.stageName}: ${e.reason}${e.propagatedFromSubflow ? ` (from ${e.propagatedFromSubflow})` : ''}`); },
  });
  await executor.run();
  console.log(propagateBreak, JSON.stringify(executor.getSnapshot().sharedState), breaks);
}
// false {"seed":true,"got":"from-subflow","after":true} [ 'sf-escalate/Escalate: policy violation' ]
// true {"seed":true,"got":"from-subflow"} [
//   'sf-escalate/Escalate: policy violation',
//   'Escalate: policy violation (from sf-escalate)'
// ]
```

Semantics:
- **Linear chain:** inner `$break(reason)` → parent's `breakFlag` flips → next parent stage does NOT run → `FlowBreakEvent` fires at parent-mount level with `propagatedFromSubflow` + reason.
- **Nested chain:** propagates through every hop that opted in (a hop that did not opt in stops the propagation there). Reason survives.
- **outputMapper still runs** before propagation — subflow's partial state lands in parent before the break (`got` above). Escape hatch: early-return `{}` from outputMapper when the break state is set.
- **Parallel/fan-out:** a `$break` in a fork child stops that child; the parent continues after the fork even when EVERY child broke (the "all children broke" rule in `ChildrenExecutor` is not wired in 9.32.0). `propagateBreak: true` does not change that.

Example: [examples/runtime-features/break/04-subflow-propagate.ts](examples/runtime-features/break/04-subflow-propagate.ts).

## Emit Channel (Phase 3)

Third observer channel alongside `ScopeRecorder` (data-flow) and `FlowRecorder` (control-flow). Consumer stage code emits structured events; `EmitRecorder.onEmit(event)` fires synchronously with auto-enriched context.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { EmitRecorder, EmitEvent } from 'footprintjs';

const tallies: unknown[] = [];
const rec: EmitRecorder = {
  id: 'token-meter',
  onEmit: (e) => { if (e.name === 'myapp.llm.tokens') tallies.push(e.payload); },
};

const sub = flowChart<object>('SubStage', (scope) => { scope.$emit('myapp.sub.event', { in: 'sub' }); }, 'sub-stage').build();
const chart = flowChart<object>('Meter', (scope) => {
    // Inside a stage:
    scope.$emit('myapp.llm.tokens', { input: 100, output: 50 });
    scope.$emit('myapp.auth.check', { secret: 'x' });   // matched by emitPatterns below
    scope.$debug('k', 1); scope.$error('e', 2); scope.$metric('m', 3); scope.$eval('ev', 4); scope.$log('hello');
  }, 'meter')
  .addSubFlowChartNext('sf', sub, 'Sub')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative({
  renderer: {
    renderEmit: (ctx) => (ctx.name === 'myapp.llm.tokens' ? `Tokens: ${JSON.stringify(ctx.payload)}` : undefined),
  },
});
executor.setRedactionPolicy({ emitPatterns: [/\.auth\./] });
executor.attachEmitRecorder(rec); // Recorder observes
const seen: EmitEvent[] = [];
executor.attachEmitRecorder({ id: 'all', onEmit: (e) => { seen.push(e); } });
await executor.run();

console.log(JSON.stringify(tallies));
// [{"input":100,"output":50}]
console.log(seen.map((e) => e.name));
// [
//   'myapp.llm.tokens',
//   'myapp.auth.check',
//   'log.debug.k',
//   'log.error.e',
//   'metric.m',
//   'eval.ev',
//   'log.debug.messages',
//   'myapp.sub.event'
// ]
const { timestamp, ...enriched } = seen[seen.length - 1];
console.log(JSON.stringify(enriched), typeof timestamp);
// {"name":"myapp.sub.event","payload":{"in":"sub"},"stageName":"sf/SubStage","runtimeStageId":"sf/sub-stage#2","subflowPath":["sf"],"pipelineId":""} number
console.log(JSON.stringify(seen[1].payload));
// "[REDACTED]"
console.log(executor.getNarrativeEntries().filter((e) => e.type === 'emit').map((e) => e.text).slice(0, 3));
// [
//   'Tokens: {"input":100,"output":50}',
//   '[emit] myapp.auth.check: "[REDACTED]"',
//   '[emit] log.debug.k: {key, value, level}'
// ]
```

### Semantics
- **Pass-through.** Delivered synchronously, in call order. `ScopeFacade.emitEvent` returns immediately when no recorder is attached.
- **Auto-enriched.** Events carry `stageName`, `runtimeStageId`, `subflowPath`, `pipelineId`, `timestamp` — in a subflow, the stage name and runtimeStageId carry the path prefix and `subflowPath` lists it.
- **Error-isolated.** A throwing `onEmit` doesn't propagate; errors route to `onError` on other recorders.
- **Redactable.** `RedactionPolicy.emitPatterns: RegExp[]` matches `event.name`; matched payloads become `'[REDACTED]'` before dispatch.
- **Buffered in narrative.** `CombinedNarrativeRecorder.onEmit` buffers alongside reads/writes; flushed in `flushOps` so emit entries appear AFTER the stage header in ordered narrative.

### Naming convention
Hierarchical dotted names — `<namespace>.<category>.<event>` (a convention: any name is accepted). Examples:
- `'agentfootprint.llm.tokens'`, `'agentfootprint.llm.request'`
- `'myapp.billing.spend'`, `'myapp.auth.check'`

### Legacy primitives route through this channel
`$debug`, `$metric`, `$error`, `$eval`, `$log` also dispatch on the emit channel (in addition to their existing `DiagnosticCollector` side-bag writes for snapshot inclusion):

```
$debug(key, value)    → emits 'log.debug.${key}'
$error(key, value)    → emits 'log.error.${key}'
$metric(name, value)  → emits 'metric.${name}'
$eval (name, value)   → emits 'eval.${name}'
$log(value)           → emits 'log.debug.messages'
```

So `$metric` / `$debug` are observable by recorders in real time; the side bags still populate for consumers that inspect snapshots directly.

A redaction policy's state selectors also select a diagnostic entry by its NAME (`keys: ['token']` masks `$debug('token', …)`, `$error`, `$metric` and a `token` nested in a logged record). `RedactionPolicy.diagnostics` adds diagnostic-only selectors (`logs`, `errors`, `metrics`, `evals` and flow-message text, which has no name of its own). The collector decides before storage; the facade emits the same retained incoming value, then applies any `emitPatterns` whole-wrapper mask. Do not re-scrub at recorders or snapshot export. Entries and flow metadata remain; the checkpoint's operational state stays real. See `docs/guides/scope.md` → "The one law" and "Explicit diagnostic redaction".

### Customizing narrative rendering
`NarrativeFormatter.renderEmit?(ctx)` hook (passed as `enableNarrative({ renderer })`) renders an emit event into a narrative line. Return `string` to use, `null` to exclude, `undefined` to fall back to the default `[emit] name: payloadSummary` (above: the first line is the custom one, the rest are defaults).

Example: [examples/runtime-features/emit/01-custom-events.ts](examples/runtime-features/emit/01-custom-events.ts).

## Combined Recorder

A `CombinedRecorder` is an observer that hooks into multiple event streams (scope data-flow, control-flow, AND emit — all three channels). One object, one `id`, one `attachCombinedRecorder()` call — the library routes to the right channels via runtime method-shape detection.

```typescript
import { flowChart, FlowChartExecutor, isFlowEvent } from 'footprintjs';
import type { CombinedRecorder } from 'footprintjs';

const log = (...parts: unknown[]) => console.log(...parts);

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

const chart = flowChart<{ n: number }>('Seed', (scope) => { scope.n = 1; }, 'seed')
  .addFunction('Boom', () => { throw new Error('kaput'); }, 'boom')
  .build();

const executor = new FlowChartExecutor(chart);
executor.attachCombinedRecorder(audit);
await executor.run().catch(() => undefined);
// scope write n
// flow error in Boom
```

Built on `CombinedRecorder`: `CombinedNarrativeRecorder` (the `executor.enableNarrative()` default). Consumers implement ONLY the events they care about — `Partial<ScopeRecorder> & Partial<FlowRecorder> & Partial<EmitRecorder>` under the hood.

**Detection rule:** a handler counts when it is an OWN property OR a method on the recorder's class prototype chain — class instances work. Only handlers inherited from `Object.prototype` are ignored (prevents accidental `Object.prototype` pollution from attaching handlers).

## Anti-Patterns

- Never post-process the tree — use recorders (or the `footprintjs/trace` queries over the recorded log)
- Don't use `getValue()`/`setValue()` for keys you know in TypedScope stages — use typed property access (`$getValue`/`$setValue` are for dynamic keys; plain `scope.getValue` does not exist there)
- Don't give a state key the name of a `$` method (`scope.$break = 1` throws "conflicts with a reserved TypedScope method") — the reserved names are `SCOPE_METHOD_NAMES` in `footprintjs/advanced`; avoid `$`-prefixed state keys altogether
- Don't write a state key that is also a `run({ input })` key — input keys are read-only for the run
- `CombinedNarrativeBuilder` is gone (removed in v1.0) — the narrative comes from `CombinedNarrativeRecorder` via `executor.enableNarrative()` or the `narrative()` factory
- Don't extract a shared base for scope and flow recorders — built-ins compose a store (`KeyedStore` / `SequenceStore`) as a field
- Don't use `getArgs()` for tracked data — use typed scope properties
- Don't put infrastructure data in `getArgs()` — use `getEnv()` via `run({ env })`
- Don't hand-roll a recorder to get the narrative — `executor.enableNarrative()` (or `chart.recorder(narrative())`) is the whole setup, and it is off until called
- Don't end a loop with `return` — `.loopTo(id)` is unconditional; exit through a decider branch or `scope.$break()`
- Don't return full arrays from `outputMapper` without `arrayMerge: ArrayMergeMode.Replace` — default `applyOutputMapping` **concatenates** arrays (`[...parent, ...subflow]`). Either return only the **delta** (new items), or set `arrayMerge: ArrayMergeMode.Replace` on `SubflowMountOptions` to overwrite instead of concatenate. Scalars are always replaced regardless. `ArrayMergeMode` is exported from `footprintjs/advanced` (not the main door).

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { ArrayMergeMode } from 'footprintjs/advanced';

const sub = flowChart<{ items?: string[] }>('Sub', (scope) => { scope.items = ['a', 'b']; }, 'sub').build();
for (const arrayMerge of [ArrayMergeMode.Concat, ArrayMergeMode.Replace]) {
  const chart = flowChart<{ items: string[] }>('Seed', (scope) => { scope.items = ['a']; }, 'seed')
    .addSubFlowChartNext('sf', sub, 'Sub', { outputMapper: (out: { items?: string[] }) => ({ items: out.items }), arrayMerge })
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  console.log(arrayMerge, JSON.stringify(executor.getSnapshot().sharedState.items));
}
// concat ["a","a","b"]
// replace ["a","b"]
```

## Build & Test

```bash
npm run build           # tsc (CJS) + tsc -p tsconfig.esm.json (ESM) + scripts/postbuild-esm.mjs
npm test                # full suite (vitest)
npm run test:examples   # type-check examples/, build, then run the fork example guard
npm run lint
npm run check:layering  # the layering rule and the closed record, from scripts/layering.config.cjs
npm run check:doc-snippets # strict, isolated import-bearing TS fences; see scripts/doc-snippets/README.md
```

Dual output: CommonJS (`dist/`) + ESM (`dist/esm/`) + types (`dist/types/`)
