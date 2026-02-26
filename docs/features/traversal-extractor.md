# Traversal Extractor: Per-Stage Data Capture During Execution

## What It Is

`addTraversalExtractor` lets you attach a callback that fires once per stage during pipeline traversal. Each callback receives a `StageSnapshot` — a rich object containing the stage node, execution context, step number, and structural metadata. When enriched snapshots are enabled, it also includes scope state, debug info, stage output, error info, and history index.

Think of it as placing a sensor on every stage in your pipeline. As execution flows through, each sensor fires and hands you everything that happened at that point.

## Relatability

**Human:** A factory quality-control inspector stationed at every assembly point. They don't change the product — they observe, record measurements, and flag anomalies. The product keeps moving down the line. At the end, the factory has a complete quality report for every step.

**LLM Bridge:** The extractor is the inspector. Each stage snapshot is a measurement. The pipeline keeps executing normally. After execution, you have a per-stage map of captured data — scope state, debug logs, stage output — that a cheap model can analyze for debugging, auditing, or follow-up answers without re-running the pipeline.

## How to Use

### Basic Extractor

```typescript
const chart = flowChart('start', startFn)
  .addFunction('process', processFn)
  .addTraversalExtractor((snapshot) => {
    return {
      stageName: snapshot.node.name,
      stepNumber: snapshot.stepNumber,
      logContext: snapshot.context.debug?.logContext,
    };
  })
  .build();

const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run();

const extracted = executor.getExtractedResults();
// → Map { 'start' => { stageName: 'start', stepNumber: 1, ... },
//         'process' => { stageName: 'process', stepNumber: 2, ... } }
```

### Enriched Snapshots (Full State Capture)

When enriched snapshots are enabled, each `StageSnapshot` includes the complete scope state, debug info, stage output, and execution history position:

```typescript
const executor = new FlowChartExecutor(chart, scopeFactory,
  undefined, undefined, undefined, undefined, undefined, undefined,
  true // enrichSnapshots
);
await executor.run();

const enriched = executor.getEnrichedResults();
// → Map {
//   'start' => {
//     scopeState: { agent: { messages: [...] }, user: { name: 'Jane' } },
//     debugInfo: { logs: {...}, errors: {...}, metrics: {...} },
//     stageOutput: { toolCalls: [...] },
//     historyIndex: 2,
//   },
//   'process' => { ... },
// }
```

### StageSnapshot Structure

```typescript
interface StageSnapshot {
  node: StageNode;              // The stage being executed
  context: StageContext;        // Execution context (debug logs, stage ID, branch path)
  stepNumber: number;           // 1-based execution step counter
  structureMetadata: {          // Runtime structural context
    type: string;               // 'stage' | 'decider' | 'fork' | 'selector' | 'subflow'
    isSubflowRoot?: boolean;
    subflowId?: string;
    isParallelChild?: boolean;  // True when executing inside a fork
    parallelGroupId?: string;   // Identifies which fork group
    isDynamic?: boolean;        // True for dynamically created children (e.g., tool nodes)
  };

  // Enriched fields (only when enrichSnapshots=true):
  scopeState?: Record<string, unknown>;   // Complete scope state at this point
  debugInfo?: { logs, errors, metrics };   // Debug context accumulated so far
  stageOutput?: unknown;                   // What the stage function returned
  errorInfo?: { type, message };           // Error details if the stage threw
  historyIndex?: number;                   // Position in execution history
}
```

### Use Cases

**Debugging:** Capture scope state at each stage to see how data flows through the pipeline. Identify which stage corrupted a value without adding console.log statements.

**Auditing:** Record decision rationale at every decider/selector for compliance. The extractor captures the full context — what was read, what was decided, what the scope looked like at that moment.

**Cost Analysis:** Extract stage output from LLM calls to analyze token usage and response quality per stage. Pair with CostRecorder for full financial visibility.

**Custom Dashboards:** Build stage-by-stage execution reports by extracting the data you care about. The callback returns custom-shaped data, so you control exactly what gets captured.

### Extractors and Recorders: Complementary, Not Competing

| | Extractor | Recorder |
|---|---|---|
| **Level** | Pipeline (per-stage callback) | Scope (per-operation hook) |
| **Fires when** | Each stage completes | Each read/write/commit/error |
| **Data shape** | Custom (you define the return type) | Fixed events (ReadEvent, WriteEvent, etc.) |
| **Access to** | StageSnapshot (node, context, scope state, output) | Individual scope operations (path, key, value) |
| **Best for** | Stage-level summaries, custom reports, enriched snapshots | Operation-level tracking, cross-cutting metrics, narrative enrichment |

**Use together:** An extractor captures the high-level story (what happened at each stage). Recorders capture the low-level detail (every individual read/write). Combined, you get both the forest and the trees.

## ROI

- **Debug time:** Jump directly to the problematic stage with its full context. Save 2-4 hours per debugging session.
- **Compliance:** Complete execution audit trail per stage — required for financial and healthcare workflows.
- **Custom tooling:** Build stage-by-stage dashboards, execution replayers, or cost analyzers using extractor data.
- **Zero overhead when disabled:** Extractors only fire when attached. No callback, no cost.
