# footprint.js — Cursor Rules

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection happens as side effects of the single DFS traversal. Never walk the tree after execution.

## Architecture

```
src/lib/
├── memory/    → Transactional state (SharedMemory, StageContext, TransactionBuffer)
├── schema/    → Validation (Zod optional, duck-typed)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart(), typedFlowChart())
├── scope/     → Per-stage facades + recorders + providers
├── reactive/  → TypedScope<T> deep Proxy (typed property access, $-methods)
├── decide/    → decide()/select() decision evidence capture
├── engine/    → DFS traversal + narrative + handlers
├── runner/    → FlowChartExecutor
└── contract/  → I/O schema + OpenAPI
```

Entry points: `footprintjs` (public) and `footprintjs/advanced` (internals).

## Key API — TypedScope (Recommended)

```typescript
import { typedFlowChart, FlowChartExecutor, decide } from 'footprintjs';

interface State {
  creditScore: number;
  riskTier: string;
  decision?: string;
}

const chart = typedFlowChart<State>('Intake', async (scope) => {
  scope.creditScore = 750;          // typed write (no setValue needed)
  scope.riskTier = 'low';           // typed write
}, 'intake')
  .setEnableNarrative()
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

const executor = new FlowChartExecutor(chart<State>());
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
const executor = new FlowChartExecutor(chart<State>());
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
- `setEnableNarrative()` auto-attaches `CombinedNarrativeRecorder`

## Rules

- Use `typedFlowChart<T>()` — scopeFactory is auto-embedded, no `createTypedScopeFactory` needed
- Use `decide()` / `select()` in decider/selector functions
- Use typed property access (not getValue/setValue)
- Use `$getArgs()` for input, `$getEnv()` for environment
- Never post-process the tree — use recorders
- `setEnableNarrative()` is all you need for narrative setup
