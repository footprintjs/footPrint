# footprint.js — Agent Instructions

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection happens as side effects of the single DFS traversal. Never walk the tree after execution.

## Architecture

```
src/lib/
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer)
├── schema/    → Validation (Zod optional, duck-typed)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart())
├── scope/     → Per-stage facades + recorders + providers
├── reactive/  → TypedScope<T> deep Proxy (typed property access, $-methods)
├── decide/    → decide()/select() decision evidence capture
├── recorder/  → CompositeRecorder, KeyedRecorder<T> base class
├── engine/    → DFS traversal + narrative + handlers
├── runner/    → FlowChartExecutor
└── contract/  → I/O schema + OpenAPI
```

Entry points: `footprintjs` (public), `footprintjs/trace` (execution tracing), `footprintjs/advanced` (internals).

## Key API — TypedScope (Recommended)

```typescript
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface State {
  creditScore: number;
  riskTier: string;
  decision?: string;
}

const chart = flowChart<State>('Intake', async (scope) => {
  scope.creditScore = 750;          // typed write (no setValue needed)
  scope.riskTier = 'low';           // typed write
}, 'intake')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { riskTier: { eq: 'low' } }, then: 'approved', label: 'Low risk' },
    ], 'rejected');
  }, 'route', 'Route based on risk')
    .addFunctionBranch('approved', 'Approve', async (scope) => {
      scope.decision = 'Approved';
    })
    .addFunctionBranch('rejected', 'Reject', async (scope) => {
      scope.decision = 'Rejected';
    })
    .setDefault('rejected')
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
await executor.run();
executor.getNarrative();  // causal trace with decision evidence
```

### TypedScope $-methods (escape hatches)

```typescript
scope.$getArgs<T>()        // frozen readonly input
scope.$getEnv()            // execution environment (signal, timeoutMs, traceId)
scope.$break()             // stop pipeline
scope.$debug(key, value)   // debug info
scope.$metric(name, value) // metrics
```

### decide() / select()

```typescript
// Filter syntax — captures operators + thresholds
decide(scope, [
  { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approved', label: 'Good credit' },
], 'rejected');

// Function syntax — captures which keys were read
decide(scope, [
  { when: (s) => s.creditScore > 700, then: 'approved' },
], 'rejected');

// select() — all matching branches (not first-match)
select(scope, [
  { when: { glucose: { gt: 100 } }, then: 'diabetes' },
  { when: { bmi: { gt: 30 } }, then: 'obesity' },
]);
```

### Executor

```typescript
const executor = new FlowChartExecutor(chart);
await executor.run({ input, env: { traceId: 'req-123' } });
executor.getNarrative()            // string[]
executor.getNarrativeEntries()     // CombinedNarrativeEntry[]
executor.getSnapshot()             // memory state
executor.attachRecorder(recorder)  // scope observer
executor.attachFlowRecorder(r)     // flow observer
executor.setRedactionPolicy({ keys, patterns, fields })
```

## Observer Systems

- **Scope Recorder**: fires DURING stage (`onRead`, `onWrite`, `onCommit`)
- **FlowRecorder**: fires AFTER stage (`onStageExecuted`, `onDecision`, `onFork`, `onLoop`)
- 8 built-in FlowRecorder strategies
- Narrative via `executor.recorder(narrative())` at runtime

## Execution Tracing (`footprintjs/trace`)

Every stage gets a unique `runtimeStageId`: `[subflowPath/]stageId#executionIndex` (e.g., `call-llm#5`, `sf-tools/execute-tool-calls#8`)

Use for: debugging (which stage wrote what?), backtracking (who changed a value?), custom recorder storage.

```typescript
import { parseRuntimeStageId, findLastWriter, findCommit, KeyedRecorder } from 'footprintjs/trace';

// commitLog from executor.getSnapshot().commitLog (CommitBundle[])
// findCommit(commitLog, stageId, key?) → CommitBundle | undefined
// findLastWriter(commitLog, key, beforeIdx?) → CommitBundle | undefined — search backwards
// KeyedRecorder<T> — abstract base: store(runtimeStageId, entry), getByKey(), getMap(), values()
```

## Rules

- Use `flowChart<T>()` — scopeFactory is auto-embedded
- Use `decide()` / `select()` in decider/selector functions
- Use typed property access (not getValue/setValue)
- Use `$getArgs()` for input, `$getEnv()` for environment
- Never post-process the tree — use recorders
- Use `.recorder(narrative())` at runtime for narrative setup
