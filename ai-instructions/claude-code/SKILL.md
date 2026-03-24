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
import { typedFlowChart, createTypedScopeFactory, FlowChartExecutor } from 'footprintjs';

interface OrderState {
  orderId: string;
  amount: number;
  paymentStatus: string;
}

const chart = typedFlowChart<OrderState>('ReceiveOrder', (scope) => {
    scope.orderId = 'ORD-123';
    scope.amount = 49.99;
  }, 'receive-order', undefined, 'Receive and validate the incoming order')
  .addFunction('ProcessPayment', (scope) => {
    const amount = scope.amount;
    scope.paymentStatus = amount < 100 ? 'approved' : 'review';
  }, 'process-payment', 'Charge customer and record payment status')
  .setEnableNarrative()
  .build();

const executor = new FlowChartExecutor(chart, createTypedScopeFactory<OrderState>());
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

Always chain from `typedFlowChart<T>()` (recommended) or `flowChart()`.

### Linear Stages

```typescript
import { typedFlowChart } from 'footprintjs';

interface MyState {
  valueA: string;
  valueB: number;
  valueC: boolean;
}

const chart = typedFlowChart<MyState>('StageA', fnA, 'stage-a', undefined, 'Description of A')
  .addFunction('StageB', fnB, 'stage-b', 'Description of B')
  .addFunction('StageC', fnC, 'stage-c', 'Description of C')
  .build();
```

**Parameters:** `(name: string, fn: PipelineStageFunction, id: string, description?: string)`

- `name` — human-readable label (used in narrative)
- `fn` — the stage function
- `id` — stable identifier (used for branching, visualization, loop targets)
- `description` — optional, appears in narrative and auto-generated tool descriptions

### Stage Function Signature (TypedScope)

With `typedFlowChart<T>()`, stage functions receive a `TypedScope<T>` proxy. All reads and writes use typed property access:

```typescript
interface LoanState {
  creditTier: string;
  amount: number;
  customer: { name: string; address: { zip: string } };
  tags: string[];
  approved?: boolean;
}

const myStage = (scope: TypedScope<LoanState>) => {
  // Typed writes (tracked — appear in narrative)
  scope.creditTier = 'A';
  scope.amount = 50000;

  // Deep write (auto-delegates to updateValue)
  scope.customer.address.zip = '90210';

  // Array copy-on-write
  scope.tags.push('vip');

  // Optional fields
  scope.approved = true;

  // $-prefixed escape hatches for non-state operations
  scope.$debug('checkpoint', { step: 1 });
  scope.$metric('latency', 42);
  const args = scope.$getArgs<{ requestId: string }>();
  const env = scope.$getEnv();
  scope.$break();  // stop pipeline execution early
};
```

**Three access tiers:**
- **Typed properties** (`scope.amount = 50000`) — mutable shared state, tracked in narrative
- **`$getArgs()`** — frozen business input from `run({ input })`, NOT tracked
- **`$getEnv()`** — frozen infrastructure context from `run({ env })`, NOT tracked. Returns `ExecutionEnv { signal?, timeoutMs?, traceId? }`. Auto-inherited by subflows. Closed type.

### Decider Branches with decide() (Single-Choice Conditional)

Use `decide()` for structured decision evidence capture. It auto-records which values led to the decision in the narrative.

```typescript
import { decide } from 'footprintjs';

interface RiskState {
  creditScore: number;
  dti: number;
  riskTier: string;
}

const chart = typedFlowChart<RiskState>('Intake', intakeFn, 'intake')
  .addDeciderFunction('AssessRisk', (scope) => {
    // decide() captures filter evidence automatically
    return decide(scope, [
      { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'low-risk', label: 'Good credit' },
      { when: (s) => s.creditScore > 600, then: 'medium-risk', label: 'Marginal credit' },
    ], 'high-risk');
    // Narrative: "It evaluated Rule 0 'Good credit': creditScore 750 gt 700, and chose low-risk."
  }, 'assess-risk', 'Evaluate risk and route accordingly')
    .addFunctionBranch('high-risk', 'RejectApplication', rejectFn, 'Reject due to high risk')
    .addFunctionBranch('medium-risk', 'ManualReview', reviewFn, 'Send to manual review')
    .addFunctionBranch('low-risk', 'ApproveApplication', approveFn, 'Approve the application')
    .setDefault('high-risk') // fallback if branch ID doesn't match
    .end()
  .build();
```

The `decide()` function accepts two `when` formats:
- **Filter format:** `{ creditScore: { gt: 700 } }` — declarative, auto-captures evidence
- **Function format:** `(s) => s.creditScore > 600` — arbitrary logic with optional `label`

The decider function **returns a branch ID string**. The engine matches it to a child and executes that branch. The decision and its evidence are recorded in the narrative.

### Selector Branches with select() (Multi-Choice Fan-Out)

Use `select()` for structured multi-choice evidence capture:

```typescript
import { select } from 'footprintjs';

interface CheckState {
  needsCredit: boolean;
  needsIdentity: boolean;
}

const chart = typedFlowChart<CheckState>('Intake', intakeFn, 'intake')
  .addSelectorFunction('SelectChecks', (scope) => {
    return select(scope, [
      { when: { needsCredit: { eq: true } }, then: 'credit-check', label: 'Credit required' },
      { when: { needsIdentity: { eq: true } }, then: 'identity-check', label: 'Identity required' },
    ]);
    // Returns array of matching branch IDs
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
const creditSubflow = typedFlowChart<CreditState>('PullReport', pullReportFn, 'pull-report')
  .addFunction('ScoreReport', scoreReportFn, 'score-report')
  .build();

// Mount as linear continuation
builder.addSubFlowChartNext('credit-sub', creditSubflow, 'CreditCheck', {
  inputMapper: (parentScope) => ({ ssn: parentScope.ssn }),
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
interface RetryState {
  attempts: number;
  paymentResult?: string;
}

builder
  .addFunction('RetryPayment', async (scope) => {
    scope.attempts = (scope.attempts ?? 0) + 1;
    if (scope.attempts >= 3) return; // exit loop by not looping
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
import { FlowChartExecutor, createTypedScopeFactory } from 'footprintjs';

interface AppState {
  applicantName: string;
  income: number;
  riskTier?: string;
  decision?: string;
}

const executor = new FlowChartExecutor(chart, createTypedScopeFactory<AppState>());

// Run with input and optional execution environment
const result = await executor.run({
  input: { applicantName: 'Bob', income: 42000 },
  env: { traceId: 'req-123', timeoutMs: 5000 },
});

// Get narrative (combined flow + data operations)
const narrative: string[] = executor.getNarrative();
// ["Stage 1: The process began with ReceiveApplication.",
//  "  Step 1: Write applicantName = \"Bob\"",
//  "Stage 2: Next, it moved on to AssessRisk.",
//  "  Step 1: Read income = 42000",
//  "  Step 2: Write riskTier = \"high\"",
//  "[Condition]: A decision was made, path taken was RejectApplication."]

// Structured entries (for programmatic access)
const entries: CombinedNarrativeEntry[] = executor.getNarrativeEntries();
// [{ type: 'stage', text: '...', depth: 0, stageName: 'ReceiveApplication' },
//  { type: 'step', text: 'Write applicantName = ...', depth: 1, stageName: 'ReceiveApplication', stepNumber: 1 },
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

Fire during typed property access (reads/writes). Attach via `executor.attachRecorder()`:

```typescript
import { MetricRecorder, DebugRecorder } from 'footprintjs';

// Built-in recorders
const metrics = new MetricRecorder();
const debug = new DebugRecorder('verbose'); // or 'minimal'

// Attach to executor (one-liner, no custom scopeFactory needed)
executor.attachRecorder(metrics);
executor.attachRecorder(debug);

await executor.run({ input: data });

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
    // event.evidence available when using decide()
    if (event.evidence) {
      console.log(`Evidence: ${JSON.stringify(event.evidence)}`);
    }
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
2. Recorder.onRead              — each typed property read (DURING execution)
3. Recorder.onWrite             — each typed property write (DURING execution)
4. Recorder.onCommit            — transaction buffer flushes to shared memory
5. Recorder.onStageEnd          — stage completes
6. FlowRecorder.onStageExecuted — control flow records the stage
   (CombinedNarrativeRecorder flushes buffered ops here)
7. FlowRecorder.onNext          — moving to next stage
   OR FlowRecorder.onDecision   — if this was a decider (carries evidence from decide())
   OR FlowRecorder.onFork       — if children execute in parallel
   OR FlowRecorder.onSelected   — if this was a selector (carries evidence from select())
```

**This ordering is what makes inline collection work.** Scope events buffer during execution, flow events trigger the flush.

---

## Anti-Patterns to Avoid

1. **Never post-process the tree.** Don't walk the spec after execution to collect data. Use recorders.
2. **Don't use `getValue()`/`setValue()` in TypedScope stages.** Use typed property access (`scope.amount = 50000`). The old ScopeFacade API is internal only.
3. **Don't use `$`-prefixed state keys** (e.g., `$break` as a property name) — they collide with TypedScope's `$`-prefixed escape hatches (`$getArgs`, `$getEnv`, `$break`, `$debug`, `$metric`).
4. **Never use `CombinedNarrativeBuilder`** — it's deprecated. Use `CombinedNarrativeRecorder` (auto-attached by `setEnableNarrative()`).
5. **Don't extract a shared base class** for Recorder and FlowRecorder. They look similar but serve different layers. Two instances = coincidence.
6. **Don't call `$getArgs()` for tracked data.** `$getArgs()` returns frozen readonly input. Use typed scope properties for state that should appear in the narrative.
7. **Don't put infrastructure data in `$getArgs()`.** Use `$getEnv()` via `run({ env })` for signals, timeouts, and trace IDs.
8. **Don't create scope recorders manually** unless building a custom recorder. `setEnableNarrative()` handles everything.

---

## Library Structure (for contributors)

```
src/lib/
├── memory/    → SharedMemory, StageContext, TransactionBuffer, EventLog (foundation)
├── schema/    → detectSchema, validate, InputValidationError (foundation)
├── builder/   → FlowChartBuilder, flowChart(), typedFlowChart(), DeciderList, SelectorFnList (standalone)
├── scope/     → ScopeFacade, recorders/, providers/, protection/ (depends: memory)
├── reactive/  → TypedScope<T> deep Proxy, typed property access, $-methods, cycle-safe (depends: scope)
├── decide/    → decide()/select() decision evidence capture, filter + function when formats (depends: scope)
├── engine/    → FlowchartTraverser, handlers/, narrative/ (depends: memory, scope, reactive, builder)
├── runner/    → FlowChartExecutor, ExecutionRuntime (depends: engine, scope, schema)
└── contract/  → defineContract, generateOpenAPI (depends: schema)
```

Dependency DAG: `memory <- scope <- reactive <- engine <- runner`, `schema <- engine`, `builder (standalone) -> engine`, `contract <- schema`, `decide -> scope`

Two entry points:
- `import { ... } from 'footprintjs'` — public API
- `import { ... } from 'footprintjs/advanced'` — internals (memory, traverser, handlers)

---

## Common Patterns

### Pipeline with decide() + narrative

```typescript
import { typedFlowChart, createTypedScopeFactory, FlowChartExecutor, decide } from 'footprintjs';

interface LoanState {
  applicantName: string;
  income: number;
  creditScore: number;
  dti: number;
  decision?: string;
  reason?: string;
}

const chart = typedFlowChart<LoanState>('Receive', (scope) => {
    const args = scope.$getArgs<{ applicantName: string; income: number }>();
    scope.applicantName = args.applicantName;
    scope.income = args.income;
  }, 'receive')
  .addFunction('Analyze', (scope) => {
    scope.creditScore = 750;  // from credit bureau
    scope.dti = 0.35;         // computed
  }, 'analyze')
  .addDeciderFunction('Decide', (scope) => {
    return decide(scope, [
      { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approve', label: 'Good credit' },
      { when: (s) => s.creditScore > 600, then: 'approve', label: 'Marginal but acceptable' },
    ], 'reject');
  }, 'decide')
    .addFunctionBranch('approve', 'Approve', (scope) => {
      scope.decision = 'approved';
      scope.reason = 'Meets credit criteria';
    })
    .addFunctionBranch('reject', 'Reject', (scope) => {
      scope.decision = 'rejected';
      scope.reason = 'Does not meet credit criteria';
    })
    .setDefault('reject')
    .end()
  .setEnableNarrative()
  .build();

const executor = new FlowChartExecutor(chart, createTypedScopeFactory<LoanState>());
await executor.run({ input: { applicantName: 'Bob', income: 42000 } });
const trace = executor.getNarrative();
// Feed trace to LLM for grounded explanations
```

### Subflow with input/output mapping

```typescript
interface SubState {
  ssn: string;
  score: number;
}

interface MainState {
  ssn: string;
  parentKey: string;
  creditScore?: number;
}

const subflow = typedFlowChart<SubState>('SubStart', subStartFn, 'sub-start')
  .addFunction('SubProcess', subProcessFn, 'sub-process')
  .build();

const main = typedFlowChart<MainState>('Main', mainFn, 'main')
  .addSubFlowChartNext('my-subflow', subflow, 'SubflowMount', {
    inputMapper: (scope) => ({ ssn: scope.ssn }),
    outputMapper: (subOut) => ({ creditScore: subOut.score }),
  })
  .build();
```

### Attach multiple recorders

```typescript
import { ManifestFlowRecorder, MilestoneNarrativeFlowRecorder, MetricRecorder } from 'footprintjs';

// Scope recorder (data ops) — via executor.attachRecorder()
executor.attachRecorder(new MetricRecorder());

// Flow recorders (control flow) — via executor.attachFlowRecorder()
executor.attachFlowRecorder(new ManifestFlowRecorder());
executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder());

await executor.run({ input: data });

const manifest = executor.getSubflowManifest(); // subflow catalog
const milestones = executor.getFlowNarrative();  // key events only
```
