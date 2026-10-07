---
name: footprint
description: Use when building flowchart pipelines with footprintjs — stage functions, decider branches, selectors, subflows, loops, narrative traces, recorders, redaction, contracts, and LLM-ready output. Also use when someone asks how footprint.js works or wants to understand the library.
---

# footprint.js — The Flowchart Pattern for Backend Code

footprint.js structures backend logic as a graph of named functions with transactional state. Every run records a commit log of what each stage wrote. Turn the narrative on (`executor.enableNarrative()`) and the same run also produces a plain-English trace of what happened and why, collected inline while the stages execute.

**Core principle:** All data collection happens during the single DFS traversal pass — never post-process or walk the tree again.

```bash
npm install footprintjs
```

> Every TypeScript block in this file is type-checked (strict) and run against the built package (footprintjs 9.32.0); the `// …` lines under a `console.log` are that run's real output.

---

## Quick Start

```typescript
import { flowChart, FlowChartExecutor, narrative } from 'footprintjs';

interface OrderState {
  orderId: string;
  amount: number;
  paymentStatus: string;
}

const chart = flowChart<OrderState>('ReceiveOrder', (scope) => {
    scope.orderId = 'ORD-123';
    scope.amount = 49.99;
  }, 'receive-order', { description: 'Receive and validate the incoming order' })
  .addFunction('ProcessPayment', (scope) => {
    const amount = scope.amount;
    scope.paymentStatus = amount < 100 ? 'approved' : 'review';
  }, 'process-payment', 'Charge customer and record payment status')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative(); // the narrative is OFF until you ask for it
await executor.run();

// getNarrativeEntries() returns CombinedNarrativeEntry[] — objects, not strings
for (const entry of executor.getNarrativeEntries()) {
  console.log('  '.repeat(entry.depth) + entry.text);
}
// Stage 1: The process began: Receive and validate the incoming order.
//   Step 1: Write orderId = "ORD-123"
//   Step 2: Write amount = 49.99
// Stage 2: Next step: Charge customer and record payment status.
//   Step 1: Read amount = 49.99
//   Step 2: Write paymentStatus = "approved"

// One-shot alternative: attach a recorder to the BUILT CHART, read the entries back from the recorder
const trace = narrative();
const result = await chart.recorder(trace).run(); // RunResult — there is no executor in this form
console.log(Object.keys(result), trace.getEntries().length);
// [ 'state', 'output', 'executionTree', 'commitLog' ] 6
```

- The narrative is off until `executor.enableNarrative()` (attaching a FlowRecorder switches it on too). Without it, `getNarrativeEntries()` returns `[]`.
- `getNarrativeEntries()` returns **entries** (`type`, `text`, `depth`, `stageName`, …), not strings. `'  '.repeat(e.depth) + e.text`, joined with `\n`, is the text to feed an LLM for grounded explanations; `.map((e) => e.text)` gives plain lines.
- `.recorder()` and `.redact()` live on the built **chart** (`chart.recorder(narrative()).run()` returns a `RunResult`: `{ state, output, executionTree, commitLog }`). `FlowChartExecutor` has no `recorder()` — it has `enableNarrative()` and the `attach*Recorder` methods.

---

## FlowChartBuilder API

Always chain from `flowChart<T>()` (recommended) or `flowChart()`.

### Linear Stages

```typescript
import { flowChart } from 'footprintjs';

interface MyState {
  valueA: string;
  valueB: number;
  valueC: boolean;
}

const chart = flowChart<MyState>('StageA', (scope) => { scope.valueA = 'a'; }, 'stage-a', { description: 'Description of A' })
  .addFunction('StageB', (scope) => { scope.valueB = 2; }, 'stage-b', 'Description of B')
  .addFunction('StageC', (scope) => { scope.valueC = true; }, 'stage-c', 'Description of C')
  .build();
```

**Parameters:** the first stage is `flowChart(name, fn, id, { description? })`; every later stage is `.addFunction(name, fn, id, description?)`.

- `name` — human-readable label (used in narrative)
- `fn` — the stage function, `(scope) => void | Promise<void>`
- `id` — stable identifier (used for branching, visualization, loop targets)
- `description` — optional; the stage's narrative line uses it in place of the name ("Next step: Charge customer…"), and it feeds the generated OpenAPI / MCP tool descriptions

### Stage Function Signature (TypedScope)

With `flowChart<T>()`, stage functions receive a `TypedScope<T>` proxy. All reads and writes use typed property access:

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface LoanState {
  creditTier: string;
  amount: number;
  customer: { name: string; address: { zip: string } };
  tags: string[];
  approved?: boolean;
}

const chart = flowChart<LoanState>('Assess', (scope) => {
  // Typed writes (tracked — appear in the narrative)
  scope.creditTier = 'A';
  scope.amount = 50000;
  scope.customer = { name: 'Ana', address: { zip: '10001' } };
  scope.tags = [];

  // Deep write — recorded as an update of `customer`
  scope.customer.address.zip = '90210';

  // Array methods work (copy-on-write)
  scope.tags.push('vip');

  // Optional fields are plain writes
  scope.approved = true;

  // $-prefixed escape hatches for everything that is not state
  scope.$debug('checkpoint', { step: 1 }); // stage `logs` + emit event `log.debug.checkpoint`
  scope.$metric('latency', 42);            // stage `metrics` + emit event `metric.latency`
  const { requestId } = scope.$getArgs<{ requestId: string }>(); // frozen input
  const { traceId } = scope.$getEnv();                            // frozen env
  console.log(requestId, traceId);
  scope.$break('done early'); // stop the run here (the reason is optional)
}, 'assess').build();

await new FlowChartExecutor(chart).run({
  input: { requestId: 'r-1' },
  env: { traceId: 'req-123' },
});
// r-1 req-123
```

**Three access tiers:**
- **Typed properties** (`scope.amount = 50000`) — mutable shared state, tracked in the narrative
- **`$getArgs()`** — frozen business input from `run({ input })`, NOT tracked
- **`$getEnv()`** — frozen infrastructure context from `run({ env })`, NOT tracked. Returns `ExecutionEnv { signal?, timeoutMs?, traceId? }` (a fixed type), inherited by subflows

The keys of `run({ input })` are read-only for the whole run: a stage that writes (or deletes) a state key with the same name throws. Give input and state different names (`input: { name }` → `scope.applicantName`):

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart<{ requestId: string }>('Clash', (scope) => {
  scope.requestId = 'r-2'; // same name as an input key
}, 'clash').build();

await new FlowChartExecutor(chart).run({ input: { requestId: 'r-1' } }).catch((e: Error) => console.log(e.message));
// Cannot write to readonly input key "requestId" — use getArgs() to read input values
```

### Decider Branches with decide() (Single-Choice Conditional)

Use `decide()` for structured decision evidence capture. It records which values led to the decision, in the narrative and on the `onDecision` event.

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface RiskState {
  creditScore: number;
  dti: number;
}

function buildChart(creditScore: number, dti: number) {
  return flowChart<RiskState>('Intake', (scope) => {
      scope.creditScore = creditScore;
      scope.dti = dti;
    }, 'intake')
    .addDeciderFunction('AssessRisk', (scope) => {
      // decide() captures filter evidence automatically
      return decide(scope, [
        { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'low-risk', label: 'Good credit' },
        { when: (s) => s.creditScore > 600, then: 'medium-risk', label: 'Marginal credit' },
      ], 'high-risk');
    }, 'assess-risk', 'Evaluate risk and route accordingly')
      .addFunctionBranch('high-risk', 'RejectApplication', () => {}, 'Reject due to high risk')
      .addFunctionBranch('medium-risk', 'ManualReview', () => {}, 'Send to manual review')
      .addFunctionBranch('low-risk', 'ApproveApplication', () => {}, 'Approve the application')
      .setDefault('high-risk') // fallback when the decider returns an id that matches no branch
      .end()
    .build();
}

for (const [creditScore, dti] of [[750, 0.35], [650, 0.5], [500, 0.9]]) {
  const executor = new FlowChartExecutor(buildChart(creditScore, dti));
  executor.enableNarrative();
  await executor.run();
  console.log(executor.getNarrativeEntries().find((e) => e.type === 'condition')?.text);
}
// [Condition]: It evaluated Rule 0 "Good credit": creditScore 750 gt 700 ✓, dti 0.35 lt 0.43 ✓, and chose ApproveApplication.
// [Condition]: It examined "Marginal credit": creditScore=650, and chose ManualReview.
// [Condition]: No rules matched, fell back to default: RejectApplication.
```

`decide(scope, rules, defaultBranch)` returns `{ branch, evidence }`. The engine runs the child whose branch id equals `branch`; the evidence rides the narrative line and the `onDecision` event (`event.evidence`). A decider may also just return a branch-id string.

The `when` of a rule takes two formats:
- **Filter format:** `{ creditScore: { gt: 700 } }` — declarative; the evidence records each key, operator, threshold and actual value
- **Function format:** `(s) => s.creditScore > 600` — arbitrary logic with an optional `label`; the evidence records which keys it read

`.setDefault(id)` names the fallback branch for an id that matches no child. Without it, that run throws.

### Selector Branches with select() (Multi-Choice Fan-Out)

Use `select()` for structured multi-choice evidence capture. Every rule that matches picks its branch (not first-match), and the picked branches run in parallel:

```typescript
import { flowChart, FlowChartExecutor, select } from 'footprintjs';

interface CheckState {
  needsCredit: boolean;
  needsIdentity: boolean;
}

const chart = flowChart<CheckState>('Intake', (scope) => {
    scope.needsCredit = true;
    scope.needsIdentity = true;
  }, 'intake')
  .addSelectorFunction('SelectChecks', (scope) => {
    return select(scope, [
      { when: { needsCredit: { eq: true } }, then: 'credit-check', label: 'Credit required' },
      { when: { needsIdentity: { eq: true } }, then: 'identity-check', label: 'Identity required' },
    ]);
  }, 'select-checks')
    .addFunctionBranch('credit-check', 'CreditCheck', () => {})
    .addFunctionBranch('identity-check', 'IdentityCheck', () => {})
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();
console.log(executor.getNarrativeEntries().find((e) => e.type === 'fork')?.text);
// [Parallel]: Forking into 2 parallel paths: CreditCheck, IdentityCheck.
```

`select()` returns `{ branches, evidence }` (the `onSelected` event carries the evidence). A selector may also return a plain array of branch ids.

### Parallel Execution (Fork)

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface CheckState {
  a?: number;
  b?: number;
  total?: number;
}

const chart = flowChart<CheckState>('Start', () => {}, 'start')
  .addListOfFunction([
    { id: 'check-a', name: 'CheckA', fn: (scope) => { scope.a = 1; } },
    { id: 'check-b', name: 'CheckB', fn: (scope) => { scope.b = 2; } },
  ], { failFast: true }) // reject on the first failing child
  .addFunction('Join', (scope) => {
    // each child's writes sit under runs/<childId>/, not at the top level
    scope.total = (scope.$read('runs.check-a.a') as number) + (scope.$read('runs.check-b.b') as number);
  }, 'join')
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run();
console.log(JSON.stringify(executor.getSnapshot().sharedState));
// {"runs":{"check-a":{"a":1},"check-b":{"b":2}},"total":3}
```

- `failFast: true` rejects the run on the first failing child. Omit it and the other children, and the stages after the fork, still run (the failed child is contained).
- A child's typed writes land under `runs/<childId>/…` in shared state. The stage after the fork reads them with `scope.$read('runs.check-a.a')`; `scope.a` is `undefined` there. The same holds when a selector picks several branches together.
- When the fork is the last stage, `run()` resolves `{ 'check-a': { id, result, isError }, … }` — the children's return values.
- To get a child's output into the parent as plain keys, make the child a subflow with an `outputMapper` (`addSubFlowChart`, see below).

### Subflows (Nested Flowcharts)

```typescript
import { flowChart, FlowChartExecutor, ManifestFlowRecorder } from 'footprintjs';

interface CreditState {
  ssn: string;
  score?: number;
}

interface MainState {
  ssn: string;
  creditScore?: number;
  route?: string;
}

// A reusable sub-pipeline — it runs in its OWN isolated state
const creditSubflow = flowChart<CreditState>('PullReport', (scope) => { scope.score = scope.ssn.length * 70; }, 'pull-report')
  .addFunction('ScoreReport', (scope) => { scope.score = (scope.score ?? 0) + 1; }, 'score-report')
  .build();

const chart = flowChart<MainState>('Intake', (scope) => { scope.ssn = '123-45'; }, 'intake')
  // Mount as linear continuation
  .addSubFlowChartNext('credit-sub', creditSubflow, 'CreditCheck', {
    inputMapper: (parentScope: MainState) => ({ ssn: parentScope.ssn }),
    outputMapper: (subOut: CreditState) => ({ creditScore: subOut.score }),
  })
  // Mount as decider branch
  .addDeciderFunction('Route', () => 'detailed', 'route')
    .addSubFlowChartBranch('detailed', creditSubflow, 'DetailedCheck', {
      inputMapper: (parentScope: MainState) => ({ ssn: parentScope.ssn }),
      outputMapper: (subOut: CreditState) => ({ route: `detailed:${subOut.score}` }),
    })
    .addFunctionBranch('simple', 'SimpleCheck', (scope) => { scope.route = 'simple'; })
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(new ManifestFlowRecorder()); // getSubflowManifest() reads from it
await executor.run();
console.log(JSON.stringify(executor.getSnapshot().sharedState));
// {"ssn":"123-45","creditScore":421,"route":"detailed:421"}
console.log(JSON.stringify(executor.getSubflowManifest().map((m) => m.subflowId)));
// ["credit-sub","detailed"]
```

`inputMapper` returns the subflow's input: readable as `scope.key` and `$getArgs()`, but read-only — a subflow stage that writes one of those keys throws, as with `run({ input })`. Without an `inputMapper` the subflow starts empty and sees none of the parent's keys. `outputMapper(subOut, parentScope)` returns the keys to merge back into the parent.

### Loops

`.loopTo(id)` is an unconditional back-edge. Exit through a decider branch — `.addFunctionBranch(…).loopTo(id)` makes the loop edge come from that branch — or with `scope.$break()`:

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface RetryState {
  attempts: number;
  paymentResult?: string;
}

const chart = flowChart<RetryState>('Start', (scope) => { scope.attempts = 0; }, 'start')
  .addFunction('Charge', (scope) => { scope.attempts = scope.attempts + 1; }, 'charge')
  .addDeciderFunction('Check', (scope) => decide(scope, [
      { when: { attempts: { lt: 3 } }, then: 'again', label: 'fewer than 3 attempts' },
    ], 'done'), 'check')
    .addFunctionBranch('again', 'TryAgain', () => {})
    .loopTo('charge') // back-edge FROM the 'again' branch to the stage whose id is 'charge'
    .addFunctionBranch('done', 'Done', (scope) => { scope.paymentResult = 'paid'; })
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run();
console.log(JSON.stringify(executor.getSnapshot().sharedState));
// {"attempts":3,"paymentResult":"paid"}

// A stage followed directly by .loopTo() has no exit of its own: returning does NOT leave the loop
const spin = (exit: boolean) => flowChart<RetryState>('Start', (scope) => { scope.attempts = 0; }, 'start')
  .addFunction('Retry', (scope) => {
    scope.attempts = scope.attempts + 1;
    if (exit && scope.attempts >= 3) scope.$break('enough attempts'); // $break() ends the run
  }, 'retry')
  .loopTo('retry')
  .build();

const withBreak = new FlowChartExecutor(spin(true));
await withBreak.run();
console.log(JSON.stringify(withBreak.getSnapshot().sharedState));
// {"attempts":3}

try {
  await new FlowChartExecutor(spin(false)).run({ maxIterations: 6 }); // the guard; default 1000 per node
} catch (error) {
  console.log((error as Error).message);
}
// Maximum loop iterations (6) exceeded for node 'retry'. Set maxIterations to increase the limit.
```

### Configuration

`builder.contract({ input, output, mapper })` declares the chart's I/O contract — see Contracts & OpenAPI below.

### Output

```typescript
import { flowChart } from 'footprintjs';

const builder = flowChart('Receive', () => {}, 'receive')
  .addFunction('Assess', () => {}, 'assess');

const chart = builder.build();       // for the executor — also has toMermaid() / toOpenAPI() / toMCPTool()
const spec = builder.toSpec();       // JSON-safe structure for visualization — on the BUILDER, not the built chart
const mermaid = builder.toMermaid(); // Mermaid diagram string (chart.toMermaid() returns the same)

console.log(Object.keys(spec), chart.toMermaid() === mermaid);
// [ 'name', 'id', 'type', 'next' ] true
console.log(mermaid);
// flowchart TD
// receive["Receive"]
// receive --> assess
// assess["Assess"]
```

---

## FlowChartExecutor API

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface AppState {
  applicantName: string;
  income: number;
  riskTier?: string;
}

const chart = flowChart<AppState>('ReceiveApplication', (scope) => {
    const args = scope.$getArgs<{ name: string; annualIncome: number }>(); // input keys differ from state keys
    scope.applicantName = args.name;
    scope.income = args.annualIncome;
  }, 'receive-application')
  .addFunction('AssessRisk', (scope) => { scope.riskTier = scope.income < 50000 ? 'high' : 'low'; }, 'assess-risk')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative(); // before run()

// Run with input and optional execution environment
await executor.run({
  input: { name: 'Bob', annualIncome: 42000 },
  env: { traceId: 'req-123', timeoutMs: 5000 },
});

// Narrative text: render the indent from entry.depth (see Quick Start)
const entries = executor.getNarrativeEntries(); // CombinedNarrativeEntry[]

// Structured entries (for programmatic access)
console.log(JSON.stringify(entries[0]));
// {"type":"stage","text":"Stage 1: The process began with ReceiveApplication.","depth":0,"stageName":"ReceiveApplication","stageId":"receive-application","runtimeStageId":"receive-application#0"}
console.log(JSON.stringify(entries[1]));
// {"type":"step","text":"Step 1: Write applicantName = \"Bob\"","depth":1,"stageName":"ReceiveApplication","stageId":"receive-application","runtimeStageId":"receive-application#0","stepNumber":1,"key":"applicantName","rawValue":"Bob"}

// Full memory snapshot
const snapshot = executor.getSnapshot();
console.log(JSON.stringify(Object.keys(snapshot)));
// ["sharedState","executionTree","initialState","commitLog","commitValues","writeProvenance","runId"]
console.log(JSON.stringify(snapshot.sharedState));
// {"applicantName":"Bob","income":42000,"riskTier":"high"}

// Flow-only narrative: drop the read/write steps
console.log(JSON.stringify(entries.filter((e) => e.type !== 'step').map((e) => e.text)));
// ["Stage 1: The process began with ReceiveApplication.","Stage 2: Next, it moved on to AssessRisk."]
```

- `getSnapshot()` also carries `subflowResults` (only when a subflow ran — a plain object keyed by subflow id and by mount `runtimeStageId`, not a Map), `recorders` (one row per attached recorder that implements `toSnapshot()`) and `observerStats` (only when a recorder was attached with `{ delivery: 'deferred' }`). `sharedState` is the LIVE state: treat it as read-only.
- `executor.run()` validates `input` against a declared contract but does not apply the contract's `mapper` — that is `chart.run()` → `result.output`.

---

## Recorder System — Collect During Traversal

**The core innovation.** Three observer channels fire during the single DFS pass (and a build-time `StructureRecorder` on the builder):

- **Scope recorders** — data operations (reads, writes, commits)
- **Flow recorders** — control flow (stages, decisions, forks, loops, subflows)
- **Emit recorders** — your own `scope.$emit(name, payload)` events, plus what `$debug` / `$metric` emit

`executor.attachCombinedRecorder(r)` attaches ONE object that implements hooks from several channels; the library routes it by method shape.

### Scope Recorders (data operations)

Fire during typed property access (reads/writes). Attach via `executor.attachScopeRecorder()` before `run()`:

```typescript
import { flowChart, FlowChartExecutor, MetricRecorder, DebugRecorder } from 'footprintjs';

const chart = flowChart<{ amount: number; status?: string }>('Receive', (scope) => { scope.amount = 49.99; }, 'receive')
  .addFunction('Charge', (scope) => { scope.status = scope.amount < 100 ? 'approved' : 'review'; }, 'charge')
  .build();

const executor = new FlowChartExecutor(chart);

// Built-in recorders (the factories metrics() / debug() in 'footprintjs/recorders' build the same ones)
const metrics = new MetricRecorder();
const debug = new DebugRecorder({ verbosity: 'verbose' }); // an options object; or 'minimal'

// Attach to executor (one-liner, no custom scopeFactory needed)
executor.attachScopeRecorder(metrics);
executor.attachScopeRecorder(debug);

await executor.run();

// After execution
const { totalReads, totalWrites, totalCommits, stageMetrics } = metrics.getMetrics();
console.log(totalReads, totalWrites, totalCommits, [...stageMetrics.keys()]);
// 1 2 2 [ 'Receive', 'Charge' ]
console.log(JSON.stringify(debug.getEntries().slice(1, 3).map(({ type, stageName, data }) => ({ type, stageName, data }))));
// [{"type":"write","stageName":"Receive","data":{"key":"amount","value":49.99,"operation":"set","pipelineId":""}},{"type":"stageEnd","stageName":"Receive","data":{"pipelineId":""}}]
```

### FlowRecorders (control flow events)

Attached to the executor, fire after each stage/decision/fork. Attach before `run()`; read the result off the recorder:

```typescript
import { flowChart, FlowChartExecutor, decide, MilestoneNarrativeFlowRecorder } from 'footprintjs';

const chart = flowChart<{ count: number }>('Start', (scope) => { scope.count = 0; }, 'start')
  .addFunction('Work', (scope) => { scope.count = scope.count + 1; }, 'work')
  .addDeciderFunction('Check', (scope) => decide(scope, [
      { when: { count: { lt: 8 } }, then: 'again', label: 'under 8' },
    ], 'done'), 'check')
    .addFunctionBranch('again', 'Again', () => {})
    .loopTo('work')
    .addFunctionBranch('done', 'Done', () => {})
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
const milestones = new MilestoneNarrativeFlowRecorder(3); // loops: every 3rd pass
executor.attachFlowRecorder(milestones);
await executor.run();

console.log(JSON.stringify(milestones.getSentences().filter((line) => line.includes('pass'))));
// ["On pass 1 through Work.","On pass 3 through Work.","On pass 6 through Work."]
```

9 built-in strategies, all `FlowRecorder`s. Eight render the control-flow narrative and you read them back with `.getSentences()` — `NarrativeFlowRecorder` and seven subclasses that differ in how they treat loop iterations; `ManifestFlowRecorder` collects subflows instead:

| Class | What it does |
|---|---|
| `NarrativeFlowRecorder` | every control-flow event as a sentence — the base the next seven extend |
| `SilentNarrativeFlowRecorder` | no per-iteration sentences — one summary ("Looped 7 times through Work.") |
| `AdaptiveNarrativeFlowRecorder(threshold, sampleRate)` | full detail up to `threshold`, then every `sampleRate`-th pass |
| `WindowedNarrativeFlowRecorder(head, tail)` | the first `head` and last `tail` passes; the middle becomes one line |
| `RLENarrativeFlowRecorder` | run-length encodes repeated loops ("Looped through Work 7 times (passes 1–7).") |
| `MilestoneNarrativeFlowRecorder(interval)` | every `interval`-th pass (the first is always kept) |
| `ProgressiveNarrativeFlowRecorder(base)` | exponentially sparser: passes 1, 2, 4, 8, … |
| `SeparateNarrativeFlowRecorder` | loop sentences leave the main list; read them with `.getLoopSentences()` |
| `ManifestFlowRecorder` | collects the subflows that were entered — `.getManifest()`, `.getSpec(id)`; `executor.getSubflowManifest()` reads it |

### Custom FlowRecorder

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { FlowRecorder, FlowStageEvent, FlowDecisionEvent } from 'footprintjs';

const chart = flowChart<{ score: number }>('Seed', (scope) => { scope.score = 750; }, 'seed')
  .addDeciderFunction('Route', (scope) => decide(scope, [
      { when: { score: { gt: 700 } }, then: 'top', label: 'High score' },
    ], 'rest'), 'route')
    .addFunctionBranch('top', 'Top', () => {})
    .addFunctionBranch('rest', 'Rest', () => {})
    .end()
  .build();

const myRecorder: FlowRecorder = {
  id: 'my-recorder',
  onStageExecuted(event: FlowStageEvent) {
    console.log(`Executed: ${event.stageName}`);
  },
  onDecision(event: FlowDecisionEvent) {
    console.log(`Decision at ${event.decider}: chose ${event.chosen}`);
    // event.evidence available when using decide()
    if (event.evidence) {
      console.log(`Evidence: ${JSON.stringify(event.evidence.rules.map((rule) => rule.label))}`);
    }
  },
  clear() {
    // Reset state before each run
  },
};

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(myRecorder);
await executor.run();
// Executed: Seed
// Decision at Route: chose Top
// Evidence: ["High score"]
// Executed: Route
// Executed: Top
```

`event.decider` and `event.chosen` are the decider's and the chosen branch's **names** (`Route`, `Top`); the branch ids are in `event.evidence` (`evidence.chosen`).

### CombinedNarrativeRecorder (what powers the narrative)

It implements the scope, flow AND emit hooks in one object. It buffers a stage's reads and writes and flushes them when that stage's flow event arrives (`onStageExecuted` for a linear stage; `onDecision` / `onSelected` / `onFork` / `onSubflowEntry` for the other kinds), so the entries come out merged, in order, in a single pass.

**You don't create it.** `executor.enableNarrative()` installs it, and the `narrative()` factory (from `footprintjs` or `footprintjs/recorders`) returns one for `chart.recorder(narrative())`. It is not exported as a class.

---

## Redaction (PII Protection)

```typescript
import { flowChart, FlowChartExecutor, DebugRecorder } from 'footprintjs';

interface FormState {
  ssn: string;
  password: string;
  applicant: { name: string; ssn: string; address: { zip: string; city: string } };
}

const chart = flowChart<FormState>('Collect', (scope) => {
  scope.ssn = '123-45-6789';
  scope.password = 'hunter2';
  scope.applicant = { name: 'Bob', ssn: '999-99-9999', address: { zip: '90210', city: 'LA' } };
}, 'collect').build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
const debug = new DebugRecorder({ verbosity: 'verbose' });
executor.attachScopeRecorder(debug);

executor.setRedactionPolicy({                       // before run()
  keys: ['ssn', 'creditCardNumber'],                // exact key names
  patterns: [/password/i, /^secret.*/],             // regex patterns
  fields: { applicant: ['ssn', 'address.zip'] },    // nested field paths
});

await executor.run();

// Narrative shows the placeholder
console.log(JSON.stringify(executor.getNarrativeEntries().filter((e) => e.type === 'step').map((e) => e.text)));
// ["Step 1: Write ssn = \"[REDACTED]\"","Step 2: Write password = \"[REDACTED]\"","Step 3: Write applicant = {name, ssn, address}"]
// Recorders receive scrubbed values, nested fields included
console.log(JSON.stringify(debug.getEntries().filter((e) => e.type === 'write').map((e) => e.data)[2]));
// {"key":"applicant","value":{"name":"Bob","ssn":"[REDACTED]","address":{"zip":"[REDACTED]","city":"LA"}},"operation":"set","pipelineId":""}
// Compliance report: names only — never contains actual values
console.log(JSON.stringify(executor.getRedactionReport()));
// {"redactedKeys":["ssn","password"],"fieldRedactions":{"applicant":["ssn","address.zip"]},"patterns":["password","^secret.*"]}
// A scrubbed copy of the state — the default getSnapshot() is the LIVE state, with the real values
console.log(JSON.stringify(executor.getSnapshot({ redact: true }).sharedState));
// {"ssn":"REDACTED","password":"REDACTED","applicant":{"name":"Bob","ssn":"REDACTED","address":{"zip":"REDACTED","city":"LA"}}}
```

The law: a policy covers EVERYTHING the library retains or serves — commit log, mirror, tracked reads/writes, every recorder event (inline and deferred), narrative, snapshots, diagnostics, pause payloads, boundary records, logger lines — and NEVER the live heap or the resume checkpoint; the `run()` rejection and the live fork result are the caller's own values. It selects by NAME, never by content: state by path; a record handed out whole (root input/output, subflow seed/exit, pause payload, thrown value) by its keys at every depth plus declared fields under a key of that name; a diagnostic entry by its name; a subflow mapper's copy by taint (a key the mapper writes after reading a selected value inherits it — exact by reference, conservative when computed). Scalars carry no name; fork child-ID envelopes need explicit paths (for example `fields: { branchA: ['result.secret'] }`). See `docs/guides/scope.md` → "The one law". Capture once at the runtime boundary; recorders and readers must not reconstruct or re-scrub a run afterward.

---

Diagnostic masking: the state selectors already select a diagnostic entry by its name; `RedactionPolicy.diagnostics: { keys, patterns, fields }` ADDS diagnostic-only selectors for `logs`, `errors`, `metrics`, `evals` and flow-message text. The collector retains at each writer; an internal bridge supplies the same retained value to legacy facade emits while existing writer methods stay void. Preserve entry keys and flow metadata. Checkpoints copy retained diagnostics but keep operational state. Do not add a post-run sweep or let masked logs drive engine control. See the scope guide's diagnostic contract.

## Contracts & OpenAPI

```typescript
import { flowChart } from 'footprintjs';
import { z } from 'zod';

interface LoanState {
  decision?: string;
  reason?: string;
}

const chart = flowChart<LoanState>('ProcessLoan', (scope) => {
    const { applicantName, income } = scope.$getArgs<{ applicantName: string; income: number }>();
    scope.reason = `${applicantName} earns ${income}`;
  }, 'process-loan', { description: 'Receive the loan application' })
  .addFunction('Assess', (scope) => { scope.decision = 'approved'; }, 'assess', 'Decide on the application')
  .contract({
    input: z.object({
      applicantName: z.string(),
      income: z.number(),
    }),
    output: z.object({
      decision: z.enum(['approved', 'rejected']),
      reason: z.string(),
    }),
    mapper: (state) => ({
      decision: state.decision,
      reason: state.reason,
    }),
  })
  .build();

const openApiSpec = chart.toOpenAPI({
  title: 'Loan Underwriting API',
  version: '1.0.0',
});
console.log(JSON.stringify(Object.keys((openApiSpec as { paths: object }).paths)));
// ["/process-loan"]
console.log(JSON.stringify(chart.toMCPTool().description)); // built from the stage descriptions
// "FlowChart: ProcessLoan\nSteps:\n1. ProcessLoan — Receive the loan application\n2. Assess — Decide on the application"

// chart.run() validates input and returns the contract's mapped output
const result = await chart.run({ input: { applicantName: 'Bob', income: 42000 } });
console.log(JSON.stringify(result.output));
// {"decision":"approved","reason":"Bob earns 42000"}

// Invalid input throws InputValidationError — from chart.run() and from executor.run() alike
await chart.run({ input: { applicantName: 5 } }).catch((e: Error) => console.log(e.name));
// InputValidationError
```

`input` / `output` accept a Zod schema (anything with `.safeParse` / `.parse`) or a JSON Schema object; either is validated.

---

## Reading a finished run (`footprintjs/trace`)

The run's commit log answers questions after the fact — these read the log the run already recorded, they never re-walk the tree:

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { stateAt, timeTravel, HONESTY_CODES } from 'footprintjs/trace';

const chart = flowChart<{ a: number; b?: number }>('One', (scope) => { scope.a = 1; }, 'one')
  .addFunction('Two', (scope) => { scope.b = scope.a + 1; }, 'two')
  .build();
const executor = new FlowChartExecutor(chart);
await executor.run();
const snapshot = executor.getSnapshot();

const folded = stateAt(snapshot, 0); // fold the commit log through commit 0
console.log(folded.state, folded.basis);
// { a: 1 } initial+log
console.log(HONESTY_CODES[folded.basis]); // every honesty code → the one sentence that says what it means
// The fold started from the fold base that travelled with the log (initialState) and replayed the commit log onto it, so nothing seeded before the run is missing; rows it could not read are listed apart, in skipped.

const cursor = timeTravel(snapshot); // a reader's cursor over the finished log (never a second live run)
console.log(cursor.stops.map((stop) => `${stop.kind} ${stop.runtimeStageId}`));
// [ 'start ', 'commit one#0', 'commit two#1', 'end ' ]
```

`causalChain` and `sliceForKey` answer "what caused this value?" (backward slices); the READMEs in the repo are `src/lib/slice/README.md` and `src/lib/time-travel/README.md`. A reader that cannot answer says why with a code from `HONESTY_CODES` instead of guessing.

---

## Event Ordering (Critical for Understanding)

When a stage executes, ScopeRecorder events fire in this order:

```
1. onStageStart   — stage begins
2. onRead         — each typed property read  (DURING execution, before the commit)
3. onWrite        — each typed property write (DURING execution, before the commit)
4. onStageEnd     — the stage function returned
5. onCommit       — the transaction buffer flushes to shared memory
```

Then the FlowRecorder events fire (after the commit). What fires depends on the stage kind:

```
linear stage    onStageExecuted → onNext
decider         onDecision → onStageExecuted
selector        onSelected → onStageExecuted → onFork
fork parent     onStageExecuted → onFork → onStageExecuted (stageType 'fork')
subflow mount   onNext → onSubflowEntry → onStageExecuted (stageType 'subflow-mount')
                → the subflow's own stages → onSubflowExit
```

`CombinedNarrativeRecorder` buffers a stage's reads and writes and flushes them when that stage's flow event arrives (`onStageExecuted` for a linear stage, `onDecision` / `onSelected` / `onFork` / `onSubflowEntry` for the others). **This ordering is what makes inline collection work.** Scope events buffer during execution, flow events trigger the flush.

---

## Anti-Patterns to Avoid

1. **Never post-process the tree.** Don't walk the spec after execution to collect data. Use recorders (or the `footprintjs/trace` queries over the recorded log).
2. **Don't use `$getValue()`/`$setValue()` for keys you know.** Use typed property access (`scope.amount = 50000`); those two are escape hatches for dynamic keys. A plain `scope.getValue(...)` does not exist on a TypedScope.
3. **Don't give a state key the name of a `$` method** (`scope.$break = 1` throws "conflicts with a reserved TypedScope method"). The reserved names are `SCOPE_METHOD_NAMES` in `footprintjs/advanced` (`$getArgs`, `$getEnv`, `$break`, `$debug`, `$metric`, `$emit`, `$log`, `$read`, …); avoid `$`-prefixed state keys altogether.
4. **Don't write a state key that is also an input key.** `run({ input: { requestId } })` makes `requestId` read-only for the run (a subflow's `inputMapper` keys are read-only inside that subflow) — name the state key differently.
5. **`CombinedNarrativeBuilder` is gone** (removed in v1.0). The narrative comes from `CombinedNarrativeRecorder`, which you get from `executor.enableNarrative()` or the `narrative()` factory — never construct it yourself.
6. **Don't extract a shared base class** for scope and flow recorders. The built-ins compose a store (`KeyedStore` / `SequenceStore`, exported from `footprintjs/trace`) as a field instead of inheriting.
7. **Don't call `$getArgs()` for tracked data.** `$getArgs()` returns frozen readonly input. Use typed scope properties for state that should appear in the narrative.
8. **Don't put infrastructure data in `$getArgs()`.** Use `$getEnv()` via `run({ env })` for signals, timeouts, and trace IDs.
9. **Don't hand-roll a recorder to get the narrative.** `executor.enableNarrative()` (or `chart.recorder(narrative())`) is the whole setup — and it is off until you call it.
10. **Don't end a loop with `return`.** `.loopTo(id)` is unconditional: exit through a decider branch or `scope.$break()`.
11. **Don't read a parallel child's write as `scope.key` after the fork.** It sits under `runs/<childId>/` (`scope.$read('runs.<childId>.key')`), or use a subflow child with an `outputMapper`.

---

## Package doors and library layout (for contributors)

`package.json` `exports` has six doors — import from the one that owns the symbol:

| Import | What it is for |
|---|---|
| `footprintjs` | The main door: `flowChart`, `FlowChartExecutor`, `decide` / `select`, `narrative`, the built-in recorder classes, `interrupt`, and the public types |
| `footprintjs/recorders` | Recorder factories — `narrative()`, `metrics()`, `debug()`, `manifest()`, `adaptive()`, `milestone()`, `windowed()` — and `CompositeRecorder` |
| `footprintjs/trace` | Reading a finished run: commit-log queries (`causalChain`, `sliceForKey`, `stateAt`, `timeTravel`, `commitStops`), the recorder stores (`KeyedStore`, `SequenceStore`), `HONESTY_CODES` |
| `footprintjs/advanced` | Engine internals: `SharedMemory`, `StageContext`, `FlowchartTraverser`, scope providers, `SCOPE_METHOD_NAMES` |
| `footprintjs/detach` | Fire-and-forget child charts and their drivers |
| `footprintjs/zod` | Opt-in zod bridge (`defineScopeFromZod`, …) — the core never imports zod |

This file keeps no copy of the module map or the dependency rules, so it cannot drift from them: the module map is in `CLAUDE.md` ("Module map", shipped with the package) and the layer table — a file imports only its own layer or below — is `scripts/layering.config.cjs`, enforced by `npm run check:layering`.
