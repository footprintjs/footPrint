<p align="center">
  <h1 align="center">FootPrint</h1>
  <p align="center">
    <strong>The flowchart pattern for backend code &mdash; self-explainable systems that AI can reason about.</strong>
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

**MVC is a pattern for structuring backends. FootPrint is a different pattern &mdash; the flowchart pattern &mdash; where your business logic is organized as a graph of functions with transactional state.** The code becomes self-explainable: AI can read the structure, trace every decision, and explain what happened without reconstructing from logs.

> FootPrint is **not** a workflow engine, pipeline builder, or orchestrator. It's a code pattern &mdash; like how React changed how we build UIs, FootPrint changes how we structure backend logic to be AI-native.

```bash
npm install footprintjs
```

## Quick Start

```typescript
import { flowChart, FlowChartExecutor, ScopeFacade, toScopeFactory } from 'footprintjs';

const chart = flowChart('Greet', (scope) => {
    scope.setValue('name', 'Alice');
  })
  .addFunction('Personalize', (scope) => {
    const name = scope.getValue('name');
    scope.setValue('message', `Hello, ${name}!`);
  })
  .setEnableNarrative()
  .build();

const executor = new FlowChartExecutor(chart, toScopeFactory(ScopeFacade));
const result = await executor.run();

console.log(executor.getNarrative());
// Stage 1: The process began with Greet.
//   Step 1: Write name = "Alice"
// Stage 2: Next, it moved on to Personalize.
//   Step 1: Read name = "Alice"
//   Step 2: Write message = "Hello, Alice!"
```

> **[Try it in the browser](https://footprintjs.github.io/footprint-playground/)** &mdash; no install needed
>
> **[Browse 25+ examples](https://github.com/footprintjs/footPrint-samples)** &mdash; features, flowchart patterns, flow recorder strategies, and a full loan underwriting demo

---

## Why a new pattern?

**MVC** separates concerns into Model, View, Controller. It works, but the code is opaque to AI &mdash; an LLM can't trace why a request produced a specific result without parsing scattered logs.

**The flowchart pattern** structures the same logic as a graph of named functions with managed state. This gives you two things MVC can't:

1. **Self-describing code** &mdash; The structure auto-generates tool descriptions for LLM agents. No hand-written descriptions that drift from reality.
2. **Self-explaining execution** &mdash; Every run produces a causal trace showing what happened and why. An LLM reads the trace and explains decisions accurately &mdash; no hallucination.

| | MVC / Traditional | Flowchart Pattern (FootPrint) |
|---|---|---|
| **Code structure** | Controllers with implicit flow | Explicit graph of named functions |
| **LLM explains a decision** | Reconstruct from scattered logs | Read the causal trace directly |
| **Tool descriptions for agents** | Write and maintain by hand | Auto-generated from the graph |
| **State management** | Global/manual, race-prone | Transactional scope with atomic commits |
| **Debugging** | `console.log` + guesswork | Time-travel replay to any stage |

### Example: Loan rejection

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

This is regular backend code &mdash; just structured as a flowchart instead of a controller. No one wrote those trace sentences. The functions just read and write scope; the pattern produces the narrative automatically:

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

The functions are ordinary TypeScript &mdash; no decorators, no special annotations. The flowchart pattern captures stage transitions, decisions, reads, and writes automatically. That's the difference from MVC: in MVC, this trace doesn't exist. In the flowchart pattern, it's a byproduct of the structure.

---

## What makes it self-explainable

The flowchart pattern produces two AI-readable outputs automatically &mdash; no extra code needed:

### Build-time: tool description for LLM agents

When you call `.build()`, the structure auto-generates `chart.description` &mdash; a complete description of what the code does:

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

After `.run()`, the trace shows what the code *actually did* &mdash; every value read, every value written, every decision made. Ship it alongside the result so any LLM can explain what happened and why.

**Build-time tells the LLM what the code does. Runtime tells the LLM what the code did.** That's what makes it self-explainable &mdash; the pattern produces both automatically.

---

## How the pattern works

The flowchart pattern has three parts &mdash; the same way MVC has Model, View, Controller:

1. **Builder** &mdash; Define your business logic as a graph of named functions. Like how a controller defines routes, but the structure is an explicit flowchart.
2. **Scope** &mdash; Transactional state shared across stages. Writes are buffered and committed atomically. This replaces scattered state management.
3. **Engine** &mdash; Executes the graph and auto-generates the causal trace. You write functions; the pattern produces the explanation.

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

## Documentation

| Guide | What it covers |
|-------|---------------|
| **[Patterns](docs/guides/patterns.md)** | All 7 flowchart patterns with diagrams |
| **[Scope](docs/guides/scope.md)** | Typed, raw, and Zod scope; recorders; protection |
| **[Execution Control](docs/guides/execution.md)** | breakFn, cancellation, timeout, fail-fast, loops |
| **[Error Handling](docs/guides/error-handling.md)** | Commit-on-error, debug recorder, post-mortem |
| **[Flow Recorders](docs/guides/flow-recorders.md)** | Pluggable observers for control flow narrative — 7 built-in strategies |
| **[Contracts](docs/guides/contracts.md)** | defineContract, OpenAPI 3.1, Zod vs JSON Schema |
| **[Internals](docs/internals/)** | Architecture deep-dives for each library |

---

## Patterns

Seven composition patterns &mdash; linear, parallel, conditional, multi-select, subflow, streaming, and loops:

```typescript
// Linear: A → B → C
flowChart('A', fnA).addFunction('B', fnB).addFunction('C', fnC).build();

// Parallel fork
flowChart('Fetch', fetchFn)
  .addListOfFunction([
    { id: 'html', name: 'ParseHTML', fn: parseHTML },
    { id: 'css',  name: 'ParseCSS',  fn: parseCSS },
  ])
  .addFunction('Merge', mergeFn)
  .build();

// Conditional branching (decider)
flowChart('Classify', classifyFn)
  .addDeciderFunction('Route', routeFn)
    .addFunctionBranch('digital', 'DigitalDelivery', digitalFn)
    .addFunctionBranch('physical', 'ShipPackage', shipFn)
    .setDefault('physical')
    .end()
  .build();

// Subflow composition
flowChart('Router', routerFn)
  .addSubFlowChart('faq', faqFlow, 'FAQ Handler')
  .addSubFlowChart('rag', ragFlow, 'RAG Handler')
  .build();

// Loops
flowChart('Init', initFn)
  .addFunction('Retry', retryFn, 'retry')
  .addDeciderFunction('Check', checkFn)
    .addFunctionBranch('again', 'Process', processFn)
    .addFunctionBranch('done', 'Finish', finishFn)
    .end()
  .loopTo('retry')
  .build();
```

**[Full patterns guide &rarr;](docs/guides/patterns.md)** &mdash; all seven patterns with diagrams and composition examples

---

## Scope

Each stage receives a **scope** &mdash; a transactional interface to shared state:

```typescript
// Typed scope (recommended)
class LoanScope extends ScopeFacade {
  get creditScore(): number { return this.getValue('creditScore') as number; }
}

// Validated scope (Zod)
const scopeFactory = defineScopeFromZod(z.object({
  creditScore: z.number(),
  riskTier: z.string().optional(),
}));

// Raw scope
scope.setValue('total', 79.98);
scope.updateValue('config', { retries: 3 });
```

Pluggable recorders observe every operation: `DebugRecorder`, `MetricRecorder`, `NarrativeRecorder`, or bring your own.

**[Full scope guide &rarr;](docs/guides/scope.md)** &mdash; typed/raw/Zod scope, recorders, protection, provider system

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
| **PII Redaction** | Per-key `setValue(key, value, true)` or declarative `RedactionPolicy` with exact keys, regex patterns, and field-level scrubbing &mdash; plus `getRedactionReport()` audit trail ([guide](docs/guides/scope.md#redaction-pii-protection)) |
| **Pluggable Recorders** | DebugRecorder, MetricRecorder, NarrativeRecorder &mdash; or bring your own |
| **Flow Recorders** | 7 narrative strategies for loop summarization &mdash; Windowed, Silent, Adaptive, Progressive, Milestone, RLE, Separate &mdash; or build custom ([examples](https://github.com/footprintjs/footPrint-samples/tree/main/examples/flow-recorders)) |

---

## Execution Control & Error Handling

Three levels of control: `breakFn()` (graceful stop), `throw` (hard abort), `AbortSignal` (external cancellation):

```typescript
// Graceful stop — complete this stage, skip remaining
const validate = async (scope: ScopeFacade, breakFn: () => void) => {
  if (scope.getValue('amount') > 50_000) { breakFn(); }
};

// Timeout / external cancellation
await executor.run({ timeoutMs: 30_000 });
await executor.run({ signal: controller.signal });
```

When a stage throws, the engine commits the trace *before* re-throwing &mdash; so `getSnapshot()` captures everything up to the failure point, including partial writes and error metadata.

**[Execution control guide &rarr;](docs/guides/execution.md)** &mdash; breakFn, cancellation, timeout, fail-fast forks, loops

**[Error handling guide &rarr;](docs/guides/error-handling.md)** &mdash; commit-on-error, debug recorder, error narrative, post-mortem

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
| `attachFlowRecorder(recorder)` | Attach a FlowRecorder for pluggable narrative control |
| `detachFlowRecorder(id)` | Detach a FlowRecorder by id |
| `getNarrativeEntries()` | Structured `CombinedNarrativeEntry[]` for programmatic use |
| `getSnapshot()` | Full execution tree + state |
| `getExtractedResults()` | Extractor results map |
| `getEnrichedResults()` | Enriched snapshots (scope state, debug info, output) |
| `getSubflowResults()` | Nested subflow execution data |
| `getRuntimeStructure()` | Serialized pipeline for visualization |

---

## How FootPrint Compares

FootPrint is a **code pattern**, not an orchestrator. It runs in your process, not as a separate service.

| Aspect | MVC / async-await | FootPrint (flowchart pattern) | Temporal / Step Functions |
|--------|-------------------|-------------------------------|--------------------------|
| **What it is** | Code pattern | Code pattern | External orchestrator |
| **Runs where** | In your process | In your process | Separate service |
| **Control flow** | Implicit in code | Explicit graph of functions | External state machine |
| **State** | Manual / global | Transactional scope | Durable storage |
| **AI explains decisions** | Parse logs (hallucination-prone) | Read the causal trace (accurate) | Parse event history |
| **Tool descriptions** | Write by hand | Auto-generated from structure | Write by hand |
| **Debugging** | Stack traces | Time-travel replay | Event history |
| **Complexity** | Low | Low-medium | High |

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

## Contract & OpenAPI

Define I/O schemas (Zod or raw JSON Schema) and auto-generate OpenAPI 3.1 specs:

```typescript
import { flowChart, defineContract } from 'footprintjs';
import { z } from 'zod';

const contract = defineContract(chart, {
  inputSchema: z.object({ applicantName: z.string(), creditScore: z.number() }),
  outputSchema: z.object({ decision: z.enum(['approved', 'rejected']) }),
});

const spec = contract.toOpenAPI({ version: '1.0.0', basePath: '/api' });
```

Zod is an **optional peer dependency** &mdash; zero bundle impact if not used.

**[Full contracts guide &rarr;](docs/guides/contracts.md)** &mdash; defineContract, OpenAPI generation, Zod vs JSON Schema, builder-level schemas

---

## Architecture

FootPrint is the reference implementation of the flowchart pattern &mdash; six independent libraries, each usable standalone:

```
src/lib/
├── memory/    Transactional state (SharedMemory, StageContext, EventLog, TransactionBuffer)
├── builder/   Fluent flowchart DSL (FlowChartBuilder, DeciderList, SelectorFnList)
├── scope/     Scope facades, recorders, protection, Zod integration
├── engine/    DFS traversal, handlers, narrative generators
├── runner/    Execution convenience (FlowChartExecutor, ExecutionRuntime)
└── contract/  I/O schemas, Zod→JSON Schema, OpenAPI 3.1 generation
```

**[Architecture deep-dives &rarr;](docs/internals/)** &mdash; each library has its own README with primitives, design decisions, and dependency graphs

---

## License

[MIT](./LICENSE) &copy; [Sanjay Krishna Anbalagan](https://github.com/sanjay1909)
