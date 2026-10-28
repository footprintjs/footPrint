# attempt/ — one runner, one record

A retry is a loop, and every pass of it is evidence. This folder owns the loop and the shape of that evidence: `runAttempts` (`runner.ts`) runs a function under a `RetryPolicy` and makes one frozen `AttemptRecord` per try — when it started, how long it took, how it ended, its failure category, and the retry-or-stop decision that followed — plus one `AttemptSummary` when the series ends. The engine's stage retry runs on it (`FlowchartTraverser · executeStage` hands it one attempt, the discard between attempts, the served error and where each record goes), and so does every call a stage makes through `scope.$call` and the standalone `attempt()` (P2). Design: [docs/design/2026-10-time-and-failure-evidence.md](../../../docs/design/2026-10-time-and-failure-evidence.md).

| File | One job |
|---|---|
| `types.ts` | the vocabulary — `RetryPolicy`, `AttemptRecord`, `AttemptSummary`, `AttemptInputs`, the outcome / category / reason names. An L0 leaf: the frame's snapshot type names it |
| `runner.ts` | `runAttempts` — the loop; `resolveBackoffMs` — the backoff's defensive law |
| `policy.ts` | `attemptCeiling` — the one reading of `attempts` (gate, runner, rule table); `retryPolicyProblem` — the one validity rule (builder, and the run-time door for a returned StageNode); `backoffCeilingMs` / `cappedWaitMs` — the one reading of `maxBackoffMs` (the runner's cap, the budget check's bound) |
| `backoff.ts` | `exponentialBackoff` / `statedWaitFirst` — deterministic builders of the function `RetryPolicy.backoffMs` takes: an exponential ceiling, `'none'` / `'equal'` / `'full'` jitter from an injectable `random`, a stated wait first. The cap stays the policy's `maxBackoffMs` |
| `decision.ts` | `retryRules(policy)` — the one rule table, as `decide()` rules; `decideAttempt` — `decide()`'s evaluation without a scope |
| `category.ts` | `errorCategory(error, outcome?)` — the one classifier, seven fixed values |
| `errors.ts` | `AttemptTimeoutError`, `UnknownEffectError` |
| `effect.ts` | side-effect safety (P3): `touchesProblem` — the one law for a touching target (builder, run-time door, stage, runner); `callTouches` — the same for `$call`; `admitIdempotencyKey` — the key's format; `effectOf` — what an attempt did (`applied` / `none` / `unknown`); `unknownEffectError` — what a series ended without an answer after any unknown attempt fails with |
| `anySignal.ts` | one signal that aborts when any input does, leak-free (not `AbortSignal.any`: browsers) |
| `correlation.ts` | the run's correlation — `parseTraceparent` / `formatTraceparent` (W3C, strict), `TraceparentError`, `admitRunEnv` / `resolveCorrelation`: the env's `traceparent` / `traceId` / `operationId` → ONE frozen `RunCorrelation` per leg (P4) |
| `deadline.ts` | what the run's deadline IS to every reader of time: `deadlineReason` (the branded abort reason), `markTimeLimit` (an attempt's cap, the deadline of the calls inside it), `isCancelled` (aborted, but not by a time limit), `readDeadline`, `armDeadline` (a signal that aborts at a deadline) |
| `longTimeout.ts` | `setLongTimeout` — the ONE long-timer law: `Infinity` arms no timer; a delay past 2^31 − 1 ms is waited in chunks, never cut to 1 ms; anything not > 0 is due at once; `{ unref }` for a timer that only bounds a wait. An L0 leaf, so every caller-supplied wait in `src/` is armed with it — the runner's caps, waits and deadline, the observer queue's `drain`, `flushAllDetached`, `flushRecord`, the file sink, the indexed reader, the `attempts()` recorder, the `setTimeout` detach driver. `test/architecture/timer-law.test.ts` refuses a raw `setTimeout` / `setInterval` anywhere else in `src/` unless its delay is a literal a host timer holds or a constant on the test's named allow-list |
| `record.ts` | how a record holds what it holds: `freezeDeep`, `recordedError` (a served error's named fields, never `raw`) — shared by the runner and the observed builder |
| `name.ts` | the ONE name rule (P2): a target, a series, an observed source — 1–128 characters, not blank, no control, format, surrogate, line-separator, private-use or noncharacter code point; refused with a `TypeError` that names the field, never the value |
| `call.ts` | `runCall` — a call made inside a stage attempt (`scope.$call`, kind `'call'`) on the runner, under that attempt's signal and end; `callSeries` — `<runtimeStageId>@<n>.<k>`, the call level of foottrace's attempt-id grammar (P2) |
| `observed.ts` | an attempt an outside system ran on its own (`observed()`, kind `'observed'`): `readObservedReport` (named fields only, each read once), `observedRecord`, `ObservedSeriesBook` (P2) |
| `standalone.ts` | `attempt(fn, policy?, options?)` — the runner with no scope and no run; records go to `options.onAttempt` only (P2) |

**The laws.**

- *No blind retry of an outside effect (P3).* A target that touches a system (`.touches(system, { idempotencyKey })`, `$call(…, { touches, idempotencyKey })`) and may retry must carry a key — refused at build, at the run-time door, at the stage and in the runner. The key is computed once per execution and handed to every attempt; records carry it as the run serves it (the diagnostic entry `{ idempotencyKey }`). Every record says what its attempt did (`effect`), and a series that ends without an answer after any attempt of `unknown` effect fails with `UnknownEffectError` (its `cause` the attempt's own error) — never the attempt's error, which would read as "failed, try again". A pause stays a pause.

  ```typescript
  import { flowChart } from 'footprintjs';

  flowChart('Charge', async () => undefined, 'charge')
    .touches('payments', { idempotencyKey: ({ args }) => `order-${(args as { orderId: string }).orderId}` })
    .retry({ attempts: 3, timeoutMs: 20_000 })
    .build();
  ```

- *Every call is an attempt record (P2).* `scope.$call(target, fn, policy?)` runs `fn` on this runner (none = `{ attempts: 1 }` — a single call still leaves ONE record) and puts every attempt, kind `'call'`, on the stage's `attempts` and `onAttempt` with the stage's traversal context (so the run's correlation rides the event). Its series is `<runtimeStageId>@<stage attempt>.<k>` (`callSeries`, written here until the engine adopts foottrace 1.1.0's codec), so `<series>@<attempt>` is the call attempt's id. A stage keeps its first 1000 call/observed records and counts the rest (`StageSnapshot.attemptsDropped`).
- *A call lives within the attempt that made it (P2).* Its signal is the stage attempt's; its deadline is that attempt's end (`attemptEndsAt`: start + cap, never past the run's deadline). An attempt's cap is branded a time limit (`markTimeLimit`), so a call it cuts is `timeout`, not `aborted`; a reached time limit leaves no time whatever the clock says. The host's signal is the call's ONE deadline source (a second timer for the same instant could fire first and fail the stage instead of timing it out). A call also runs under `StageContext · callsEndedSignal`, aborted when its attempt is over however it ended and at commit: no call outlives the attempt that made it — an orphan's in-flight attempt is cut, its wait ends, it leaves no listener, and its library-made rejection is never an unhandled one. The record of a call attempt cut BY the stage attempt's own abort lands (the cut is evidence); any other record arriving after that attempt is over is refused (`lateWrites`, `call:<target>`, channel `'attempt'`), and no further attempt of the call starts. A call never starts under an aborted signal, nor past its deadline while that signal is still due (a busy event loop fires timers late): nothing is sent. An `interrupt()` inside a call is a pause — never retried. A synchronous `fn` with no backoff runs its whole series without yielding: give a call an async function or a backoff.
- *What an SDK ran on its own is observed, not decided (P2).* `AttemptContext.observed(report)` reads only the named fields, each once; serves the error under the run's rule; and records kind `'observed'` under the stage attempt's call level (a report through a `$call` is that call's sibling — the grammar has one call level). Its decision is the one rule table read over the report under the default policy — the library's reading, never the SDK's decision — and a report without `of` stands for the SDK's whole call. It never changes control flow — in either direction: a report after its attempt ended (an SDK callback firing late) is dropped and recorded by name (`lateWrites`, `observed:<target>`), never thrown into the SDK. No hook is handed the adapter's error object (`raw` is dropped — the library never threw it, and an SDK error can carry its request).

- *One runner, one record.* Every attempt the library runs is an `AttemptRecord` made here; no second loop exists in the engine. Records ride the execution tree (`StageSnapshot.attempts` / `attemptSummary`) and `FlowRecorder.onAttempt` — never the commit bundle, so every log stays byte-identical.
- *The decision is `decide()`'s.* `record.decision` is a `DecisionEvidence` from `retryRules(policy)`, first match wins: `ok → done` · `paused → stop` · `the run aborted (aborted = true) → stop` · `attempt ≥ of → stop (exhausted)` · `retryOn = false → stop (declined)` · `timeLeftAfterWaitMs ≤ 0 → stop (no-time-left)` · otherwise `retry (retryable)`. Each rule's label IS its reason. `decideAttempt` builds the rows `decide()` would (its filter rows ARE `filter/evaluator`'s); `test/lib/attempt/property` pins equal evidence for equal inputs.
- *Inputs are read when a rule reaches them, in the 9.15 order.* `retryOn` runs only for a failed, non-final attempt of a run that has not aborted; then the abort is checked again (an abort raised inside `retryOn` stops the series there); then the discard; then `backoffMs`, only when a retry follows; then the served error. `runner.test.ts` pins the three edges that order decides. A throwing `retryOn` is "declined"; a throwing or non-finite backoff is "no wait".
- *A record never rewrites what the attempt did.* An attempt that threw its own error is `failed`, with that error's category, even when the run aborted around it — the abort is the series' stop reason (`reason: 'aborted'`); only an attempt that threw the abort's own reason is `aborted`. A throwing `retryOn` stops `declined` with `retryOnThrew: true`, apart from a real `false`. And a summary is the SERIES' end, not the stage's: a stage can still fail after a `done` series (its commit, or the run-time door).
- *A record holds what it names.* The error as the run SERVES it (the redaction rule's form) without `raw`; names, numbers and the `retryOn` verdict in the evidence — never the error. Frozen to its leaves, `structuredClone`-safe.
- *One ceiling.* `attemptCeiling` (whole, ≥ 1 — `NaN`, `Infinity` and `0` read as `1`) is the gate's, the runner's and the rule table's; `retryPolicyProblem` refuses the same invalid policies at build and on a StageNode returned at run time.
- *A category is evidence, never policy.* The default `retryOn` retries every category; a chart that wants otherwise says so.
- *A traceparent is untrusted, and correlation only.* `parseTraceparent` reads exactly the W3C grammar (version `00` is 55 characters; a future version is read by its first four fields; `ff`, uppercase, a bad layout and all-zero ids are refused) and throws `TraceparentError` with a named `reason` — never the header, in the message or on the error. The env is read ONCE (`admitRunEnv`: one own-field snapshot; the stages' `$getEnv()` gets the canonical header), and the run keeps the canonical header of the EFFECTIVE ids, never the received bytes. Explicit `env.traceId` / `env.operationId` (1–256 printable ASCII; a `TypeError` by field otherwise — the caller's contract, while `TraceparentError` is the untrusted header's) win over the header's, and nothing of the header rides once the trace is not the header's; the flags byte is kept whole; a bad header refuses the run even beside explicit ids. The correlation is resolved once per leg, before anything moves, and lives on the leg's traverser and its composed scope factory — never on the chart, the checkpoint, the state or the log — so it cannot reach another run.
- *Time is the clock's.* `startedAt` / `durationMs` come from `options.now` (`Date.now`); a byte pin settles them.
- *A declared wait ceiling cannot lie (P5).* `RetryPolicy.maxBackoffMs` caps every wait: the runner waits `cappedWaitMs(resolveBackoffMs(…), maxBackoffMs)` — the record's `delayMs`, `onStageRetry`'s delay and rule 6's wait are all the capped value — so a stated `Retry-After` of an hour waits the ceiling. The static budget check (`budget/`) never calls a function backoff (it may read the error); it counts the ceiling instead. `backoff-ceiling.test.ts` pins the cap.

  ```typescript
  import { flowChart } from 'footprintjs';

  const statedWaitMs = (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs;
  flowChart('Call', () => undefined, 'call', {
    retry: { attempts: 3, timeoutMs: 1_000, backoffMs: (n, error) => statedWaitMs(error) ?? 100 * n, maxBackoffMs: 2_000 },
  });
  ```

- *A schedule is a function the record explains (the backoff helpers).* `exponentialBackoff({ baseDelayMs, multiplier = 2, maxDelayMs?, jitter = 'none', random = Math.random })` and `statedWaitFirst(readStatedWaitMs, inner)` build the function `backoffMs` already takes, so the policy keeps its one shape. The wait after failed attempt n lies under its ceiling `c = min(maxDelayMs, baseDelayMs × multiplier^(n − 1))`: `'none'` waits `c` and never draws, `'equal'` waits `c/2 + r·c/2`, `'full'` waits `r·c` (r = `random()`, in [0, 1]); without `maxDelayMs` a ceiling saturates at `Number.MAX_SAFE_INTEGER`, never `Infinity`. A stated wait read off the error wins; one that is not a finite number ≥ 0 — or a reader that throws — falls back to the schedule. Each wait is drawn once and recorded as `delayMs`, so a trace explains a jittered wait without redrawing it; inject `random` and a test is exact. A spec that is not a finite `baseDelayMs` ≥ 0, a `multiplier` ≥ 1, a `maxDelayMs` ≥ `baseDelayMs` and a known `jitter` is refused when built, naming the field. `backoff.test.ts` and `backoff.property.test.ts` pin the bounds; example 08 runs it.
  - *Two caps, two jobs.* `BackoffSpec.maxDelayMs` caps the SCHEDULE: it bounds the ceiling before the draw, so waits at the cap keep their jitter (capping after the draw would flatten them into one constant — a fleet retrying in lockstep). `RetryPolicy.maxBackoffMs` caps EVERY wait after the draw, a stated one included; the runner enforces it and the budget check counts a function backoff at it. A stated wait is never capped by the inner schedule's `maxDelayMs`.

  ```typescript
  import { exponentialBackoff, flowChart, statedWaitFirst } from 'footprintjs';

  const retryAfterMs = (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs;
  flowChart('Call', () => undefined, 'call', {
    retry: {
      attempts: 6,
      timeoutMs: 2_000,
      backoffMs: statedWaitFirst(
        retryAfterMs,
        exponentialBackoff({ baseDelayMs: 200, maxDelayMs: 2_000, jitter: 'equal' }),
      ),
      maxBackoffMs: 5_000,
    },
  });
  ```

- *One deadline, every attempt capped (P1b).* Each attempt runs under `min(policy.timeoutMs, deadline − now)` and gets an `AttemptContext` (`scope.$attempt()`): its signal — the run's, composed with its own cap's timer — and `timeLeftMs()`. Its cap aborts with an `AttemptTimeoutError`; the deadline aborts the run's signal with a branded reason. Either way the attempt is `timeout`: **the deadline is not a cancellation**, so rule 3 does not match and rule 6 stops a series whose next wait would outlast it (`no-time-left`). No attempt starts at or past the deadline. Under a deadline `backoffMs(n, error)` is asked while deciding — before the discard; without one the 9.15 order holds.
- *An ended attempt is fenced.* The moment an attempt ends without an answer — its signal aborts (synchronously, ahead of any listener the function added) or it throws — `onAbandon(n)` fires once. The engine closes that attempt's scope there (`StageContext · endAttempt`, checked by `ScopeFacade · refuseIfAttemptEnded`): a later write, emit or read is refused, and a write or emit is recorded (`StageSnapshot.lateWrites`, names only). The engine races the attempt's signal at the stage boundary (`raced: true`); any other caller gets the race here.

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

```typescript
import { flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface Quote { price?: number }
const chart = flowChart<Quote>('Quote', async (scope: TypedScope<Quote>) => {
  await new Promise((resolve) => setTimeout(resolve, 50)); // a slow call that ignores scope.$attempt().signal
  scope.price = 9; // refused once the 10 ms cap ended this attempt — recorded in lateWrites
}, 'quote')
  .retry({ attempts: 1, timeoutMs: 10 })
  .build();
const executor = new FlowChartExecutor(chart);
await executor.run().catch(() => undefined); // rejects with AttemptTimeoutError
console.log(executor.getSnapshot().executionTree.attempts?.[0]?.outcome); // 'timeout'
```

```typescript
import { attempt, flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface Quote { price?: number }
let busy = 1;
const quotes = async () => {
  if (busy-- > 0) throw Object.assign(new Error('busy'), { status: 503 });
  return 9;
};

const chart = flowChart<Quote>('Quote', async (scope: TypedScope<Quote>) => {
  scope.price = await scope.$call('quotes.create', () => quotes(), { attempts: 2 });
  scope.$attempt().observed({ target: 'payments', attempt: 1, of: 3, outcome: 'ok', durationMs: 40 });
}, 'quote').build();
const executor = new FlowChartExecutor(chart);
await executor.run();
console.log(executor.getSnapshot().executionTree.attempts?.map((a) => [a.kind, a.series, a.attempt, a.outcome]));
// [['call', 'quote#0@1.1', 1, 'failed'], ['call', 'quote#0@1.1', 2, 'ok'], ['observed', 'quote#0@1.2', 1, 'ok']]

// Outside any chart: the same runner, records to your callback only.
await attempt(() => quotes(), { attempts: 2 }, { target: 'quotes.create', onAttempt: (record) => console.log(record) });
```

Layers: `types.ts` is L0; the rest is L5, beside `decide/` — it imports `filter/` (the rule evaluator `decide()` shares), `decide/types`, `errors/`, `pause/` and `capture/summarize`, nothing from `scope/`, `engine/` or `decide/` at run time, so both scope/ (`$call`) and engine/ reach it (`scripts/layering.config.cjs`). The executor composes the run's signal and deadline in `runner/deadline.ts · armRun`.
