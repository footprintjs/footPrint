<p align="center">
  <h1 align="center">FootPrint</h1>
  <p align="center">
    <strong>Turn your whiteboard flowchart into running code &mdash; with automatic causal traces.</strong>
  </p>
</p>

<p align="center">
  <a href="https://github.com/footprintjs/footPrint/actions"><img src="https://github.com/footprintjs/footPrint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/footprintjs"><img src="https://img.shields.io/npm/v/footprintjs.svg?style=flat" alt="npm version"></a>
  <a href="https://github.com/footprintjs/footPrint/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/footprintjs"><img src="https://img.shields.io/npm/dm/footprintjs.svg" alt="Downloads"></a>
  <a href="https://footprintjs.github.io/footprint-playground/"><img src="https://img.shields.io/badge/Try_it-Interactive_Playground-6366f1?style=flat&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTggNXYxNGwxMS03eiIvPjwvc3ZnPg==" alt="Interactive Playground"></a>
</p>

<br>

FootPrint is a runtime for building **flowchart pipelines** where each node is just a function. It produces **causal traces** as a byproduct of execution &mdash; so any LLM can explain what happened and why, without reconstructing from logs.

```bash
npm install footprintjs
```

---

## Why causal traces?

A loan application pipeline rejects Bob. The user asks: **"Why was I rejected?"**

Without FootPrint, the LLM must reconstruct the reasoning from disconnected logs &mdash; expensive, slow, and unreliable. With FootPrint, the runtime produces this trace automatically from what the code actually did:

```
Stage 1: The process began with ReceiveApplication.
  Step 1: Write app = {applicantName, annualIncome, monthlyDebts, creditScore, …}
Stage 2: Next, it moved on to PullCreditReport.
  Step 1: Read app = {applicantName, annualIncome, monthlyDebts, creditScore, …}
  Step 2: Write creditTier = "fair"
  Step 3: Write creditFlags = (1 item)
Stage 3: Next, it moved on to CalculateDTI.
  Step 1: Read app = {applicantName, annualIncome, monthlyDebts, creditScore, …}
  Step 2: Write dtiRatio = 0.6
  Step 3: Write dtiPercent = 60
  Step 4: Write dtiStatus = "excessive"
  Step 5: Write dtiFlags = (1 item)
Stage 4: Next, it moved on to VerifyEmployment.
  Step 1: Read app = {applicantName, annualIncome, monthlyDebts, creditScore, …}
  Step 2: Write employmentVerified = true
  Step 3: Write employmentFlags = (1 item)
Stage 5: Next, it moved on to AssessRisk.
  Step 1: Read creditTier = "fair"
  Step 2: Read dtiStatus = "excessive"
  Step 3: Read employmentVerified = true
  Step 4: Write riskTier = "high"
  Step 5: Write riskFactors = (1 item)
[Condition]: A decision was made, and the path taken was RejectApplication.
```

The LLM backtracks through the trace: `riskTier="high"` &larr; `dtiStatus="excessive"` &larr; `dtiPercent=60` &larr; `app.monthlyDebts=2100`. Every variable links to its cause. Cheaper model, fewer tokens, no hallucination:

> **LLM:** "Your application was rejected because your credit score of 580 falls in the 'fair' tier, your debt-to-income ratio of 60% exceeds the 43% maximum, and your self-employment tenure of 1 year is below the 2-year minimum. These factors combined placed you in the 'high' risk tier."

That answer came from the trace &mdash; not from the LLM's imagination.

---

## The code that produced it

No one wrote those trace sentences. Stage functions just read and write scope &mdash; the narrative builds itself:

```typescript
import {
  flowChart, FlowChartExecutor, ScopeFacade, toScopeFactory,
} from 'footprintjs';

// ── Stage functions: just read and write scope ─────────────────────────

const receiveApplication = (scope: ScopeFacade) => {
  scope.setValue('app', {
    applicantName: 'Bob',
    annualIncome: 42_000,
    monthlyDebts: 2_100,
    creditScore: 580,
    employmentType: 'self-employed',
    employmentYears: 1,
  });
};

const pullCreditReport = (scope: ScopeFacade) => {
  const { creditScore } = scope.getValue('app') as any;
  const tier = creditScore >= 740 ? 'excellent'
    : creditScore >= 670 ? 'good'
    : creditScore >= 580 ? 'fair' : 'poor';

  scope.setValue('creditTier', tier);
  scope.setValue('creditFlags', tier === 'fair' ? ['below-average credit'] : []);
};

const calculateDTI = (scope: ScopeFacade) => {
  const { annualIncome, monthlyDebts } = scope.getValue('app') as any;
  const ratio = Math.round((monthlyDebts / (annualIncome / 12)) * 100) / 100;

  scope.setValue('dtiRatio', ratio);
  scope.setValue('dtiFlags', ratio > 0.43 ? [`DTI at ${Math.round(ratio * 100)}% exceeds 43%`] : []);
};

const verifyEmployment = (scope: ScopeFacade) => {
  const { employmentType, employmentYears } = scope.getValue('app') as any;
  const verified = employmentType !== 'self-employed' || employmentYears >= 2;

  scope.setValue('employmentVerified', verified);
  scope.setValue('employmentFlags', !verified
    ? [`${employmentType}, ${employmentYears}yr < 2yr minimum`] : []);
};

const assessRisk = (scope: ScopeFacade) => {
  const tier = scope.getValue('creditTier') as string;
  const ratio = scope.getValue('dtiRatio') as number;
  const verified = scope.getValue('employmentVerified') as boolean;

  scope.setValue('riskTier', (!verified || ratio > 0.43 || tier === 'poor') ? 'high' : 'low');
};

// Deciders return a branch ID — the only stage that needs a return value
const loanDecider = (scope: ScopeFacade): string => {
  const tier = scope.getValue('riskTier') as string;
  if (tier === 'low') return 'approved';
  if (tier === 'high') return 'rejected';
  return 'manual-review';
};

// ── Build → Run → Narrative (D3-style chaining) ──────────────────────

const chart = flowChart('ReceiveApplication', receiveApplication)
  .setEnableNarrative()
  .addFunction('PullCreditReport', pullCreditReport)
  .addFunction('CalculateDTI', calculateDTI)
  .addFunction('VerifyEmployment', verifyEmployment)
  .addFunction('AssessRisk', assessRisk)
  .addDeciderFunction('LoanDecision', loanDecider as any)
    .addFunctionBranch('approved', 'Approve', () => {})
    .addFunctionBranch('rejected', 'Reject', () => {})
    .addFunctionBranch('manual-review', 'ManualReview', () => {})
    .setDefault('manual-review')
    .end()
  .build();

const executor = new FlowChartExecutor(chart, toScopeFactory(ScopeFacade));
await executor.run();

const narrative = executor.getNarrative();  // ← the trace above
```

`enableNarrative()` auto-instruments every scope. The executor captures stage transitions, decisions, reads, and writes &mdash; then merges them into the combined trace. No descriptions were written by hand.

---

## Two narratives, both auto-generated

### Build-time: tool description for LLM tool selection

When you call `.build()`, FootPrint auto-generates `chart.description` &mdash; a structural summary of what the pipeline does:

```
FlowChart: ReceiveApplication
Steps:
1. ReceiveApplication
2. PullCreditReport
3. CalculateDTI
4. VerifyEmployment
5. AssessRisk
6. LoanDecision — Decides between: approved, rejected, manual-review
```

Register this as a **tool description**. When an LLM agent has multiple tools to choose from, it can read each tool's description and pick the right one &mdash; without you writing tool descriptions by hand:

```typescript
// Each flowchart's auto-generated description becomes the tool description
const tools = [
  {
    name: 'process-loan',
    description: loanChart.description,
    //  FlowChart: ReceiveApplication
    //  Steps:
    //  1. ReceiveApplication
    //  2. PullCreditReport  ...
    //  6. LoanDecision — Decides between: approved, rejected, manual-review
    handler: (input) => runWithChart(loanChart, input),
  },
  {
    name: 'check-fraud',
    description: fraudChart.description,
    //  FlowChart: AnalyzeTransaction
    //  Steps:
    //  1. AnalyzeTransaction
    //  2. CheckVelocity
    //  3. CheckGeolocation
    //  4. FraudDecision — Decides between: allow, block, review
    handler: (input) => runWithChart(fraudChart, input),
  },
];

// The LLM sees exactly what each tool does — enough to pick the right one.
// No manual description writing. The structure IS the description.
```

### Runtime: causal trace for LLM explanation

After `.run()`, the combined narrative shows what the code *actually did* &mdash; every value read, every value written, every decision made. This is the trace shown at the top of this page. Ship it alongside the result so any follow-up LLM call can explain what happened and why.

**Build-time tells the LLM which tool to use. Runtime tells the LLM what the tool did.**

---

## How it works

FootPrint has three moving parts:

1. **Scope** &mdash; Transactional state shared across stages. Writes are buffered and committed atomically. Recorders observe every read/write without modifying behavior.
2. **Builder** &mdash; Fluent API that compiles your flowchart into a traversable node tree.
3. **Engine** &mdash; DFS traversal that executes stages, manages state, and generates narrative.

```
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│   FlowChartBuilder  │─────>│      FlowChart      │─────>│  FlowChartExecutor  │
│   (Build-time DSL)  │      │   (Compiled Tree)   │      │   (Runtime Engine)  │
└─────────────────────┘      └─────────────────────┘      └─────────────────────┘
        │                            │                            │
        │ .start()                   │ .build()                   │ .run()
        │ .addFunction()             │ .description               │ .getNarrative()
        │ .addDeciderFunction()      │ .stageDescriptions         │ .getSnapshot()
        │ .addSubFlowChart()         │                            │
        └────────────────────────────┴────────────────────────────┘
```

---

## Patterns

### Linear

```typescript
import { flowChart } from 'footprintjs';

flowChart('A', fnA)
  .addFunction('B', fnB)
  .addFunction('C', fnC)
  .build();
```

### Parallel (Fork)

```typescript
flowChart('Fetch', fetchFn)
  .addListOfFunction([
    { id: 'html', name: 'ParseHTML', fn: parseHTML },
    { id: 'css',  name: 'ParseCSS',  fn: parseCSS },
    { id: 'js',   name: 'ParseJS',   fn: parseJS },
  ])
  .addFunction('Merge', mergeFn)
  .build();
```

### Conditional (Decider)

A decider reads from scope and returns the ID of exactly one branch to execute:

```typescript
flowChart('Classify', classifyFn)
  .addDeciderFunction('Route', (scope) => {
    const type = scope.getValue('fulfillmentType');
    return type === 'digital' ? 'digital' : 'physical';
  })
    .addFunctionBranch('digital', 'DigitalDelivery', digitalFn)
    .addFunctionBranch('physical', 'ShipPackage', shipFn)
    .setDefault('physical')
    .end()
  .build();
```

### Subflow Composition

Mount entire flowcharts as nodes in a larger workflow:

```typescript
const faqFlow = flowChart('FAQ_Entry', faqEntryFn)
  .addFunction('FAQ_Answer', faqAnswerFn)
  .build();

const ragFlow = flowChart('RAG_Entry', ragEntryFn)
  .addFunction('RAG_Retrieve', ragRetrieveFn)
  .addFunction('RAG_Answer', ragAnswerFn)
  .build();

const mainChart = flowChart('Router', routerFn)
  .addSubFlowChart('faq', faqFlow, 'FAQ Handler')
  .addSubFlowChart('rag', ragFlow, 'RAG Handler')
  .addFunction('Aggregate', aggregateFn)
  .build();
```

### Streaming (LLM)

```typescript
const chart = flowChart('PreparePrompt', prepareFn)
  .addStreamingFunction('AskLLM', 'llm-stream', askLLMFn)
  .onStream((streamId, token) => process.stdout.write(token))
  .onStreamEnd((streamId, fullText) => console.log('\nDone:', fullText))
  .addFunction('ProcessResponse', processFn)
  .build();
```

### Execution Control

Every stage receives `(scope, breakFn)`. Three levels of control:

```typescript
// 1. breakFn() — Graceful stop: complete this stage, skip remaining stages
const validateInput = async (scope: ScopeFacade, breakFn: () => void) => {
  const amount = scope.getValue('loanAmount') as number;
  if (amount > 50_000) {
    scope.setValue('rejection', 'Exceeds maximum loan amount');
    breakFn();  // stage output is returned, no error — pipeline just stops
  }
};

// 2. throw — Hard abort: stop immediately, propagate error to caller
const callExternalAPI = async (scope: ScopeFacade) => {
  const response = await fetch(scope.getValue('apiUrl') as string);
  if (response.status === 403) {
    throw new Error('Access denied — cannot continue');  // executor.run() rejects
  }
};

// 3. AbortSignal — External cancellation (see Cancellation & Timeout section)
await executor.run({ timeoutMs: 30_000 });
```

| Mechanism | Trigger | Stage completes? | Returns |
|-----------|---------|-----------------|---------|
| `breakFn()` | Inside stage | Yes | Stage output (no error) |
| `throw` | Inside stage | No | Error propagates |
| `AbortSignal` | Outside pipeline | Races async | Error propagates |

### Loops

```typescript
flowChart('Init', initFn)
  .addFunction('AskLLM', askFn, 'ask-llm')
  .addFunction('ParseResponse', parseFn)
  .addDeciderFunction('HasToolCalls', deciderFn)
    .addFunctionBranch('yes', 'ExecuteTools', toolsFn)
    .addFunctionBranch('no', 'Finalize', finalizeFn)
    .end()
  .loopTo('ask-llm')  // loop back until no more tool calls
  .build();
```

---

## Scope

Each stage receives a **scope** &mdash; a transactional interface to shared state. Writes are buffered and committed atomically after each stage. Recorders can observe every operation.

### Typed Scope (Recommended)

Extend `ScopeFacade` with domain-specific getters for type-safe reads:

```typescript
import { ScopeFacade } from 'footprintjs';

class LoanScope extends ScopeFacade {
  get creditScore(): number {
    return this.getValue('creditScore') as number;
  }
  get riskTier(): string {
    return this.getValue('riskTier') as string;
  }
  get dtiStatus(): string {
    return this.getValue('dtiStatus') as string;
  }
}

const scopeFactory = (ctx: any, stageName: string) => new LoanScope(ctx, stageName);

// In stage functions:
const assessRisk = async (scope: LoanScope) => {
  if (scope.creditScore < 600 || scope.dtiStatus === 'excessive') {
    scope.setValue('riskTier', 'high');  // writes go through setValue
  }
};
```

> **Why `getValue`/`setValue` instead of direct properties?** Scope protection blocks `scope.foo = bar` &mdash; those writes bypass transactional buffering and recorder hooks. Typed getters give you clean reads; `setValue` gives you tracked writes.

### Raw Scope (Low-level)

```typescript
scope.setValue('total', 79.98);              // overwrite
scope.updateValue('config', { retries: 3 }); // deep merge
const total = scope.getValue('total');       // read
```

### Validated Scope (Zod)

```typescript
import { z } from 'zod';
import { defineScopeFromZod } from 'footprintjs';

const schema = z.object({
  creditScore: z.number(),
  riskTier: z.string().optional(),
});

const scopeFactory = defineScopeFromZod(schema);
// Proxy-based: validates writes against the schema at runtime
```

---

## Observability

### Recorders

Recorders observe scope operations without modifying them. Attach multiple for different concerns:

```typescript
import {
  ScopeFacade, DebugRecorder, MetricRecorder,
} from 'footprintjs';

const scopeFactory = (ctx: any, stageName: string) => {
  const scope = new ScopeFacade(ctx, stageName);
  scope.attachRecorder(new DebugRecorder({ verbosity: 'verbose' }));
  scope.attachRecorder(new MetricRecorder());
  return scope;
};
```

> **Note:** `NarrativeRecorder` is attached automatically when narrative is enabled via `setEnableNarrative()` or `executor.enableNarrative()`. You only need to attach it manually if you need custom options.

Error isolation is built in: if a recorder throws, the error is routed to `onError` hooks of other recorders, and the scope operation continues normally.

### Custom Recorders

Implement any subset of six hooks: `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`.

```typescript
import { Recorder, WriteEvent } from 'footprintjs';

class AuditRecorder implements Recorder {
  readonly id = 'audit';
  private writes: Array<{ stage: string; key: string; value: unknown }> = [];

  onWrite(event: WriteEvent) {
    this.writes.push({ stage: event.stageName, key: event.key, value: event.value });
  }
  getWrites() { return [...this.writes]; }
}
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Causal Traces** | Every read/write captured &mdash; LLMs backtrack through variables to find causes |
| **Auto Narrative** | Build-time descriptions for tool selection, runtime traces for explanation |
| **Not a DAG** | Supports loops, re-entry, and partial/resumed execution |
| **Parallel Fan-Out/In** | Fork pattern with automatic result aggregation (optional fail-fast) |
| **Cancellation** | AbortSignal and timeout support for long-running LLM calls |
| **Early Termination** | `breakFn()` stops the pipeline after the current stage |
| **Patch-Based State** | Atomic commits, safe merges, no race conditions |
| **Composable Subflows** | Mount entire flowcharts as nodes in larger workflows |
| **Streaming** | Built-in streaming stages for LLM token emission |
| **Pluggable Recorders** | DebugRecorder, MetricRecorder, NarrativeRecorder &mdash; or bring your own |

---

## Cancellation & Timeout

For LLM pipelines where API calls can hang, `FlowChartExecutor.run()` supports cooperative cancellation:

```typescript
// Timeout: auto-abort after 30 seconds
const result = await executor.run({ timeoutMs: 30_000 });

// AbortSignal: cancel from outside
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);  // cancel after 10s
const result = await executor.run({ signal: controller.signal });
```

The signal is checked before each stage starts and raced against async stage functions. Aborted executions throw with the signal's reason.

## Fail-Fast Forks

By default, parallel children run to completion even if some fail (errors captured as `{ isError: true }`). For cases where you want immediate failure:

```typescript
flowChart('Fetch', fetchFn)
  .addListOfFunction([
    { id: 'api1', name: 'CallAPI1', fn: api1Fn },
    { id: 'api2', name: 'CallAPI2', fn: api2Fn },
  ], { failFast: true })  // first child error rejects the whole fork
  .build();
```

## Design: Error Handling

FootPrint's error handling is designed around one principle: **the trace must capture everything that happened, including failures**.

### Who is responsible for what

| Layer | Responsibility |
|-------|---------------|
| **Stage function** | Business logic. Throws errors when invariants break. |
| **Engine** | Infrastructure. Catches errors, commits the trace, records error metadata, then re-throws. |
| **Consumer** | Wraps `executor.run()` in try/catch. Inspects `getSnapshot()` after failure for debugging. |

### Commit-on-error: why it matters

When a stage throws, the engine calls `context.commit()` *before* re-throwing. This means:

```typescript
const executor = new FlowChartExecutor(chart, scopeFactory);
try {
  await executor.run();
} catch (error) {
  // The snapshot captures everything up to the failure point
  const snapshot = executor.getSnapshot();
  // commitLog has entries for every stage that ran (including the one that failed)
  // executionTree shows scope writes, error metadata, and flow decisions
  // An LLM can use this to explain WHY the error happened
}
```

Without commit-on-error, a failed stage's partial writes would be lost. The trace would end at the last successful stage, hiding the context of the failure. Commit-on-error gives consumers complete visibility:

- **Scope writes** made before the throw are preserved
- **Error metadata** (`stageExecutionError`) is recorded in the execution tree
- **Narrative** includes the error event (`"An error occurred at validate: ..."`)
- **Commit log** has an entry for the failed stage's state

### Error narrative in practice

A validation pipeline fails. The trace tells the story:

```
Stage 1: The process began with FetchData.
  Step 1: Write rawPayload = {name: "Bob", age: -5}
Stage 2: Next, it moved on to Validate.
  Step 1: Read rawPayload = {name: "Bob", age: -5}
  An error occurred at Validate: Validation failed: age must be positive.
```

An LLM reading this trace can immediately explain: *"The validation failed because the age field was -5, which was provided in the raw payload from FetchData. Age must be a positive number."* No log reconstruction needed.

### What consumers can do

- **Retry with modifications**: Inspect the snapshot, fix inputs, re-run
- **Partial results**: Fork children that succeed still return results (default mode)
- **Fail-fast**: Opt into `failFast: true` when any child error should abort the whole fork
- **Timeout/cancel**: Use `timeoutMs` or `AbortSignal` for external cancellation
- **Post-mortem**: Feed the narrative + snapshot to an LLM for root-cause analysis

---

## API Reference

### Builder

| Method | Description |
|--------|-------------|
| `start(name, fn?)` | Define root stage |
| `addFunction(name, fn?)` | Add linear next stage |
| `addListOfFunction(specs, opts?)` | Add parallel children (fork). Options: `{ failFast? }` |
| `addDeciderFunction(name, fn)` | Single-choice branching (returns one branch ID) |
| `addSelectorFunction(name, fn)` | Multi-choice branching (returns multiple branch IDs) |
| `addSubFlowChart(id, flow)` | Mount subflow as parallel child |
| `addSubFlowChartNext(id, flow)` | Mount subflow as linear next |
| `addStreamingFunction(name, streamId?, fn?)` | Add streaming stage |
| `addTraversalExtractor(fn)` | Register per-stage data extractor |
| `setEnableNarrative()` | Enable runtime narrative generation |
| `loopTo(stageId)` | Loop back to earlier stage |
| `build()` | Compile to FlowChart |
| `execute(scopeFactory)` | Build + run (convenience) |
| `toSpec()` | Export pure JSON (no functions) |
| `toMermaid()` | Generate Mermaid diagram |

### Executor

| Method | Description |
|--------|-------------|
| `run(options?)` | Execute the flowchart. Options: `{ signal?, timeoutMs? }` |
| `getNarrative()` | Combined narrative (flow + data) with ScopeFacade; flow-only otherwise |
| `getFlowNarrative()` | Flow-only narrative sentences |
| `getNarrativeEntries()` | Structured `CombinedNarrativeEntry[]` for programmatic use |
| `getSnapshot()` | Full execution tree + state |
| `getExtractedResults()` | Extractor results map |
| `getEnrichedResults()` | Enriched snapshots (scope state, debug info, output) |
| `getSubflowResults()` | Nested subflow execution data |
| `getRuntimeStructure()` | Serialized pipeline for visualization |

---

## How FootPrint Compares

| Aspect | async/await | FootPrint | Temporal / Step Functions |
|--------|-------------|-----------|--------------------------|
| **Control Flow** | Implicit in code | Explicit flowchart | External orchestrator |
| **State** | Manual/global | Scoped & transactional | Durable storage |
| **Debugging** | Stack traces | Time-travel replay | Event history |
| **LLM Narrative** | None | Automatic from operations | None |
| **Tool Descriptions** | Manual | Auto-generated from structure | Manual |
| **Complexity** | Low | Medium | High |

---

## Performance

Measured on Node v22, Apple Silicon. Run `npm run bench` to reproduce.

| Benchmark | Time | Detail |
|-----------|------|--------|
| **Write 1K keys** | 811µs | ~1.2M ops/s |
| **Write 10K keys** | 5.4ms | ~1.8M ops/s |
| **Read 100K keys** | 8.7ms | ~11.5M ops/s |
| **10 stages (linear)** | 106µs | 0.011ms/stage |
| **200 stages (linear)** | 4.7ms | 0.023ms/stage |
| **500 stages (linear)** | 20ms | 0.040ms/stage |
| **100 concurrent pipelines** | 2.3ms | 3-stage each |
| **1,000 concurrent pipelines** | 24ms | 3-stage each |
| **structuredClone 1KB** | 2µs | per call |
| **structuredClone 100KB** | 76µs | per call |
| **structuredClone 1MB** | 2.5ms | per call |
| **Time-travel 100 commits** | 75µs | 0.001ms/commit |
| **Time-travel 500 commits** | 385µs | 0.001ms/commit |
| **Commit with 100 writes** | 375µs | single stage |

**Bottom line:** A 200-stage pipeline completes in under 5ms. The primary cost at scale is `structuredClone` — keep state objects under 100KB per stage for sub-millisecond commit overhead.

---

## Architecture

FootPrint is five independent libraries, each usable standalone:

```
src/lib/
├── memory/    Transactional state (SharedMemory, StageContext, EventLog, TransactionBuffer)
├── builder/   Fluent flowchart DSL (FlowChartBuilder, DeciderList, SelectorFnList)
├── scope/     Scope facades, recorders, protection, Zod integration
├── engine/    DFS traversal, handlers, narrative generators
└── runner/    Execution convenience (FlowChartExecutor, ExecutionRuntime)
```

---

## License

[MIT](./LICENSE) &copy; [Sanjay Krishna Anbalagan](https://github.com/sanjay1909)
