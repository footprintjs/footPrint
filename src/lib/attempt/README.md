# attempt/ — one runner, one record

A retry is a loop, and every pass of it is evidence. This folder owns the loop and the shape of that evidence: `runAttempts` (`runner.ts`) runs a function under a `RetryPolicy` and makes one frozen `AttemptRecord` per try — when it started, how long it took, how it ended, its failure category, and the retry-or-stop decision that followed — plus one `AttemptSummary` when the series ends. The engine's stage retry runs on it (`FlowchartTraverser · executeStage` hands it one attempt, the discard between attempts, the served error and where each record goes). Design: [docs/design/2026-10-time-and-failure-evidence.md](../../../docs/design/2026-10-time-and-failure-evidence.md).

| File | One job |
|---|---|
| `types.ts` | the vocabulary — `RetryPolicy`, `AttemptRecord`, `AttemptSummary`, `AttemptInputs`, the outcome / category / reason names. An L0 leaf: the frame's snapshot type names it |
| `runner.ts` | `runAttempts` — the loop; `resolveBackoffMs` — the backoff's defensive law |
| `policy.ts` | `attemptCeiling` — the one reading of `attempts` (gate, runner, rule table); `retryPolicyProblem` — the one validity rule (builder, and the run-time door for a returned StageNode) |
| `decision.ts` | `retryRules(policy)` — the one rule table, as `decide()` rules; `decideAttempt` — `decide()`'s evaluation without a scope |
| `category.ts` | `errorCategory(error, outcome?)` — the one classifier, seven fixed values |
| `errors.ts` | `AttemptTimeoutError`, `UnknownEffectError` |
| `anySignal.ts` | one signal that aborts when any input does, leak-free (not `AbortSignal.any`: browsers) |
| `correlation.ts` | the run's correlation — `parseTraceparent` / `formatTraceparent` (W3C, strict), `TraceparentError`, `admitRunEnv` / `resolveCorrelation`: the env's `traceparent` / `traceId` / `operationId` → ONE frozen `RunCorrelation` per leg (P4) |

**The laws.**

- *One runner, one record.* Every attempt the library runs is an `AttemptRecord` made here; no second loop exists in the engine. Records ride the execution tree (`StageSnapshot.attempts` / `attemptSummary`) and `FlowRecorder.onAttempt` — never the commit bundle, so every log stays byte-identical.
- *The decision is `decide()`'s.* `record.decision` is a `DecisionEvidence` from `retryRules(policy)`, first match wins: `ok → done` · `paused → stop` · `the run aborted (aborted = true) → stop` · `attempt ≥ of → stop (exhausted)` · `retryOn = false → stop (declined)` · `timeLeftAfterWaitMs ≤ 0 → stop (no-time-left)` · otherwise `retry (retryable)`. Each rule's label IS its reason. `decideAttempt` builds the rows `decide()` would (its filter rows ARE `decide/evaluator`'s); `test/lib/attempt/property` pins equal evidence for equal inputs.
- *Inputs are read when a rule reaches them, in the 9.15 order.* `retryOn` runs only for a failed, non-final attempt of a run that has not aborted; then the abort is checked again (an abort raised inside `retryOn` stops the series there); then the discard; then `backoffMs`, only when a retry follows; then the served error. `runner.test.ts` pins the three edges that order decides. A throwing `retryOn` is "declined"; a throwing or non-finite backoff is "no wait".
- *A record never rewrites what the attempt did.* An attempt that threw its own error is `failed`, with that error's category, even when the run aborted around it — the abort is the series' stop reason (`reason: 'aborted'`); only an attempt that threw the abort's own reason is `aborted`. A throwing `retryOn` stops `declined` with `retryOnThrew: true`, apart from a real `false`. And a summary is the SERIES' end, not the stage's: a stage can still fail after a `done` series (its commit, or the run-time door).
- *A record holds what it names.* The error as the run SERVES it (the redaction rule's form) without `raw`; names, numbers and the `retryOn` verdict in the evidence — never the error. Frozen to its leaves, `structuredClone`-safe.
- *One ceiling.* `attemptCeiling` (whole, ≥ 1 — `NaN`, `Infinity` and `0` read as `1`) is the gate's, the runner's and the rule table's; `retryPolicyProblem` refuses the same invalid policies at build and on a StageNode returned at run time.
- *A category is evidence, never policy.* The default `retryOn` retries every category; a chart that wants otherwise says so.
- *A traceparent is untrusted, and correlation only.* `parseTraceparent` reads exactly the W3C grammar (version `00` is 55 characters; a future version is read by its first four fields; `ff`, uppercase, a bad layout and all-zero ids are refused) and throws `TraceparentError` with a named `reason` — never the header, in the message or on the error. The env is read ONCE (`admitRunEnv`: one own-field snapshot; the stages' `$getEnv()` gets the canonical header), and the run keeps the canonical header of the EFFECTIVE ids, never the received bytes. Explicit `env.traceId` / `env.operationId` (1–256 printable ASCII; a `TypeError` by field otherwise — the caller's contract, while `TraceparentError` is the untrusted header's) win over the header's, and nothing of the header rides once the trace is not the header's; the flags byte is kept whole; a bad header refuses the run even beside explicit ids. The correlation is resolved once per leg, before anything moves, and lives on the leg's traverser and its composed scope factory — never on the chart, the checkpoint, the state or the log — so it cannot reach another run.
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
