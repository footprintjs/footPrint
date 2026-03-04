<p align="center">
  <h1 align="center">FootPrint</h1>
  <p align="center">
    <strong>Turn your whiteboard flowchart into running code.</strong>
  </p>
</p>

<p align="center">
  <a href="https://github.com/sanjay1909/footPrint/actions"><img src="https://github.com/sanjay1909/footPrint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/footprint"><img src="https://img.shields.io/npm/v/footprint.svg?style=flat" alt="npm version"></a>
  <a href="https://github.com/sanjay1909/footPrint/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/footprint"><img src="https://img.shields.io/npm/dm/footprint.svg" alt="Downloads"></a>
</p>

<br>

FootPrint is a tiny, production-minded runtime for building **flowchart-like pipelines** where each node is just a function. It produces **causal traces** and **plain-English narratives** as a byproduct of execution &mdash; so any LLM can explain what happened and why, without reconstructing from logs.

### See it in action

A loan application pipeline rejects an applicant. The runtime produces this narrative automatically:

```
1. The process began: received the loan application and captured applicant data.
2. Next step: pulled the credit report and classified the credit tier.
3. Next step: calculated the debt-to-income ratio from income and monthly debts.
4. Next step: verified employment status and tenure.
5. Next step: assessed overall risk by combining credit, DTI, and employment factors.
6. Next step: evaluated the risk tier to determine the loan outcome.
7. It evaluated the risk tier to determine the loan outcome: Risk tier: high.
   Factors: below-average credit history; DTI at 60% exceeds the 43% maximum;
   self-employed for only 1 year(s) — less than 2-year minimum; loan amount
   ($40,000) is 95% of annual income, so it chose Reject Application.
```

Ship that narrative alongside the result. Now even a $0.25 model can answer:

> **User:** "Why was my loan rejected?"
>
> **LLM:** "Your application was rejected because your credit score of 580 falls in the 'fair' tier with below-average credit history, your debt-to-income ratio of 60% exceeds the 43% maximum, and your self-employment tenure of 1 year is below the 2-year minimum. These factors combined placed you in the 'high' risk tier, which triggered automatic rejection."

That answer came from the trace &mdash; not from the LLM's imagination.

### The code that produced it

```typescript
import { FlowChartBuilder, FlowChartExecutor, BaseState } from 'footprint';

const chart = new FlowChartBuilder()
  .setEnableNarrative()
  .start('ReceiveApplication', receiveFn, 'receive-app', 'Receive Application',
    'received the loan application and captured applicant data')
  .addFunction('PullCreditReport', creditFn, 'pull-credit', 'Pull Credit Report',
    'pulled the credit report and classified the credit tier')
  .addFunction('CalculateDTI', dtiFn, 'calc-dti', 'Calculate DTI',
    'calculated the debt-to-income ratio from income and monthly debts')
  .addFunction('VerifyEmployment', employFn, 'verify-emp', 'Verify Employment',
    'verified employment status and tenure')
  .addFunction('AssessRisk', riskFn, 'assess-risk', 'Assess Risk',
    'assessed overall risk by combining credit, DTI, and employment factors')
  .addDeciderFunction('LoanDecision', deciderFn, 'loan-decision', 'Loan Decision',
    'evaluated the risk tier to determine the loan outcome')
    .addFunctionBranch('approved', 'Approve', approveFn, 'Approve Application')
    .addFunctionBranch('rejected', 'Reject', rejectFn, 'Reject Application')
    .addFunctionBranch('manual-review', 'Review', reviewFn, 'Manual Review')
    .setDefault('manual-review')
    .end()
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run();

const narrative = executor.getNarrative(); // ← the 7 sentences above
```

Each stage is a plain function. Each description becomes a sentence. The decider writes its rationale to scope, and the runtime captures it in the narrative. No post-processing, no log parsing, no reconstruction.

**[Full working example with tests →](./demo/src/8-loan-application/)**

---

## Why FootPrint?

> [Read the full story](./docs/STORY.md) &mdash; Why FootPrint exists, who it's for, and the vision behind it.

### The Problem

We build applications with traces for our **ops teams** &mdash; logs, spans, metrics &mdash; stitched together after the fact. Good enough for incident response.

**That assumption just broke.** AI applications serve users through LLMs. The user asks "why was I rejected?" and the LLM needs to explain what the tool did and why. It must reconstruct the reasoning chain from disconnected logs. That reconstruction is **expensive** (tokens), **slow** (multiple LLM turns), and **unreliable** (hallucinations when context is missing).

### The Insight

What if traces were connected **while executing**, not reconstructed after?

OpenTelemetry tells you *what happened* &mdash; stage A took 50ms, stage B returned an error. FootPrint captures *why it happened* &mdash; stage A wrote `riskTier=high`, the decider read that value and chose the rejection path because DTI exceeded 43%. That's the gap: **causal traces** vs. event logs.

FootPrint is not a replacement for your existing observability stack. It's a **semantic layer on top**. OTel handles distributed tracing, latency, error rates. FootPrint handles the reasoning &mdash; what decisions were made, what data flowed where, and why each branch was taken. They're complementary.

### The Payoff

When your application produces causal traces as a byproduct of execution:

- **Ship the trace alongside the result** &mdash; The LLM gets structured context, not raw logs. Even cheap models can answer follow-ups accurately.
- **Narrative generation** &mdash; Runtime produces plain-English execution stories. Feed to follow-up LLM calls for context continuity.
- **Execution as artifact** &mdash; Every step is recorded, replayable, debuggable. Time-travel through your application's decisions.
- **Self-documenting tools** &mdash; Stage descriptions cascade into tool definitions. LLMs see the full inner workflow. No manual description writing needed.
- **Scoped state** &mdash; No global state bugs. Each stage gets isolated, patch-based memory with safe merges.
- **Pluggable observability** &mdash; Recorders capture per-stage data. DebugRecorder, MetricRecorder, and NarrativeRecorder ship out of the box. Bring your own logger.

---

## Mental Model

Think of FootPrint as a **flowchart runtime**. You define:

1. **Nodes** &mdash; Functions that do work
2. **Edges** &mdash; How nodes connect (linear, parallel, conditional)
3. **Scope** &mdash; Where data lives and flows

The runtime handles execution order, state management, and observability.

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR FLOWCHART                          │
│                                                             │
│   ┌─────┐     ┌─────┐     ┌─────┐                          │
│   │  A  │────>│  B  │────>│  C  │   Linear                 │
│   └─────┘     └─────┘     └─────┘                          │
│                                                             │
│   ┌─────┐     ┌─────┐                                      │
│   │  A  │──┬─>│ B1  │──┐                                   │
│   └─────┘  │  └─────┘  │  ┌─────┐                          │
│            ├─>│ B2  │──┼─>│  C  │  Fork (Parallel)         │
│            │  └─────┘  │  └─────┘                          │
│            └─>│ B3  │──┘                                   │
│               └─────┘                                      │
│                                                             │
│   ┌─────┐     ┌─────┐                                      │
│   │  A  │──?─>│ B1  │                                      │
│   └─────┘  │  └─────┘                                      │
│            └─>│ B2  │      Decider (One of N)              │
│               └─────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Not a DAG** | Supports loops, re-entry, and partial/resumed execution |
| **Parallel Fan-Out/In** | Fork pattern with automatic result aggregation |
| **Three-Level Scope** | Global, path, and node memory isolation |
| **Patch-Based State** | Atomic commits, safe merges, no race conditions |
| **First-Class Observability** | Connected logs, traces, time-travel debugging |
| **Composable Subflows** | Mount entire flowcharts as nodes in larger workflows |
| **Streaming Support** | Built-in streaming stages for LLM token emission |

---

## Installation

```bash
npm install footprint
```

---

## Quick Start

### 1. Define your scope

Define the shape of your data once. Stages read and write through this typed interface &mdash; no raw paths.

```typescript
import { flowChart, FlowChartExecutor, BaseState } from 'footprint';

// Define scope with typed getters/setters
class OrderScope extends BaseState {
  get cartTotal(): number {
    return this.getValue('cartTotal') ?? 0;
  }
  set cartTotal(value: number) {
    this.setValue('cartTotal', value);
  }
  get paymentStatus(): string {
    return this.getValue('paymentStatus') ?? 'pending';
  }
  set paymentStatus(value: string) {
    this.setValue('paymentStatus', value);
  }
}

const scopeFactory = (ctx: any, stageName: string) => new OrderScope(ctx, stageName);
```

### 2. Write stages that use the scope

Each stage receives the typed scope. Read what the previous stage wrote, write what the next stage needs.

```typescript
const chart = flowChart('ValidateCart', async (scope: OrderScope) => {
    scope.cartTotal = 79.98;
  })
  .addFunction('ProcessPayment', async (scope: OrderScope) => {
    const total = scope.cartTotal; // reads what ValidateCart wrote
    scope.paymentStatus = 'charged';
  })
  .addFunction('SendReceipt', async (scope: OrderScope) => {
    console.log('Receipt sent, status:', scope.paymentStatus);
  })
  .build();
```

### 3. Execute

```typescript
const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();
```

Or as a one-liner:

```typescript
const result = await flowChart('ValidateCart', validateFn)
  .addFunction('ProcessPayment', processFn)
  .addFunction('SendReceipt', receiptFn)
  .execute(scopeFactory);
```

---

## Patterns

### Linear

```typescript
flowChart('A', fnA)
  .addFunction('B', fnB)
  .addFunction('C', fnC)
  .build();
```

### Parallel (Fork)

```typescript
flowChart('Fetch', fetchFn)
  .addListOfFunction([
    { name: 'ParseHTML', fn: parseHTML },
    { name: 'ParseCSS',  fn: parseCSS },
    { name: 'ParseJS',   fn: parseJS },
  ])
  .addFunction('Merge', mergeFn)
  .build();
```

### Conditional (Decider)

```typescript
flowChart('Classify', classifyFn)
  .addDeciderFunction('Route', async (scope) => {
    return scope.priority === 'high' ? 'express' : 'standard';
  })
    .addFunctionBranch('express', 'Express', expressFn)
    .addFunctionBranch('standard', 'Standard', standardFn)
  .end()
  .build();
```

### Subflow Composition

```typescript
// Build reusable subflows
const faqFlow = flowChart('FAQ_Entry', faqEntryFn)
  .addFunction('FAQ_Answer', faqAnswerFn)
  .build();

const ragFlow = flowChart('RAG_Entry', ragEntryFn)
  .addFunction('RAG_Retrieve', ragRetrieveFn)
  .addFunction('RAG_Answer', ragAnswerFn)
  .build();

// Compose into main flow
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
  .onStream((streamId, token) => {
    process.stdout.write(token);
  })
  .onStreamEnd((streamId, fullText) => {
    console.log('\nComplete:', fullText);
  })
  .addFunction('ProcessResponse', processFn)
  .build();
```

---

## Scope

Each stage receives its own scope instance. The scope is your typed interface to shared state &mdash; define it once, use it everywhere.

### Typed Scope (Recommended)

Extend `BaseState` with getters and setters. Stages get IntelliSense, and the data flows through the pipeline automatically.

```typescript
class AgentScope extends BaseState {
  get messages(): Message[] {
    return this.getValue('messages') ?? [];
  }
  set messages(value: Message[]) {
    this.setValue('messages', value);
  }
  get model(): string {
    return this.getValue('model') ?? 'gpt-4';
  }
}
```

> **Direct property assignment does NOT persist.** Use `setValue` / `setObject` inside your getters/setters, not `scope.x = value` on a raw BaseState.

### Raw Scope (Low-level)

If you don't need a typed class, use the raw API:

```typescript
scope.setValue('total', 79.98);              // write (overwrite)
scope.updateValue('config', { retries: 3 }); // write (deep merge)
const total = scope.getValue('total');       // read
```

### Validated Scope (Zod)

Use Zod schemas for runtime validation:

```typescript
import { z } from 'zod';

const PipelineSchema = z.object({
  cartTotal: z.number(),
  transactionId: z.string().optional(),
});

class ValidatedScope extends BaseState {
  setCartTotal(value: number) {
    PipelineSchema.shape.cartTotal.parse(value);
    this.setValue('cartTotal', value);
  }
}
```

Full details: [Scope Communication Guide](./docs/guides/SCOPE_COMMUNICATION.md)

---

## Observability

FootPrint includes a composable observability layer built on two concepts: **Scope** (the runtime memory container) and **Recorders** (pluggable observers).

### Recorders

Recorders observe scope operations without modifying them. Implement any subset of six hooks: `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`.

```typescript
import { DebugRecorder, MetricRecorder, NarrativeRecorder } from 'footprint';

// Built-in recorders
scope.attachRecorder(new DebugRecorder({ verbosity: 'verbose' }));
scope.attachRecorder(new MetricRecorder());
scope.attachRecorder(new NarrativeRecorder());
```

Recorders compose freely &mdash; attach multiple for different concerns. Error isolation is built in: if a recorder throws, the error is routed to `onError` hooks of other recorders, and the scope operation continues normally.

### Custom Recorders

```typescript
import { Recorder, WriteEvent, StageEvent } from 'footprint';

class LLMRecorder implements Recorder {
  readonly id = 'llm-recorder';
  private stageStartTimes = new Map<string, number>();
  private entries: Array<{ model?: string; latencyMs: number; tokens?: number }> = [];

  onStageStart(event: StageEvent) {
    this.stageStartTimes.set(event.stageName, event.timestamp);
  }

  onWrite(event: WriteEvent) {
    if (event.key !== 'lastResponse') return;

    const startTime = this.stageStartTimes.get(event.stageName);
    const latencyMs = startTime ? event.timestamp - startTime : 0;
    const response = event.value as Record<string, unknown>;

    this.entries.push({
      model: response.model as string | undefined,
      latencyMs,
      tokens: (response.usage as any)?.totalTokens,
    });
  }

  getEntries() { return [...this.entries]; }
}
```

### Enriched Snapshots

Enable single-pass debug data capture &mdash; scope state, debug metadata, stage output, and history index during traversal:

```typescript
const chart = flowChart('entry', entryFn)
  .addFunction('process', processFn)
  .addTraversalExtractor((snapshot) => {
    const { node, stepNumber, scopeState, debugInfo, stageOutput, historyIndex } = snapshot;
    return { stageName: node.name, stepNumber, scopeState, debugInfo, stageOutput, historyIndex };
  })
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, true);
await executor.run();

const enriched = executor.getEnrichedResults();
```

Architecture details: [Scope Integration](./docs/architecture/SCOPE_INTEGRATION_PROPOSAL.md) &middot; [Memory Model](./docs/architecture/MEMORY_MODEL.md)

---

## Stage Descriptions

Attach a human-readable `description` to any stage. The builder incrementally composes a full execution context description as stages are added &mdash; no tree walking required at read time.

```typescript
const chart = flowChart('SeedScope', seedFn, 'seed-scope', undefined, 'Initialize conversation history')
  .addFunction('AssemblePrompt', promptFn, 'assemble-prompt', undefined, 'Build LLM message array')
  .addStreamingFunction('CallLLM', 'llm-stream', llmFn, 'call-llm', undefined, 'Send messages to LLM provider')
  .addFunction('ParseResponse', parseFn, 'parse-response', undefined, 'Extract text or tool calls')
  .addDeciderFunction('RouteDecider', deciderFn, 'route-decider', undefined, 'Route based on tool calls')
    .addFunctionBranch('execute-tools', 'ExecuteTools', toolsFn, undefined, 'Run tools and loop back')
    .addFunctionBranch('finalize', 'Finalize', finalizeFn, undefined, 'Extract final response')
  .end()
  .build();

console.log(chart.description);
// FlowChart: SeedScope
// Steps:
// 1. SeedScope — Initialize conversation history
// 2. AssemblePrompt — Build LLM message array
// 3. CallLLM — Send messages to LLM provider
// 4. ParseResponse — Extract text or tool calls
// 5. RouteDecider — Route based on tool calls
//    → execute-tools: Run tools and loop back
//    → finalize: Extract final response
```

The built `FlowChart` exposes two fields:

| Field | Type | Description |
|-------|------|-------------|
| `flowChart.description` | `string` | Full numbered execution context description |
| `flowChart.stageDescriptions` | `Map<string, string>` | Individual stage descriptions keyed by stage name |

When a `FlowChart` is registered as a tool handler in `ToolRegistry`, the registry auto-extracts `flowChart.description` as the tool description &mdash; no manual duplication needed.

---

## Architecture

FootPrint separates **building** from **executing**:

```
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│   FlowChartBuilder  │─────>│      FlowChart      │─────>│  FlowChartExecutor  │
│   (Build-time DSL)  │      │   (Compiled Tree)   │      │   (Runtime Engine)  │
└─────────────────────┘      └─────────────────────┘      └─────────────────────┘
        │                            │                            │
        │ flowChart()                │ .build()                   │ .run()
        │ .addFunction()             │                            │ .getEnrichedResults()
        │ .addDeciderFunction()      │                            │ .getExtractedResults()
        │ .addSubFlowChart()         │                            │
        └────────────────────────────┴────────────────────────────┘
```

- **FlowChartBuilder** &mdash; Fluent DSL for defining your flowchart structure
- **FlowChart** &mdash; Compiled tree with stage functions and metadata
- **FlowChartExecutor** &mdash; Runtime engine that executes the compiled flowchart

---

## API Reference

### Builder Methods

| Method | Description |
|--------|-------------|
| `start(name, fn?)` | Define root stage |
| `addFunction(name, fn?)` | Add linear next stage |
| `addListOfFunction(specs)` | Add parallel children (fork) |
| `addDeciderFunction(name, fn)` | Add single-choice branching |
| `addSelector(fn)` | Add multi-choice branching |
| `addSubFlowChart(id, flow)` | Mount subflow as child |
| `addSubFlowChartNext(id, flow)` | Mount subflow as next |
| `addStreamingFunction(name, streamId?, fn?)` | Add streaming stage |
| `addTraversalExtractor(fn)` | Register data extractor |
| `loopTo(stageId)` | Loop back to earlier stage |
| `build()` | Compile to FlowChart |
| `execute(scopeFactory)` | Build + run (convenience) |
| `toSpec()` | Export pure JSON (no functions) |

### Executor Methods

| Method | Description |
|--------|-------------|
| `run()` | Execute the flowchart |
| `getExtractedResults()` | Extractor results map |
| `getEnrichedResults()` | Enriched results (single-pass, when `enrichSnapshots: true`) |
| `getSubflowResults()` | Subflow execution data |
| `getNarrative()` | Plain-English execution story |
| `getExtractorErrors()` | Errors from extractor |

---

## How FootPrint Compares

FootPrint occupies a unique space between simple async/await and full workflow orchestration:

| Aspect | async/await | FootPrint | Temporal / Step Functions |
|--------|-------------|-----------|--------------------------|
| **Control Flow** | Implicit in code | Explicit flowchart | External orchestrator |
| **State** | Manual/global | Scoped & managed | Durable storage |
| **Debugging** | Stack traces | Time-travel | Event history |
| **Complexity** | Low | Medium | High |
| **Use Case** | Scripts | Applications | Distributed systems |

FootPrint gives you **explicit control flow** and **scoped state** without the operational overhead of distributed workflow systems.

---

## When to Use FootPrint

**Use FootPrint when:**

- Your problem naturally fits a flowchart
- You need parallel + serial steps with explicit control
- You want scoped state without global variable bugs
- You need production observability and debugging
- You're building AI-compatible applications

**Don't use FootPrint when:**

- Simple linear scripts (just use async/await)
- You need a full workflow orchestration system (use Temporal, Step Functions)
- You want an opaque agent to decide structure for you

---

## Examples

The [`demo/`](./demo) folder contains progressive examples:

| Demo | Pattern | Complexity | Key Concept |
|------|---------|------------|-------------|
| [1-payment](./demo/src/1-payment/) | Linear | Basic | Stage chaining |
| [2-llm-tool-loop](./demo/src/2-llm-tool-loop/) | Decider | Intermediate | Conditional branching |
| [3-parallel](./demo/src/3-parallel/) | Fork | Intermediate | Parallel execution |
| [4-selector](./demo/src/4-selector/) | Selector | Advanced | Multi-choice parallel |
| [5-composed](./demo/src/5-composed/) | Composition | Advanced | Apps as building blocks |
| [6-subflow-extractor](./demo/src/6-subflow-extractor/) | Subflow | Advanced | TraversalExtractor with subflows |
| [7-build-vs-runtime](./demo/src/7-build-vs-runtime/) | Extraction | Advanced | toSpec() vs runtime extraction |
| [8-loan-application](./demo/src/8-loan-application/) | Narrative | Intermediate | Causal traces & "why was I rejected?" |

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
```

Demo guide: [demo/README.md](./demo/README.md)

---

## Documentation

**Start here:** [Getting Started](./docs/guides/GETTING_STARTED.md) &middot; [Core Concepts](./docs/guides/CORE_CONCEPTS.md) &middot; [Patterns](./docs/guides/PATTERNS.md)

**Guides:** [Scope Communication](./docs/guides/SCOPE_COMMUNICATION.md) &middot; [Dynamic Children](./docs/guides/DYNAMIC_CHILDREN.md)

**Features:** [The Cascade](./docs/features/README.md) &middot; [Stage Descriptions](./docs/features/stage-descriptions.md) &middot; [Recorders](./docs/features/recorders.md) &middot; [Narrative Generation](./docs/features/narrative-generation.md) &middot; [Enriched Snapshots](./docs/features/observability-enriched-snapshots.md) &middot; [Traversal Extractor](./docs/features/traversal-extractor.md)

**Internals:** [Terminology](./docs/TERMINOLOGY.md) &middot; [Control-Flow Model](./docs/internals/CONTROL_FLOW_MODEL.md) &middot; [Scope Isolation](./docs/internals/SCOPE_ISOLATION_DESIGN.md) &middot; [Memory Model](./docs/architecture/MEMORY_MODEL.md) &middot; [Subgraph Architecture](./docs/SUBGRAPH_ARCHITECTURE.md)

**Training** (~2 hours): [Functions](./docs/training/01-FUNCTIONS.md) &rarr; [Execution](./docs/training/02-EXECUTION.md) &rarr; [Memory](./docs/training/03-MEMORY.md) &rarr; [Scope](./docs/training/04-SCOPE.md) &rarr; [Flowchart Execution](./docs/training/05-FLOWCHART_EXECUTION.md)

---

## Contributing

```
src/
├── core/                    # Public API layer
│   ├── builder/            # FlowChartBuilder DSL
│   ├── memory/             # StageContext, GlobalStore, PipelineRuntime
│   ├── executor/           # FlowChartExecutor, Pipeline
│   │   └── handlers/       # StageRunner, NodeResolver, handlers
│   ├── context/            # (deprecated re-exports)
│   └── pipeline/           # (deprecated re-exports)
├── internal/               # Library internals (not for consumers)
│   ├── memory/             # WriteBuffer, utils
│   └── history/            # ExecutionHistory
├── scope/                  # Consumer extensibility layer
│   ├── providers/          # Registry, resolve, guards
│   ├── recorders/          # DebugRecorder, MetricRecorder
│   ├── protection/         # Scope protection utilities
│   └── state/              # Zod integration
└── utils/                  # Shared utilities (logger, scopeLog)

test/
├── unit/                   # Unit tests mirroring src/ structure
├── properties/             # Property-based tests (fast-check)
└── scenarios/              # Cross-module integration tests
```

See [architecture docs](./docs/architecture/FOLDER_REORGANIZATION_DESIGN.md) for detailed design documentation.

---

## License

[MIT](./LICENSE)
