---
name: footprint
description: Use when building flowchart pipelines with footprintjs — stage functions, decider branches, selectors, subflows, loops, narrative traces, recorders, redaction, contracts, and LLM-ready output. Also use when someone asks how footprint.js works or wants to understand the library.
---

# footprint.js — The Flowchart Pattern for Backend Code

footprint.js structures backend logic as a graph of named functions with transactional state. The code becomes self-explainable: every run auto-generates a causal trace of what happened and why.

**Core principle:** All data collection happens during the single DFS traversal pass — never post-process or walk the tree again.

```bash
npm install footprintjs
```

---

## Quick Start

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart('ReceiveOrder', (scope) => {
    scope.setValue('orderId', 'ORD-123');
    scope.setValue('amount', 49.99);
  }, 'receive-order', undefined, 'Receive and validate the incoming order')
  .addFunction('ProcessPayment', (scope) => {
    const amount = scope.getValue('amount');
    scope.setValue('paymentStatus', amount < 100 ? 'approved' : 'review');
  }, 'process-payment', 'Charge customer and record payment status')
  .setEnableNarrative()
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run({ input: { orderId: 'ORD-123' } });

console.log(executor.getNarrative());
// Stage 1: The process began with ReceiveOrder.
//   Step 1: Write orderId = "ORD-123"
//   Step 2: Write amount = 49.99
// Stage 2: Next, it moved on to ProcessPayment.
//   Step 1: Read amount = 49.99
//   Step 2: Write paymentStatus = "approved"
```

---

## FlowChartBuilder API

Always chain from `flowChart()` or `new FlowChartBuilder()`.

### Linear Stages

```typescript
import { flowChart } from 'footprintjs';

const chart = flowChart('StageA', fnA, 'stage-a', undefined, 'Description of A')
  .addFunction('StageB', fnB, 'stage-b', 'Description of B')
  .addFunction('StageC', fnC, 'stage-c', 'Description of C')
  .build();
```

**Parameters:** `(name: string, fn: PipelineStageFunction, id: string, description?: string)`

- `name` — human-readable label (used in narrative)
- `fn` — the stage function
- `id` — stable identifier (used for branching, visualization, loop targets)
- `description` — optional, appears in narrative and auto-generated tool descriptions

### Stage Function Signature

```typescript
type PipelineStageFunction = (
  scope: ScopeFacade,       // read/write transactional state
  breakPipeline: () => void, // call to stop execution early
  streamCallback?: StreamCallback, // for streaming stages
) => Promise<void> | void;
```

### ScopeFacade — State Access

Every stage receives a `ScopeFacade` that tracks all reads and writes:

```typescript
const myStage = (scope: ScopeFacade) => {
  // Read (tracked — appears in narrative)
  const name = scope.getValue('applicantName') as string;

  // Write (tracked — appears in narrative)
  scope.setValue('greeting', `Hello, ${name}!`);

  // Update (deep merge for objects)
  scope.updateValue('profile', { verified: true });

  // Delete
  scope.deleteValue('tempData');

  // Readonly input (frozen, not tracked in narrative)
  const config = scope.getArgs<{ maxRetries: number }>();
};
```

**IMPORTANT:** `getValue`/`setValue` are tracked and produce narrative. `getArgs()` returns frozen readonly input and is NOT tracked.

### Decider Branches (Single-Choice Conditional)

```typescript
const chart = flowChart('Intake', intakeFn, 'intake')
  .addDeciderFunction('AssessRisk', (scope) => {
    const score = scope.getValue('riskScore') as number;
    // Return the branch ID to take
    return score > 70 ? 'high-risk' : 'low-risk';
  }, 'assess-risk', 'Evaluate risk and route accordingly')
    .addFunctionBranch('high-risk', 'RejectApplication', rejectFn, 'Reject due to high risk')
    .addFunctionBranch('low-risk', 'ApproveApplication', approveFn, 'Approve the application')
    .setDefault('high-risk') // fallback if branch ID doesn't match
    .end()
  .build();
```

The decider function **returns a branch ID string**. The engine matches it to a child and executes that branch. The decision is recorded in the narrative.

### Selector Branches (Multi-Choice Fan-Out)

```typescript
const chart = flowChart('Intake', intakeFn, 'intake')
  .addSelectorFunction('SelectChecks', (scope) => {
    const checks = [];
    if (scope.getValue('needsCredit')) checks.push('credit-check');
    if (scope.getValue('needsIdentity')) checks.push('identity-check');
    // Return array of branch IDs to execute in parallel
    return checks;
  }, 'select-checks')
    .addFunctionBranch('credit-check', 'CreditCheck', creditFn)
    .addFunctionBranch('identity-check', 'IdentityCheck', identityFn)
    .end()
  .build();
```

### Parallel Execution (Fork)

```typescript
builder.addListOfFunction([
  { id: 'check-a', name: 'CheckA', fn: checkAFn },
  { id: 'check-b', name: 'CheckB', fn: checkBFn },
  { id: 'check-c', name: 'CheckC', fn: checkCFn },
], { failFast: true }); // reject on first error
```

### Subflows (Nested Flowcharts)

```typescript
// Build a reusable sub-pipeline
const creditSubflow = flowChart('PullReport', pullReportFn, 'pull-report')
  .addFunction('ScoreReport', scoreReportFn, 'score-report')
  .build();

// Mount as linear continuation
builder.addSubFlowChartNext('credit-sub', creditSubflow, 'CreditCheck', {
  inputMapper: (parentScope) => ({ ssn: parentScope.getValue('ssn') }),
  outputMapper: (subOut, parentScope) => ({ creditScore: subOut.score }),
});

// Mount as decider branch
builder.addDeciderFunction('Route', routerFn, 'route')
  .addSubFlowChartBranch('detailed', creditSubflow, 'DetailedCheck')
  .addFunctionBranch('simple', 'SimpleCheck', simpleFn)
  .end();
```

### Loops

```typescript
builder
  .addFunction('RetryPayment', async (scope) => {
    const attempts = (scope.getValue('attempts') as number ?? 0) + 1;
    scope.setValue('attempts', attempts);
    if (attempts >= 3) return; // exit loop by not looping
  }, 'retry-payment')
  .loopTo('retry-payment'); // back-edge to this stage's ID
```

### Configuration

```typescript
builder
  .setEnableNarrative()              // enable narrative recording
  .setInputSchema(zodSchema)         // validate input (Zod or JSON Schema)
  .setOutputSchema(outputZodSchema)  // declare output shape
  .setOutputMapper((state) => ({     // map final state to response
    decision: state.decision,
    reason: state.reason,
  }));
```

### Output

```typescript
const chart = builder.build();      // FlowChart object (for executor)
const spec = builder.toSpec();       // JSON-safe structure (for visualization)
const mermaid = builder.toMermaid(); // Mermaid diagram string
```

---

## FlowChartExecutor API

```typescript
import { FlowChartExecutor } from 'footprintjs';

const executor = new FlowChartExecutor(chart);

// Run with input
const result = await executor.run({
  input: { applicantName: 'Bob', income: 42000 },
  timeoutMs: 5000,    // optional auto-abort
  signal: controller.signal, // optional AbortSignal
});

// Get narrative (combined flow + data operations)
const narrative: string[] = executor.getNarrative();
// ["Stage 1: The process began with ReceiveApplication.",
//  "  Step 1: Write app = {applicantName, income, ...}",
//  "Stage 2: Next, it moved on to AssessRisk.",
//  "  Step 1: Read app = ...",
//  "  Step 2: Write riskTier = \"high\"",
//  "[Condition]: A decision was made, path taken was RejectApplication."]

// Structured entries (for programmatic access)
const entries: CombinedNarrativeEntry[] = executor.getNarrativeEntries();
// [{ type: 'stage', text: '...', depth: 0, stageName: 'ReceiveApplication' },
//  { type: 'step', text: 'Write app = ...', depth: 1, stageName: 'ReceiveApplication', stepNumber: 1 },
//  { type: 'condition', text: '...', depth: 0 }]

// Full memory snapshot
const snapshot = executor.getSnapshot();
// { sharedState: { ... }, commitLog: [...], subflowResults: Map }

// Flow-only narrative (no data operations)
const flowOnly: string[] = executor.getFlowNarrative();
```

---

## Recorder System — Collect During Traversal

**The core innovation.** Two observer layers fire during the single DFS pass:

### Scope Recorders (data operations)

Attached to `ScopeFacade`, fire during `getValue()`/`setValue()`:

```typescript
import { MetricRecorder, DebugRecorder, NarrativeRecorder } from 'footprintjs';

// Built-in recorders
const metrics = new MetricRecorder();
const debug = new DebugRecorder('verbose'); // or 'minimal'

// Attach to scope (usually via scope factory)
scope.attachRecorder(metrics);
scope.attachRecorder(debug);

// After execution
metrics.getSummary(); // { totalReads: 12, totalWrites: 8, stages: {...} }
debug.getEntries();   // [{ type: 'read', key: 'app', value: {...}, stage: 'Intake' }, ...]
```

### FlowRecorders (control flow events)

Attached to executor, fire after each stage/decision/fork:

```typescript
import { NarrativeFlowRecorder, AdaptiveNarrativeFlowRecorder } from 'footprintjs';

// Attach before run()
executor.attachFlowRecorder(new NarrativeFlowRecorder());

// 8 built-in strategies:
// NarrativeFlowRecorder      — all events as sentences (default)
// AdaptiveNarrativeFlowRecorder — full detail then sampling for loops
// WindowedNarrativeFlowRecorder — keep last N iterations only
// RLENarrativeFlowRecorder    — run-length encode repeated loops
// MilestoneNarrativeFlowRecorder — only decisions, errors, subflows
// ProgressiveNarrativeFlowRecorder — progress markers for streaming UIs
// SeparateNarrativeFlowRecorder — dual channels (main + loop detail)
// ManifestFlowRecorder        — subflow tree + spec catalog for LLM exploration
```

### Custom FlowRecorder

```typescript
import type { FlowRecorder, FlowStageEvent, FlowDecisionEvent } from 'footprintjs';

const myRecorder: FlowRecorder = {
  id: 'my-recorder',
  onStageExecuted(event: FlowStageEvent) {
    console.log(`Executed: ${event.stageName}`);
  },
  onDecision(event: FlowDecisionEvent) {
    console.log(`Decision at ${event.stageName}: chose ${event.chosen}`);
  },
  clear() {
    // Reset state before each run
  },
};

executor.attachFlowRecorder(myRecorder);
```

### CombinedNarrativeRecorder (the inline dual-channel recorder)

This is what powers `getNarrative()` and `getNarrativeEntries()`. It implements BOTH `Recorder` (scope) and `FlowRecorder` (engine) interfaces. It buffers scope ops per-stage, then flushes when the flow event arrives — producing merged entries in a single pass.

**You don't need to create this manually.** Calling `.setEnableNarrative()` on the builder auto-attaches it.

---

## Redaction (PII Protection)

```typescript
executor.setRedactionPolicy({
  keys: ['ssn', 'creditCardNumber'],           // exact key names
  patterns: [/password/i, /^secret.*/],        // regex patterns
  fields: { applicant: ['ssn', 'address.zip'] }, // nested field paths
});

await executor.run({ input: { ... } });

// Narrative shows: Write ssn = [REDACTED]
// Recorders receive scrubbed values
const report = executor.getRedactionReport();
// { redactedKeys: ['ssn'], patternsMatched: [...] } — never contains actual values
```

---

## Contracts & OpenAPI

```typescript
import { defineContract, generateOpenAPI } from 'footprintjs';
import { z } from 'zod';

const contract = defineContract(chart, {
  inputSchema: z.object({
    applicantName: z.string(),
    income: z.number(),
  }),
  outputSchema: z.object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string(),
  }),
  outputMapper: (state) => ({
    decision: state.decision,
    reason: state.reason,
  }),
});

const openApiSpec = generateOpenAPI(contract, {
  title: 'Loan Underwriting API',
  version: '1.0.0',
});
```

---

## Event Ordering (Critical for Understanding)

When a stage executes, events fire in this exact order:

```
1. Recorder.onStageStart        — stage begins
2. Recorder.onRead              — each getValue() call (DURING execution)
3. Recorder.onWrite             — each setValue() call (DURING execution)
4. Recorder.onCommit            — transaction buffer flushes to shared memory
5. Recorder.onStageEnd          — stage completes
6. FlowRecorder.onStageExecuted — control flow records the stage
   (CombinedNarrativeRecorder flushes buffered ops here)
7. FlowRecorder.onNext          — moving to next stage
   OR FlowRecorder.onDecision   — if this was a decider
   OR FlowRecorder.onFork       — if children execute in parallel
```

**This ordering is what makes inline collection work.** Scope events buffer during execution, flow events trigger the flush.

---

## Anti-Patterns to Avoid

1. **Never post-process the tree.** Don't walk the spec after execution to collect data. Use recorders.
2. **Never use `CombinedNarrativeBuilder`** — it's deprecated. Use `CombinedNarrativeRecorder` (auto-attached by `setEnableNarrative()`).
3. **Don't extract a shared base class** for Recorder and FlowRecorder. They look similar but serve different layers. Two instances = coincidence.
4. **Don't call `getArgs()` for tracked data.** `getArgs()` returns frozen readonly input. Use `getValue()`/`setValue()` for state that should appear in the narrative.
5. **Don't create scope recorders manually** unless building a custom recorder. `setEnableNarrative()` handles everything.

---

## Library Structure (for contributors)

```
src/lib/
├── memory/    → SharedMemory, StageContext, TransactionBuffer, EventLog (foundation)
├── schema/    → detectSchema, validate, InputValidationError (foundation)
├── builder/   → FlowChartBuilder, flowChart(), DeciderList, SelectorFnList (standalone)
├── scope/     → ScopeFacade, recorders/, providers/, protection/ (depends: memory)
├── engine/    → FlowchartTraverser, handlers/, narrative/ (depends: memory, scope, builder)
├── runner/    → FlowChartExecutor, ExecutionRuntime (depends: engine, scope, schema)
└── contract/  → defineContract, generateOpenAPI (depends: schema)
```

Two entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/advanced'` — internals (memory, traverser, handlers)

---

## Common Patterns

### Pipeline with decision + narrative

```typescript
const chart = flowChart('Receive', receiveFn, 'receive')
  .addFunction('Analyze', analyzeFn, 'analyze')
  .addDeciderFunction('Decide', decideFn, 'decide')
    .addFunctionBranch('approve', 'Approve', approveFn)
    .addFunctionBranch('reject', 'Reject', rejectFn)
    .setDefault('reject')
    .end()
  .setEnableNarrative()
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run({ input: data });
const trace = executor.getNarrative();
// Feed trace to LLM for grounded explanations
```

### Subflow with input/output mapping

```typescript
const subflow = flowChart('SubStart', subStartFn, 'sub-start')
  .addFunction('SubProcess', subProcessFn, 'sub-process')
  .build();

const main = flowChart('Main', mainFn, 'main')
  .addSubFlowChartNext('my-subflow', subflow, 'SubflowMount', {
    inputMapper: (scope) => ({ key: scope.getValue('parentKey') }),
    outputMapper: (subOut) => ({ result: subOut.processed }),
  })
  .build();
```

### Attach multiple recorders

```typescript
import { ManifestFlowRecorder, MilestoneNarrativeFlowRecorder } from 'footprintjs';

executor.attachFlowRecorder(new ManifestFlowRecorder());
executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder());

await executor.run({ input: data });

const manifest = executor.getSubflowManifest(); // subflow catalog
const milestones = executor.getFlowNarrative();  // key events only
```
