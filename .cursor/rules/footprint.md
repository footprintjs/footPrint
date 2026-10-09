# footprint.js — Cursor Rules

This is the footprint.js library — the flowchart pattern for backend code. Self-explainable systems that AI can reason about.

## Core Principle

**Collect during traversal, never post-process.** All data collection happens as side effects of the single DFS traversal. Never walk the tree after execution.

## Architecture

```
src/lib/
├── memory/    → Engine state and policy (StageContext composes foottrace RecordFrame)
├── schema/    → Validation (Zod optional, duck-typed)
├── builder/   → Fluent DSL (FlowChartBuilder, flowChart())
├── scope/     → Per-stage facades + recorders + providers
├── reactive/  → TypedScope<T> deep Proxy (typed property access, $-methods)
├── decide/    → decide()/select() decision evidence capture
├── engine/    → DFS traversal + narrative + handlers
├── runner/    → FlowChartExecutor
└── contract/  → I/O schema + OpenAPI
```

FootPrint has six engine doors: `footprintjs` (main API) · `footprintjs/recorders` (recorder factories) · `footprintjs/trace` (engine recorders, stores and structure walkers) · `footprintjs/advanced` (engine internals) · `footprintjs/detach` (fire-and-forget children) · `footprintjs/zod` (opt-in zod bridge).

The separate record package has three doors: `foottrace` (record shapes, readers and runtime IDs), `foottrace/write` (`SharedMemory`, `EventLog`, `RecordFrame`) and `foottrace/paths` (record-path rules and safe nested access). Import directly from the owner: FootPrint does not re-export record declarations or keep local copies of record rules.

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
executor.enableNarrative();      // the narrative is OFF until enabled
await executor.run();
executor.getNarrativeEntries();  // CombinedNarrativeEntry[] — causal trace with decision evidence
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
executor.enableNarrative()         // before run() — the narrative is off by default
await executor.run({ input, env: { traceId: 'req-123' } });
executor.getNarrativeEntries()     // CombinedNarrativeEntry[] (type, text, depth, …) — not strings
executor.getNarrativeEntries().map((e) => e.text)  // plain lines
executor.getSnapshot()             // memory state
executor.attachScopeRecorder(recorder)  // scope observer
executor.attachFlowRecorder(r)     // flow observer
executor.setRedactionPolicy({ keys, patterns, fields })
```

## Observer Systems

- **Scope Recorder**: `onStageStart` → `onRead` / `onWrite` (DURING the stage) → `onStageEnd` → `onCommit`
- **FlowRecorder**: fires AFTER the commit (`onStageExecuted`, `onNext`, `onDecision`, `onFork`, `onLoop`); a decider's `onDecision` fires BEFORE its `onStageExecuted`
- 9 built-in FlowRecorder strategies
- Narrative via `executor.enableNarrative()`; one-shot form: `chart.recorder(narrative()).run()` on the built chart, read back with `trace.getEntries()`

## Rules

- Use `flowChart<T>()` — scopeFactory is auto-embedded
- Use `decide()` / `select()` in decider/selector functions
- Use typed property access (not getValue/setValue)
- Use `$getArgs()` for input, `$getEnv()` for environment
- Never post-process the tree — use recorders
- Use `executor.enableNarrative()` for narrative setup (it is off until called)
