# attempt/ — one runner, one record

A retry is a loop, and every pass of it is evidence. This folder owns the loop and the shape of that evidence: `runAttempts` (`runner.ts`) runs a function under a `RetryPolicy` and makes one frozen `AttemptRecord` per try — when it started, how long it took, how it ended, its failure category, and the retry-or-stop decision that followed — plus one `AttemptSummary` when the series ends. The engine's stage retry runs on it (`FlowchartTraverser · executeStage` hands it one attempt, the discard between attempts, the served error and where each record goes). Design: [docs/design/2026-10-time-and-failure-evidence.md](../../../docs/design/2026-10-time-and-failure-evidence.md).

| File | One job |
|---|---|
| `types.ts` | the vocabulary — `RetryPolicy`, `AttemptRecord`, `AttemptSummary`, `AttemptInputs`, the outcome / category / reason names. An L0 leaf: the frame's snapshot type names it |
| `runner.ts` | `runAttempts` — the loop; `resolveBackoffMs` — the backoff's defensive law |
| `decision.ts` | `retryRules(policy)` — the one rule table, as `decide()` rules; `decideAttempt` — `decide()`'s evaluation without a scope |
| `category.ts` | `errorCategory(error, outcome?)` — the one classifier, seven fixed values |
| `errors.ts` | `AttemptTimeoutError`, `UnknownEffectError` |
| `anySignal.ts` | one signal that aborts when any input does, leak-free (not `AbortSignal.any`: browsers) |

**The laws.**

- *One runner, one record.* Every attempt the library runs is an `AttemptRecord` made here; no second loop exists in the engine. Records ride the execution tree (`StageSnapshot.attempts` / `attemptSummary`) and `FlowRecorder.onAttempt` — never the commit bundle, so every log stays byte-identical.
- *The decision is `decide()`'s.* `record.decision` is a `DecisionEvidence` from `retryRules(policy)`, first match wins: `ok → done` · `paused → stop` · `aborted → stop` · `attempt ≥ of → stop (exhausted)` · `retryOn = false → stop (declined)` · `timeLeftAfterWaitMs ≤ 0 → stop (no-time-left)` · otherwise `retry (retryable)`. Each rule's label IS its reason. `decideAttempt` builds the rows `decide()` would (its filter rows ARE `decide/evaluator`'s); `test/lib/attempt/property` pins equal evidence for equal inputs.
- *Inputs are read when a rule reaches them.* `retryOn` runs only for a failed, non-final, non-aborted attempt; `backoffMs` only when a retry follows — exactly as before the record existed. A throwing `retryOn` is "declined"; a throwing or non-finite backoff is "no wait".
- *A record holds what it names.* The error as the run SERVES it (the redaction rule's form) without `raw`; names, numbers and the `retryOn` verdict in the evidence — never the error. Frozen to its leaves, `structuredClone`-safe.
- *A category is evidence, never policy.* The default `retryOn` retries every category; a chart that wants otherwise says so.
- *Time is the clock's.* `startedAt` / `durationMs` come from `options.now` (`Date.now`); a byte pin settles them.

```typescript
import { errorCategory, flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface Order { charged: boolean }
let calls = 0;
const charge = (scope: TypedScope<Order>) => {
  if (++calls === 1) throw Object.assign(new Error('gateway busy'), { status: 503 });
  scope.charged = true;
};

const chart = flowChart<Order>('Charge', charge, 'charge')
  .retry({ attempts: 3, retryOn: (error) => errorCategory(error) !== 'permanent' })
  .build();
const executor = new FlowChartExecutor(chart);
await executor.run();

const node = executor.getSnapshot().executionTree;
console.log(node.attempts?.map((a) => [a.attempt, a.outcome, a.category, a.next, a.reason]));
// [[1, 'failed', 'server', 'retry', 'retryable'], [2, 'ok', undefined, 'done', 'succeeded']]
console.log(node.attemptSummary?.last); // { next: 'done', reason: 'succeeded' }
```

Layers: `types.ts` is L0; the rest is L5, beside `decide/` — it imports `decide/`, `errors/`, `pause/types` and `capture/summarize`, nothing from `scope/` or `engine/`, so both reach it (`scripts/layering.config.cjs`).
