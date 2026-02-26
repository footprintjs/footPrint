# Observability: Enriched Snapshots and the 3-Layer Recorder Model

## What It Is

FootPrint provides a 3-layer observability model that captures progressively richer execution data, from automatic scope logging to custom recorder context to full accumulated traces.

## The 3-Layer Recorder Model

### Layer 1 — Inbuilt Scope Logging (Automatic, Zero Config)

Every `scope.getValue()` and `scope.setObject()` call is automatically recorded. You get a full read/write trace for every stage without writing any code. This is the baseline — always on.

### Layer 2 — Custom Recorders (Opt-In Structured Detail)

At decision/selector/decider nodes, developers attach recorders that capture **WHY** a particular path was chosen. Not just "took branch A" but "took branch A because `creditScore=580` was below threshold `650`."

FootPrint ships three built-in recorders:
- **DebugRecorder** — Verbose development logging (reads, writes, errors, stage lifecycle)
- **MetricRecorder** — Production timing and counts (reads/writes/commits per stage, duration)
- **NarrativeRecorder** — Per-stage scope data for narrative enrichment (reads and writes with value summaries)

AgentFootPrints adds:
- **LLMRecorder** — LLM-specific metadata (model, tokens, latency, streaming flag)

### Layer 3 — Accumulation (Stage -> Subflow -> FlowChart)

Individual stage recordings roll up into subflow summaries, which roll up into the full flowchart trace. Available as raw JSON (for programmatic analysis) or narrated text (for LLM context injection).

## Relatability

**Human:** Hospital vital-sign monitors. Every bed sends readings to a central dashboard. Doctors diagnose without walking room-to-room. But the best hospitals also log WHY the nurse administered a particular medication (the decision rationale), and previous vitals show HOW the patient's condition changed over time.

**LLM Bridge:** Layer 1 = vital signs (automatic reads/writes). Layer 2 = nurse's notes (WHY this treatment). Layer 3 = patient history rollup. A cheaper model reads the full chart to diagnose without re-examining the patient.

## How to Use

### TraversalExtractor (`addTraversalExtractor`)

The extractor receives a callback per stage during traversal, allowing custom data capture:

```typescript
const chart = flowChart('start', startFn)
  .addFunction('process', processFn)
  .addTraversalExtractor((stagePath, stageContext) => {
    return {
      stageName: stageContext.stageName,
      customData: stageContext.debug?.logContext,
    };
  })
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run();

const extracted = executor.getExtractedResults();
// → Map { 'start' => { stageName: 'start', ... }, 'process' => { ... } }
```

### Enriched Snapshots

When enabled, each stage snapshot includes scope state, debug info, stage output, error info, and history index:

```typescript
const executor = new FlowChartExecutor(chart, scopeFactory,
  undefined, undefined, undefined, undefined, undefined, undefined,
  true // enrichSnapshots
);
await executor.run();

const enriched = executor.getEnrichedResults();
// → Map { 'stagePath' => { scopeState: {...}, debugInfo: {...}, stageOutput: ..., historyIndex: 5 } }
```

### Using Recorders

#### DebugRecorder — Development Debugging

```typescript
import { DebugRecorder } from 'footprint/dist/scope/recorders';

const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
scope.attachRecorder(debugRecorder);

// After execution:
const entries = debugRecorder.getEntries();
const errors = debugRecorder.getErrors();
const stageEntries = debugRecorder.getEntriesForStage('processData');
```

#### MetricRecorder — Production Monitoring

```typescript
import { MetricRecorder } from 'footprint/dist/scope/recorders';

const metricRecorder = new MetricRecorder('prod-metrics');
scope.attachRecorder(metricRecorder);

// After execution:
const metrics = metricRecorder.getMetrics();
console.log(`Total reads: ${metrics.totalReads}`);
console.log(`Total writes: ${metrics.totalWrites}`);
console.log(`Total duration: ${metrics.totalDuration}ms`);

const stageMetrics = metricRecorder.getStageMetrics('CallLLM');
console.log(`CallLLM reads: ${stageMetrics?.readCount}`);
```

#### NarrativeRecorder — Narrative Enrichment

```typescript
import { NarrativeRecorder } from 'footprint/dist/scope/recorders';

const narrativeRecorder = new NarrativeRecorder({ detail: 'full' });
scope.attachRecorder(narrativeRecorder);

// After execution:
const stageData = narrativeRecorder.getStageData();
// → Map { 'CallLLM' => { reads: [...], writes: [...] } }

const sentences = narrativeRecorder.toSentences();
// → Map { 'CallLLM' => ['  - Read: agent.messages = (3 items)', '  - Wrote: agent.lastResponse = {content, model}'] }
```

#### LLMRecorder — LLM Call Tracking (AgentFootPrints)

```typescript
import { LLMRecorder } from 'agent-footprint/dist/recorders/LLMRecorder';

const llmRecorder = new LLMRecorder('my-agent');
const build = AgentBuilder.agent('myAgent', { provider, toolRegistry })
  .withRecorder(llmRecorder)
  .build();

const executor = new AgentExecutor(build);
await executor.run('user message');

const stats = llmRecorder.getAggregateStats();
console.log(`Total LLM calls: ${stats.totalCalls}`);
console.log(`Total tokens: ${stats.totalTokens}`);
console.log(`Avg latency: ${stats.averageLatencyMs}ms`);
```

### Creating Custom Recorders

Implement the `Recorder` interface to create domain-specific observers:

```typescript
import type { Recorder, ReadEvent, WriteEvent, CommitEvent, ErrorEvent, StageEvent } from 'footprint/dist/scope/types';

class MyCustomRecorder implements Recorder {
  readonly id = 'my-recorder';

  onRead?(event: ReadEvent): void { /* observe reads */ }
  onWrite?(event: WriteEvent): void { /* observe writes */ }
  onCommit?(event: CommitEvent): void { /* observe commits */ }
  onError?(event: ErrorEvent): void { /* observe errors */ }
  onStageStart?(event: StageEvent): void { /* observe stage start */ }
  onStageEnd?(event: StageEvent): void { /* observe stage end */ }
}
```

All methods are optional. Implement only the hooks you need.

## Concrete Example: Loan Approval Pipeline

```
Pipeline: CreditCheck -> RiskAssessment (decider) -> Approval/Rejection
```

**Layer 1 (inbuilt):** CreditCheck stage reads `applicant.ssn`, writes `creditScore=580`

**Layer 2 (NarrativeRecorder at RiskAssessment):**
```
  - Read: applicant.creditScore = 580
  - Wrote: decision.result = "reject"
  - Wrote: decision.reason = "creditScore below threshold"
```

**Layer 3 (accumulated trace):**
```
CreditCheck: Read applicant.ssn, wrote creditScore=580
RiskAssessment: DECISION reject (creditScore 580 < threshold 650)
Result: Application denied — insufficient credit score
```

**LLM consumption:** Feed accumulated trace to a cheaper model. User asks "Why was my loan denied?" The model answers from the trace without re-running the pipeline.

## Build-time vs Runtime Distinction

- **Build-time (stage descriptions):** LLM knows possible paths. "RiskAssessment can go to Approve or Reject based on credit score."
- **Runtime (recorders):** LLM knows which path was taken and why. "RiskAssessment went to Reject because creditScore=580 < 650."

Both are needed. Build-time tells the LLM WHAT tools do. Runtime tells the LLM WHAT happened.

## ROI

- **Debug time:** 2-4 hours saved per debugging session. No more console.log-driven debugging.
- **Token optimization:** Identify expensive stages via MetricRecorder. Optimize the ones that matter.
- **Cheap post-analysis:** A cheaper model reads the accumulated trace instead of re-running with an expensive model.
- **Customer support automation:** Trace-based answers eliminate re-running workflows for follow-up questions.
- **Audit compliance:** Full decision trace with variables. Regulatory requirement for financial and healthcare workflows.
