# Attempt metrics and stored-trace navigation

`attempts()` is an opt-in recorder, collected during traversal. It reads `onAttempt`, explicit retry-loop
`onDecision` evidence, and run lifecycle events. It never walks the execution tree or counts narrative messages.

```ts
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { attempts, memoryStore } from 'footprintjs/recorders';

const rec = attempts({ exemplars: 10, maxRows: 10_000, store: memoryStore() });
const chart = flowChart('Read', async (scope) => {
  await scope.$call('inventory.read', () => true, { attempts: 2 });
}, 'read').build();
const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(rec);
await executor.run();
rec.byTarget();
rec.byRun();
rec.slowest('inventory.read', 5);
await rec.aggregate({ target: 'inventory.read' });
rec.toOTel();
```

A physical row contains attempt/run/runtime IDs, target, kind, timing, outcome, category, next/reason and optional
logical retry-loop/effect/correlation facts. It contains **no inputs, outputs, idempotency keys, error messages,
stacks, raw causes or arbitrary envelope fields**. External store rows pass the same named-field admission before
aggregation; malformed rows are omitted and counted. Plain own data descriptors are admitted before fields are read; row, nested-loop and array-index getters are refused without execution. Logical verdicts must match the exact physical attempt, target and loop identity. Returned views are detached projections.

`byTarget()` groups the target string; `byKind` and every exemplar's `attemptKind` distinguish stages, calls and
observed SDK work. Names can coincide, so a mixed target is not a provider-health verdict. The helper's outer
attempt stage completes its orchestration after recording an inner failure; its successful stage completion does
not establish that the provider applied the operation. The inner provider call keeps its unknown effect and the
explicit logical decision records what reconciliation established. Never infer payment confirmation from a
successful orchestration stage.

An explicit helper's physical call remains attempt 1 of 1 with its original outcome/next/reason. Its logical
retry/give-up counters come from recorded decider metadata. Reconciliation calls count their own latency and
outcome, without turning their one-call stop into another logical give-up. `series(physicalOrLogicalSeries, runId?)`
returns the linked physical attempts and explicit decisions, including provider-confirmed `applied`. Native compact
and observed operations use their own recorded next/reason. `gaveUp` uses the existing exhausted/declined/no-time-left
rule. These are recorded-operation counters, not counts of customer orders or refunds.

Latency percentiles use exact nearest rank over retained/query rows. `budgetUsedMs` is the **sum of attempt work
durations**, which can overlap or nest; it is not elapsed run time. `budgetMs` is absent because current lifecycle
events do not supply a trustworthy original budget. No total is fabricated from a final `timeLeftMs`.

`maxRows` defaults to 10,000 (maximum 100,000), and old local rows are evicted with `storage().omittedRows` and
`incomplete: true`. Exemplar arrays are capped at `exemplars` (default 10, from 1 to 100), worst duration first.
An `AttemptMetricRef` names the exact physical attempt ID, run and runtime stage. The older compact `AttemptRef` keeps its existing meaning on its original public door. Run summaries carry bounded physical exemplars too; zero exemplar capacity is refused. `toSnapshot()` exposes row limits, omission
and I/O accounting, plus the work-time definition. An unfinished or missing run lifecycle stays visibly running or
incomplete; a pause is recorded as paused. A fresh resume is its own run leg.

Stores implement `append(rows)` and `read({since?, until?, target?, runId?})`, with optional synchronous `stats(): {omittedRows}` for known retention losses. Append starts as each hook lands,
with no batch deferred until run end. Hooks cannot await: `maxPending` (default 8, maximum 64) caps owned I/O, rejects
are handled immediately, and a full pool drops additional writes with explicit accounting rather than queuing
without bound. `flush()` waits at most `storeTimeoutMs` (default 1 second); it reports pending/failed/dropped state.
A timeout cannot kill an adapter's I/O; it keeps its pool slot until it really settles. Reads use the same pool and
bounded waiting. `aggregate()` first flushes, reads the adapter's query window and admits at most `maxRows`; it
discloses omissions, any known adapter retention losses and incomplete local storage evidence. It cannot certify losses that an external adapter
silently hides. Configure backend retention/query limits and inspect the adapter's own accounting.

`memoryStore({maxRows})` is the bounded reference adapter; `stats()` reports its retained/omitted row counts.
`clear()` clears completed local projections, preserving active/paused evidence and bounded lifecycle/decision/I/O ownership without deleting durable rows. Executor auto-clear may run while a different executor shares this recorder; exact native lifecycle identities and already-emitted active attempts survive, without guessing which run is active. Completed projections reset normally; prior omissions remain visible while active ownership exists.
No store, cloud SDK, background process or network request is enabled by default.

`toOTel()` emits OTLP JSON histogram/sum metrics with explicit buckets and physical exemplar attributes. It does not
send them anywhere. Only nonzero, 32-character lowercase hexadecimal trace IDs fill OTLP's typed trace ID field;
opaque application correlation IDs never masquerade as W3C trace IDs. Exemplar run/runtime/attempt IDs remain
navigable even without a typed trace ID. Quantiles stay in the local statistics, not in histogram buckets.

The executable public example [07-attempt-metrics-and-trace.ts](../../examples/runtime-features/retry/07-attempt-metrics-and-trace.ts)
walks `slowest()` → `runId/runtimeStageId` → `readStoredRecord(...).root(runId)` → bounded `causalChain` and
`stateAt(stored.source(), commitIndex)`. It checks completeness/gaps first. State is the stage's committed stop,
not an imaginary snapshot halfway through a call; causal dependencies require a real read lookup, which the
example honestly leaves empty rather than inventing evidence. No model or provider call is needed.

Parallel siblings may each report a pause. They update one leg idempotently; a waiting sibling re-raised on resume
carries the actual new leg's root context, while its checkpoint keeps the original paused execution link. Shared
recorders never guess a missing run ID from the most recently active run, and a later terminal failure supersedes
an earlier child pause. Pause payloads do not enter metric rows.
