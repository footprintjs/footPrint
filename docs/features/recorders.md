# Recorders: Composable Observability for Pipelines and Agents

## What It Is

Recorders are pluggable observers that attach to a pipeline's scope and receive notifications about every read, write, commit, error, and stage lifecycle event. They follow the **Observer pattern** — attach one or more recorders, run the pipeline, then query each recorder for its specialized view of what happened.

Every recorder implements the same interface. All methods are optional — implement only the hooks you need. Multiple recorders can be attached simultaneously, each capturing a different facet of execution.

```typescript
interface Recorder {
  readonly id: string;
  onRead?(event: ReadEvent): void;       // A value was read from scope
  onWrite?(event: WriteEvent): void;      // A value was written to scope
  onCommit?(event: CommitEvent): void;    // Staged writes were committed
  onError?(event: ErrorEvent): void;      // An error occurred
  onStageStart?(event: StageEvent): void; // A stage began executing
  onStageEnd?(event: StageEvent): void;   // A stage finished executing
}
```

## Relatability

**Human:** A car's OBD-II diagnostic port. Multiple diagnostic tools can plug in simultaneously — one reads engine temperature, another tracks fuel consumption, a third logs error codes. Each tool sees the same engine events but extracts different insights. The car runs exactly the same whether zero tools or five are plugged in.

**LLM Bridge:** Recorders are the diagnostic port for pipelines. DebugRecorder tracks what happened (for debugging). MetricRecorder tracks how fast it happened (for production). NarrativeRecorder captures what data flowed (for LLM context). CostRecorder tracks what it cost (for budgets). All plugged in simultaneously, each producing its specialized report.

## Built-In Recorders

FootPrint ships three recorders. AgentFootPrints adds two more for LLM-specific observability.

### FootPrint Recorders (Pipeline-Level)

| Recorder | Purpose | Key Output |
|----------|---------|------------|
| **DebugRecorder** | Development debugging — verbose operation log | `getEntries()`, `getErrors()`, `getEntriesForStage()` |
| **MetricRecorder** | Production monitoring — timing and counts | `getMetrics()`, `getStageMetrics()` |
| **NarrativeRecorder** | LLM context enrichment — per-stage data narrative | `toSentences()`, `toFlatSentences()`, `getStageData()` |

### AgentFootPrints Recorders (LLM-Level)

| Recorder | Purpose | Key Output |
|----------|---------|------------|
| **LLMRecorder** | LLM call tracking — model, tokens, latency | `getEntries()`, `getAggregateStats()` |
| **CostRecorder** | Cost tracking — per-call and aggregate costs with budgets | `getAggregateCosts()`, `getTotalCost()`, `toSummary()` |

---

## DebugRecorder — Development Debugging

Captures verbose operation-level detail for debugging. Configurable verbosity: `minimal` (errors only) or `verbose` (all operations).

```typescript
import { DebugRecorder } from 'footprint/dist/scope/recorders';

const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
scope.attachRecorder(debugRecorder);

// After execution:
const entries = debugRecorder.getEntries();
// → [{ type: 'stageStart', stageName: 'CallLLM', timestamp: ..., data: {...} },
//    { type: 'read', stageName: 'CallLLM', timestamp: ..., data: { path: ['agent'], key: 'messages', ... } },
//    { type: 'write', stageName: 'CallLLM', timestamp: ..., data: { path: ['agent'], key: 'lastResponse', ... } },
//    { type: 'stageEnd', stageName: 'CallLLM', timestamp: ..., data: { duration: 1234 } }]

const errors = debugRecorder.getErrors();
// → Only entries where type === 'error'

const stageEntries = debugRecorder.getEntriesForStage('CallLLM');
// → Only entries for a specific stage

// Switch to production-like minimal mode
debugRecorder.setVerbosity('minimal');

// Reset for next run
debugRecorder.clear();
```

**When to use:** Development and staging. Turn on verbose during debugging, switch to minimal in production (errors-only).

---

## MetricRecorder — Production Monitoring

Captures timing and operation counts per stage. Designed for production dashboards and SLA monitoring.

```typescript
import { MetricRecorder } from 'footprint/dist/scope/recorders';

const metricRecorder = new MetricRecorder('prod-metrics');
scope.attachRecorder(metricRecorder);

// After execution:
const metrics = metricRecorder.getMetrics();
console.log(`Total reads: ${metrics.totalReads}`);
console.log(`Total writes: ${metrics.totalWrites}`);
console.log(`Total commits: ${metrics.totalCommits}`);
console.log(`Total duration: ${metrics.totalDuration}ms`);

// Per-stage breakdown
const callLLM = metricRecorder.getStageMetrics('CallLLM');
if (callLLM) {
  console.log(`CallLLM: ${callLLM.readCount} reads, ${callLLM.writeCount} writes`);
  console.log(`  Duration: ${callLLM.totalDuration}ms`);
  console.log(`  Invocations: ${callLLM.invocationCount}`);
}

// Reset for next run
metricRecorder.reset();
```

**When to use:** Production monitoring. Identify slow stages, track operation volume, enforce SLA thresholds.

---

## NarrativeRecorder — LLM Context Enrichment

Captures per-stage scope reads and writes with value summarization. Bridges the gap between flow-level narrative (NarrativeGenerator) and data-level detail.

```typescript
import { NarrativeRecorder } from 'footprint/dist/scope/recorders';

const narrativeRecorder = new NarrativeRecorder({ detail: 'full' });
scope.attachRecorder(narrativeRecorder);

// After execution:

// Structured data per stage
const stageData = narrativeRecorder.getStageData();
// → Map { 'CallLLM' => { reads: [...], writes: [...] } }

// Text sentences per stage (for merging with NarrativeGenerator)
const sentences = narrativeRecorder.toSentences();
// → Map {
//   'CallLLM' => [
//     '  - Read: agent.messages = (3 items)',
//     '  - Wrote: agent.lastResponse = {content, model, usage}'
//   ]
// }

// Flat sentences with stage prefix
const flat = narrativeRecorder.toFlatSentences();
// → ['CallLLM: Read: agent.messages = (3 items)',
//    'CallLLM: Wrote: agent.lastResponse = {content, model, usage}']

// Compact summary mode
narrativeRecorder.setDetail('summary');
narrativeRecorder.toSentences();
// → Map { 'CallLLM' => ['  - Read 1 value, wrote 1 value'] }

// Reset for next run
narrativeRecorder.clear();
```

### Value Summarization

NarrativeRecorder summarizes values to prevent token bloat when injected into LLM context:

| Value Type | Summary |
|-----------|---------|
| `undefined` | `undefined` |
| `null` | `null` |
| `"hello"` | `"hello"` |
| `"very long..."` | `"very long..." (truncated)` |
| `42` | `42` |
| `true` | `true` |
| `[1, 2, 3]` | `(3 items)` |
| `{ name: "John" }` | `{name}` |

**When to use:** Agent context engineering. Merge with NarrativeGenerator output so follow-up LLM calls have both flow AND data context. Eliminates re-calling tools for follow-up questions.

---

## LLMRecorder — LLM Call Tracking (AgentFootPrints)

Captures LLM-specific metadata: model name, token counts, latency, and streaming flag. Designed for agent operators who need visibility into LLM usage.

```typescript
import { LLMRecorder } from 'agent-footprint/dist/recorders/LLMRecorder';

const llmRecorder = new LLMRecorder('my-agent');
const build = AgentBuilder.agent('myAgent', { provider, toolRegistry })
  .withRecorder(llmRecorder)
  .build();

const executor = new AgentExecutor(build);
await executor.run('user message');

// Per-call entries
const entries = llmRecorder.getEntries();
// → [{ stageName: 'CallLLM', model: 'gpt-4o', inputTokens: 150, outputTokens: 75,
//       totalTokens: 225, latencyMs: 1234, streaming: false }]

// Aggregate statistics
const stats = llmRecorder.getAggregateStats();
console.log(`Total LLM calls: ${stats.totalCalls}`);
console.log(`Total tokens: ${stats.totalTokens}`);
console.log(`Avg latency: ${stats.averageLatencyMs}ms`);
console.log(`Streaming calls: ${stats.streamingCalls}`);
```

**When to use:** Agent observability. Track which models are being called, how many tokens each turn consumes, and whether latency meets SLAs.

---

## CostRecorder — Cost Tracking with Budgets (AgentFootPrints)

Calculates per-call and aggregate costs using configurable model pricing. Includes budget enforcement with alert callbacks.

```typescript
import { CostRecorder } from 'agent-footprint/dist/recorders/CostRecorder';

const costRecorder = new CostRecorder({
  budgetLimit: 1.00, // $1.00 per run
  onBudgetExceeded: (totalCost, limit, entry) => {
    console.warn(`Budget exceeded: $${totalCost.toFixed(4)} > $${limit}`);
    // Could trigger graceful shutdown, switch to cheaper model, etc.
  },
});

const build = AgentBuilder.agent('myAgent', { provider, toolRegistry })
  .withRecorder(costRecorder)
  .build();

const executor = new AgentExecutor(build);
await executor.run('user message');

// Per-call cost entries
const entries = costRecorder.getEntries();
// → [{ model: 'gpt-4o', inputTokens: 1000, outputTokens: 500,
//       inputCost: 0.0025, outputCost: 0.005, totalCost: 0.0075 }]

// Aggregate costs with breakdowns
const costs = costRecorder.getAggregateCosts();
console.log(`Total cost: $${costs.totalCost.toFixed(4)}`);
console.log(`Input cost: $${costs.totalInputCost.toFixed(4)}`);
console.log(`Output cost: $${costs.totalOutputCost.toFixed(4)}`);

// Per-model breakdown
for (const [model, data] of Object.entries(costs.costByModel)) {
  console.log(`  ${model}: $${data.cost.toFixed(4)} (${data.calls} calls)`);
}

// Per-stage breakdown
for (const [stage, data] of Object.entries(costs.costByStage)) {
  console.log(`  ${stage}: $${data.cost.toFixed(4)} (${data.calls} calls)`);
}

// Human-readable summary
console.log(costRecorder.toSummary());
// → "2 LLM calls | $0.0847 total | Models: gpt-4o ($0.0612), gpt-4o-mini ($0.0235)"
```

### Custom Pricing

Override default rates with your negotiated pricing:

```typescript
const costRecorder = new CostRecorder({
  pricing: {
    'gpt-4o': { inputPer1M: 2.00, outputPer1M: 8.00 },      // Override default
    'my-fine-tuned': { inputPer1M: 5.00, outputPer1M: 15.00 }, // Add custom model
  },
});

// Update pricing at runtime (e.g., when switching providers)
costRecorder.updatePricing({
  'gpt-4o': { inputPer1M: 1.50, outputPer1M: 6.00 }, // New negotiated rate
});
```

### Built-In Pricing

CostRecorder ships with default pricing for common models (USD per 1M tokens):

| Model | Input/1M | Output/1M |
|-------|----------|-----------|
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4-turbo | $10.00 | $30.00 |
| gpt-4 | $30.00 | $60.00 |
| gpt-3.5-turbo | $0.50 | $1.50 |
| claude-3-5-sonnet | $3.00 | $15.00 |
| claude-3-5-haiku | $0.80 | $4.00 |
| claude-3-opus | $15.00 | $75.00 |

Model matching uses prefix matching: `gpt-4o` matches `gpt-4o`, `gpt-4o-2024-08-06`, `gpt-4o-mini`, etc. Longer prefixes take precedence.

**When to use:** Cost monitoring, budget enforcement, chargeback reporting. Essential for production agent deployments where LLM costs need visibility and control.

---

## Creating Custom Recorders

Implement the `Recorder` interface to create domain-specific observers:

```typescript
import type { Recorder, ReadEvent, WriteEvent, CommitEvent, ErrorEvent, StageEvent }
  from 'footprint/dist/scope/types';

class ComplianceRecorder implements Recorder {
  readonly id = 'compliance-recorder';
  private auditLog: Array<{ timestamp: number; stageName: string; action: string; data: unknown }> = [];

  // Only implement the hooks you need
  onWrite(event: WriteEvent): void {
    if (event.path[0] === 'decision') {
      this.auditLog.push({
        timestamp: event.timestamp,
        stageName: event.stageName,
        action: `Wrote decision.${event.key}`,
        data: event.value,
      });
    }
  }

  onError(event: ErrorEvent): void {
    this.auditLog.push({
      timestamp: event.timestamp,
      stageName: event.stageName,
      action: `Error in ${event.operation}`,
      data: event.error.message,
    });
  }

  getAuditLog() {
    return [...this.auditLog];
  }
}
```

## Composing Multiple Recorders

Attach multiple recorders to get complementary views of the same execution:

```typescript
import { DebugRecorder, MetricRecorder, NarrativeRecorder } from 'footprint/dist/scope/recorders';
import { LLMRecorder, CostRecorder } from 'agent-footprint';

// Create recorders
const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
const metricRecorder = new MetricRecorder('prod');
const narrativeRecorder = new NarrativeRecorder({ detail: 'full' });
const llmRecorder = new LLMRecorder('agent');
const costRecorder = new CostRecorder({ budgetLimit: 5.00 });

// Attach all to the agent
const build = AgentBuilder.agent('myAgent', { provider, toolRegistry })
  .withRecorder(debugRecorder)
  .withRecorder(metricRecorder)
  .withRecorder(narrativeRecorder)
  .withRecorder(llmRecorder)
  .withRecorder(costRecorder)
  .build();

// After execution, each recorder has its specialized view:
// - debugRecorder: Full operation log for debugging
// - metricRecorder: Timing and counts for monitoring
// - narrativeRecorder: Data narrative for LLM context
// - llmRecorder: Model usage for operational metrics
// - costRecorder: Cost tracking for budgets
```

## The Power of Recorders for Operational Correctness

Recorders give teams the foundation to build:

| Capability | Recorders Used | What You Get |
|-----------|---------------|-------------|
| **Agent Observability** | LLMRecorder + MetricRecorder | Model usage, latency, throughput per stage |
| **Cost Monitoring** | CostRecorder | Per-call costs, budget alerts, model cost comparison |
| **Debug & Troubleshooting** | DebugRecorder | Full operation trace with errors, reads, writes |
| **LLM Context Engineering** | NarrativeRecorder | Data-enriched narrative for follow-up LLM calls |
| **Compliance & Audit** | Custom Recorder | Decision trails with timestamps and variable snapshots |
| **Performance Optimization** | MetricRecorder + LLMRecorder | Identify slow stages, expensive LLM calls |
| **Chargeback Reporting** | CostRecorder | Per-model, per-stage cost breakdown for billing |

## ROI

- **Debug time:** 2-4 hours saved per debugging session. Full operation trace eliminates console.log-driven debugging.
- **Token optimization:** Identify expensive stages via MetricRecorder + CostRecorder. Optimize the ones that matter.
- **Budget enforcement:** CostRecorder prevents runaway costs in production with configurable limits.
- **Cheap post-analysis:** A cheaper model reads the accumulated narrative trace instead of re-running with an expensive model.
- **Audit compliance:** Full decision trace with variables and timestamps. Required for financial and healthcare workflows.
- **Zero overhead:** Recorders only fire when attached. No recorder, no cost.
