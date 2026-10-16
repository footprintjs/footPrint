# Error Handling

FootPrint's error handling is designed around one principle: **the trace must capture everything that happened, including failures**.

---

## Who Is Responsible for What

| Layer | Responsibility |
|-------|---------------|
| **Stage function** | Business logic. Throws errors when invariants break. |
| **Engine** | Infrastructure. Catches errors, commits the trace, records error metadata, then re-throws. |
| **Consumer** | Wraps `executor.run()` in try/catch. Inspects `getSnapshot()` after failure for debugging. |

---

## Commit-on-Error

When a stage throws, the engine calls `context.commit()` *before* re-throwing. This preserves everything up to the failure point:

```typescript
const executor = new FlowChartExecutor(chart);
try {
  await executor.run();
} catch (error) {
  const snapshot = executor.getSnapshot();
  // commitLog has entries for every stage that ran (including the one that failed)
  // executionTree shows scope writes, error metadata, and flow decisions
  // An LLM can use this to explain WHY the error happened
}
```

Without commit-on-error, a failed stage's partial writes would be lost. The trace would end at the last successful stage, hiding the context of the failure.

What gets preserved:
- **Scope writes** made before the throw
- **Error metadata** (`stageExecutionError`) recorded in the execution tree
- **Narrative** includes the error event (`"An error occurred at validate: ..."`)
- **Commit log** has an entry for the failed stage's state

---

## Declarative Retry

### Why this exists

The obvious way to retry a flaky call is a loop inside the stage function:

```typescript
// Don't do this — it works, and it is invisible
for (let i = 0; i < 3; i++) {
  try { scope.rate = await fetchRate(); break; } catch { await wait(100); }
}
```

The narrative shows one stage. The commit log shows one entry. The two failed calls that happened first left no mark anywhere — so when someone later asks *"why did this run take four seconds?"*, the trace has no answer. That is an unexplained behaviour in a library whose whole thesis is that nothing invisible happens.

Declare the policy instead, and every attempt becomes part of the record:

```typescript
import { flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface QuoteState { currency: string; amount: number; rate: number; quote: number }
const readFn = (scope: TypedScope<QuoteState>) => { scope.currency = 'EUR'; scope.amount = 100; };
let calls = 0;
// Local rate-service fixture: two failures followed by a successful response.
const fetchRateFn = async (scope: TypedScope<QuoteState>) => {
  if (scope.currency !== 'EUR') throw new Error('Unsupported fixture currency');
  if (++calls < 3) throw new Error('rate service unavailable');
  scope.rate = 1.09;
};
const buildQuoteFn = (scope: TypedScope<QuoteState>) => { scope.quote = scope.amount * scope.rate; };

const chart = flowChart<QuoteState>('Read request', readFn, 'read-request')
  .addFunction('Fetch rate', fetchRateFn, 'fetch-rate')
  .retry({ attempts: 3, backoffMs: (attempt) => 100 * attempt })
  .addFunction('Build quote', buildQuoteFn, 'build-quote')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();
```

`attempts` counts **total runs including the first** — `attempts: 3` is one run plus up to two retries. `attempts: 1` is a declared-but-off policy, so you can dial one down without deleting it.

### What an attempt is

| | Behaviour |
|---|---|
| **Failed non-final attempt** | Its staged writes are **discarded**. Nothing was applied, so there is nothing to roll back — footprint stages writes in a buffer and only flushes them on commit, and a discarded attempt simply never commits. The next attempt starts from committed state, never from the wreckage of the last try. |
| **Final attempt** | Exactly today's law. On success it commits; on failure it commits what it wrote and rethrows. Commit-on-error is unchanged. |
| **A chart with no `retry`** | Byte-identical to before the feature existed. |

Attempts are internal to **one** stage execution: one `runtimeStageId`, one execution index, **one commit bundle** — no matter how many times the function ran. Retries also do not consume loop iterations (`maxIterations`).

### The evidence

Every attempt is recorded — when it started, how long it took, how it ended, its failure category, and the decision
that followed it (10.1). One record shape, `AttemptRecord`, in three places:

| Where | What you get |
|---|---|
| `FlowRecorder.onAttempt` | one event per attempt, at its end: `event.record` and the attempt's served `structuredError` — a stage's own (`record.kind === 'stage'`), and the calls it makes (`'call'`, `'observed'`) |
| the stage's execution-tree node | `attempts` (every record, in order) and `attemptSummary` (counts per outcome, and how the series ended) |
| the narrative | one line per attempt, in order inside the stage |

None of it rides the commit log: a retried stage is still ONE bundle, byte for byte what a first-try success writes.

```typescript
import { flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface RateState { rate: number }
let calls = 0;
// Local rate-service fixture: one failure, then an answer.
const fetchRateFn = (scope: TypedScope<RateState>) => {
  if (++calls < 2) throw Object.assign(new Error('rate service unavailable'), { status: 503 });
  scope.rate = 1.09;
};

const chart = flowChart<RateState>('Fetch rate', fetchRateFn, 'fetch-rate')
  .retry({ attempts: 3, backoffMs: 100 })
  .build();

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder({
  id: 'attempt-log',
  onAttempt: ({ stageName, record }) => {
    if (record.kind !== 'stage') return; // a call the stage made, or an observed attempt (see below)
    // "Fetch rate: attempt 1/3 failed (server) in 2ms → retry (retryable)"
    const category = record.category ? ` (${record.category})` : '';
    console.log(
      `${stageName}: attempt ${record.attempt}/${record.of} ${record.outcome}${category} ` +
        `in ${record.durationMs}ms → ${record.next} (${record.reason})`,
    );
  },
});
await executor.run();

// The same records, kept on the stage's node — and the series at a glance.
const node = executor.getSnapshot().executionTree;
console.log(node.attempts?.map((r) => r.reason)); // ['retryable', 'succeeded']
console.log(node.attemptSummary); // { count: 2, ok: 1, failed: 1, …, last: { next: 'done', reason: 'succeeded' } }
```

`record.decision` is a `DecisionEvidence` — exactly what a decider records through `decide()` — evaluated from one
rule table, `retryRules(policy)`, first match wins:

| # | Stops (or ends) when | `next` | `reason` |
|---|---|---|---|
| 1 | the attempt succeeded | `done` | `succeeded` |
| 2 | it paused (`addPausableFunction`, `interrupt()`) | `stop` | `paused` |
| 3 | the run's signal had aborted | `stop` | `aborted` |
| 4 | it was the last attempt the policy allows | `stop` | `exhausted` |
| 5 | `retryOn` said no (a throwing `retryOn` counts as no) | `stop` | `declined` |
| 6 | the wait would not fit in the time left (with a deadline) | `stop` | `no-time-left` |
| — | otherwise | `retry` | `retryable` |

A failed attempt that is followed by another also fires `FlowRecorder.onStageRetry`, exactly as it has since 9.15 —
after that attempt's `onAttempt`, after its writes are discarded, before the wait:

```typescript
executor.attachFlowRecorder({
  id: 'retry-log',
  onStageRetry: (event) => {
    console.log(
      `${event.stageName}: attempt ${event.attempt}/${event.maxAttempts} failed ` +
        `(${event.message}) — waiting ${event.delayMs}ms`,
    );
  },
});
```

The narrative renders the attempts **in order, inside the stage**, between the attempts' own reads and writes — one
line per attempt, which says "retrying" itself (the 9.15 `[Retry]` line is no longer rendered):

```
Stage 2: Ask the rate service for today's conversion rate.
  Step 1: Read currency = "EUR"
  Attempt 1 of 3 at Fetch rate failed in 2ms (rate service unavailable), retrying in 100ms.
  Step 3: Read currency = "EUR"
  Attempt 2 of 3 at Fetch rate failed in 1ms (rate service unavailable), retrying in 200ms.
  Step 5: Read currency = "EUR"
  Step 6: Write rate = 1.09
  Attempt 3 of 3 at Fetch rate succeeded in 1ms.
```

A stage that fails for good is told by its `[Error]` line, with its attempt lines beneath it — in the combined
narrative and in the flow-only `NarrativeFlowRecorder` alike; the last one says why the series stopped —
`stopped: no attempts left`, `stopped: retryOn declined`, `stopped: retryOn threw`, `stopped: the run was aborted`.
Format the line yourself with `NarrativeFormatter.renderAttempt` (return a string, `null` to drop it, or `undefined`
for the default).

**The event arithmetic, stated exactly** — so you can count what you should be seeing:

| Outcome | `onAttempt` events | `onStageRetry` events | `onError` events |
|---|---|---|---|
| Succeeds on the first try | 1 | 0 | 0 |
| Succeeds on attempt N | N | N − 1 | 0 |
| Exhausts the policy | `attempts` | `attempts` − 1 | 1 |
| `retryOn` declines the first failure | 1 | **0** | 1 |

`onAttempt` is always the number of attempts made — counting the STAGE's attempts (`record.kind === 'stage'`): the calls a stage makes and the outside attempts it reports fire `onAttempt` too (kind `'call'` / `'observed'`, "Retries you did not run" below). A declining `retryOn` fires no retry event — there is nothing to
retry — but it no longer leaves the record silent: its one attempt says `reason: 'declined'`.

### Failure categories

Every attempt that did not succeed carries one of seven `category` values, classified by `errorCategory(error)` —
the one classifier, so every recorder breaks failures down the same way:

| Category | When |
|---|---|
| `timeout` | the attempt's own time cap ran out (`AttemptTimeoutError`) |
| `rate-limited` | `status` / `statusCode` 429, or the error declares `retryAfterMs` / `retryAfterSeconds` |
| `server` | status 5xx |
| `auth` | status 401 / 403 |
| `permanent` | any other 4xx, a validation error, or the error declares `retryable: false` |
| `network` | a transport failure: `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE` (on the error or its `cause`), a failed `fetch`, an `AbortError` that was not the run's |
| `unknown` | anything else — and every attempt the run's own signal ended (it threw the abort's own reason) |

What a failure looked like wins over what it declares: a 429 that also says `retryable: false` is `rate-limited`.
A category is evidence, not policy — the default `retryOn` retries every category. To act on one, say so:

```typescript
import { errorCategory, type RetryPolicy } from 'footprintjs';

const policy: RetryPolicy = { attempts: 4, retryOn: (error) => errorCategory(error) !== 'permanent' };
```

### Deciding what is worth retrying

A timeout deserves another go. "Card declined" does not — retrying it wastes time and can double-charge.

```typescript
.retry({
  attempts: 5,
  retryOn: (error) => !(error instanceof DeclinedError),
})
```

A `retryOn` that **throws** is treated as "do not retry" — a broken predicate must never turn a failing stage into an endless loop. The record keeps it apart from a real `false`: the attempt stops `declined` with `retryOnThrew: true`, and its line reads `stopped: retryOn threw`.

`retryOn` sees the thrown value before anything else reads it: the served error (`AttemptRecord.error`, the `onStageRetry` payload) and the category are taken after the predicate ran, so an edit it makes to the error shows in both — as `onStageRetry` always showed it.

### What is never retried

- **A pause.** Neither `addPausableFunction`'s pause nor `interrupt()` is a failure — both suspend the run, and retrying them would break resume. The attempt is recorded `paused`.
- **A cancelled run.** An aborted `AbortSignal` ends the stage immediately; the run never sits through a backoff and then tries again, and `retryOn` is not asked. The attempt keeps what it did — `failed`, with its own category — and the series stops with `reason: 'aborted'`; only an attempt that threw the abort's own reason is recorded `aborted`. A wait the signal cuts short records no further attempt, and the series' summary says it ended `aborted`. The order is 9.15's: an abort raised inside `retryOn` stops before the failed attempt's writes are discarded (so they land, as any failing stage's do) and `backoffMs` is never asked; one raised inside `backoffMs` comes after the discard.
- **`scope.$break()`.** Breaking is not an error.

### Time budget

A retry without a clock can run a stage for as long as it likes: four attempts of 40 s each is 160 s, past a caller who gave up at 120 s — and the record said "one stage, one error". So a run has ONE deadline, every attempt is capped by it, and the record says how much time each attempt had.

| You declare | What it does |
|---|---|
| `run({ deadline })` (epoch ms) or `run({ timeoutMs })` | The run's deadline. Stages read it as `env.deadline`; the run's signal aborts when it passes. The earliest of the two (and an `env.deadline` you pass) wins. A resumed leg has its own: pass it again to `resume()`. |
| `RetryPolicy.timeoutMs` | The cap on ONE attempt. It runs under `min(timeoutMs, time left)`. `{ attempts: 1, timeoutMs }` is a timeout with no retry. |
| `RetryPolicy.backoffMs: (n, error) => ms` | The wait may read the error — a wait the outside system stated (`Retry-After`) plugs in here; the engine parses nothing. |
| `RetryPolicy.maxBackoffMs` | The most ONE wait may last. The runner enforces it — every wait is `min(answer, maxBackoffMs)`, whatever the error stated — so a stated `Retry-After` of an hour cannot outwait it. |

Inside the stage, `scope.$attempt()` is the attempt you are running in:

```typescript
import { flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface QuoteState { quote?: number; partial?: boolean }

// Local quote-service fixture: answers in 20 ms unless the signal stops it first.
const fetchQuote = (signal: AbortSignal) =>
  new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => resolve(42), 20);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

const chart = flowChart<QuoteState>(
  'Quote',
  async (scope: TypedScope<QuoteState>) => {
    const t = scope.$attempt(); // attempt / of, the signal, the time left
    scope.quote = await fetchQuote(t.signal); // pass the signal on: it aborts at the cap
    scope.partial = t.timeLeftMs() < 1_000;
  },
  'quote',
)
  .retry({ attempts: 3, timeoutMs: 2_000, backoffMs: (n) => 100 * n })
  .build();

await new FlowChartExecutor(chart).run({ timeoutMs: 10_000 });
```

What happens, and what is recorded:

- **An attempt that outlives its cap times out.** Its signal aborts with an `AttemptTimeoutError`, the engine stops waiting, and the record says `outcome: 'timeout'`, `category: 'timeout'`, with the cap it ran under (`timeoutMs`). A timeout is retried like any failure — `retryOn` sees the `AttemptTimeoutError`.
- **The deadline is not a cancellation.** An attempt the deadline cuts short timed out (it had no answer in the time it had), and the series stops `no-time-left` — never `aborted`, which stays the word for a run you cancelled.
- **A wait that would outlast the deadline is never started.** The series stops `no-time-left`; the record carries the time left and the wait it would have taken (`Attempt 2 of 4 at Charge card timed out after 2s; stopped: no time left (300ms left, next wait 2s).`). No attempt starts at or past the deadline. Under a deadline `backoffMs` is asked while deciding, before the failed attempt's writes are discarded — the decision needs the wait's length.
- **A lone call leaves evidence.** A stage with a `timeoutMs`, and every stage of a run with a deadline, records its attempt even with no retry policy — `attempts: [{ attempt: 1, of: 1, … }]` on its node. The narrative tells such a lone attempt only when it did not succeed. A run with no deadline and no policy records nothing, byte-identical to before.
- **Time is an input.** `timeLeftMs()` is `Infinity` without a deadline; with one, reading it marks the stage's commit `untrackedSources: ['env']`, as `$getEnv()` does — the record cannot replay the clock.

**What the engine stops is the WAITING.** A JavaScript function cannot be killed: only the work you pass `t.signal` to stops at the cap. Whatever the abandoned attempt does afterwards cannot reach the stage — from the moment an attempt ends without an answer, its scope is fenced: a write, an emit, a diagnostic (`$debug`, `$metric`, …), a detach or a read through it is refused, so nothing lands beside a later attempt or after the commit, and every refused write, emit, diagnostic or detach is recorded on the stage as `lateWrites: [{ attempt, key, channel }]` (names only, the first 100). An in-place edit of an object the attempt already held cannot be trapped (see `src/lib/reactive/README.md`, "A handle is bound to its stage").

`env.signal` is honoured as well: the run composes `signal`, `env.signal` and the deadline into one signal, and a stage reads that one on `env.signal`.

Worked example: [`examples/runtime-features/retry/03-deadline-and-timeout.ts`](../../examples/runtime-features/retry/03-deadline-and-timeout.ts).

### A static budget check

A deadline catches a slow run while it happens. A **budget** catches a slow chart before it ever runs. The incident's two numbers were both declared — `{ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 }` on the stage, 120 s from the caller — so the mismatch is knowable while you write the chart. `.budget(ms)` declares the caller's contract, and `build()` checks the chart against what its declared policies allow:

```typescript
import { flowChart, timeBudget } from 'footprintjs';

// Local stand-ins: nothing here calls a real service.
const readQuote = () => undefined;
const chargeCard = () => undefined;

flowChart('Read', readQuote, 'read', { retry: { attempts: 1, timeoutMs: 5_000 } })
  .addFunction('Charge', chargeCard, 'charge')
  .retry({ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 })
  .budget(120_000);
// .build() throws: "budget(120000): its declared policies allow 168000 ms, over its budget by 48000 ms.
//   Slowest path: read: 1 × 5000 ms + 0 ms of waits = 5000 ms; charge: 4 × 40000 ms + 3000 ms of waits = 163000 ms. …"

const kept = flowChart('Read', readQuote, 'read', { retry: { attempts: 1, timeoutMs: 5_000 } })
  .addFunction('Charge', chargeCard, 'charge')
  .retry({ attempts: 3, timeoutMs: 20_000, backoffMs: 1_000 })
  .budget(120_000)
  .build();

const report = timeBudget(kept); // also kept.timeBudget()
// report.worstCaseMs  → 67000 (null when a path is unbounded)
// report.criticalPath → [{ stageId, attempts, timeoutMs, backoffMs, worstMs, passes }, …] — the slowest path
// report.unbounded    → [{ stageId, why }] — every stage the check cannot bound
// report.over         → false
```

How it counts — the full rules are in [`src/lib/budget/README.md`](../../src/lib/budget/README.md):

| On the chart | Counts as |
|---|---|
| A stage with a policy | `attempts × timeoutMs` + the waits between attempts — a number `backoffMs` as declared (under `maxBackoffMs`) |
| A function `backoffMs` | **never called** — it may read the error, and no error exists at build. Counted at `maxBackoffMs` per wait (the runner enforces it); without one, **unbounded** (`why: 'backoff'`) |
| A stage with no `timeoutMs` | **unbounded** — `why: 'no-timeout'`, counted as 0 and named |
| A sequence / a decider, selector or fork | the sum / its own stage + the slowest child (fork children run at once) |
| A mounted subflow | its chart, under the ids the run gives its stages (`pay/charge`) |
| A lazy subflow / a `parallelForEach` | **unbounded** (`'lazy-subflow'` / `'items'`) unless `assume.lazy` / `assume.branches` names the chart it runs; a `parallelForEach` counts ONE branch — they run at once |
| A loop | **never iterated**: unbounded (`'loop'`, named by its target) unless `assume.loops[targetId]` bounds its passes |

**What is refused, what is warned.** `build()` refuses when the part it CAN count already exceeds the budget (`report.knownMs`) — a time the declared policies allow a run to take (`retryOn` is not read: it may only stop a series sooner), so the budget cannot be promised — even on a path with an unbounded stage. Every unbounded stage is a dev-mode warning instead, by name: never a guess. At run start, a `timeoutMs` / `deadline` shorter than the declared budget is a dev-mode warning, once per chart.

**What it cannot see.** A stage function that blocks the thread (the cap stops the waiting, not the work), the engine's own time between stages, and a StageNode a stage returns at run time — the budget is of the graph the chart declares. A wait the outside system states (`Retry-After`, read from the error by your `backoffMs`) is not known at build — declare `maxBackoffMs`: the check counts it, and the runner holds every wait to it.

Worked example: [`examples/build-time-features/budget/01-time-budget.ts`](../../examples/build-time-features/budget/01-time-budget.ts).
### Retries you did not run

A stage's policy records the STAGE's attempts. Most retries happen one level down: the stage calls a payment API, an LLM, a search index — often through an SDK that retries on its own. The incident behind this design was exactly that: four 40 s attempts inside an SDK, and a record that said "one stage, one error". So a call made inside a stage goes through `scope.$call(target, fn, policy?)`, and an SDK's own retries are reported with `observed()`.

```typescript
import { flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

interface QuoteState { quote?: number }

// Local quote-service fixture: answers unless the signal stops it first.
const quoteService = (signal: AbortSignal) =>
  signal.aborted ? Promise.reject(signal.reason) : Promise.resolve(42);

const chart = flowChart<QuoteState>(
  'Quote',
  async (scope: TypedScope<QuoteState>) => {
    scope.quote = await scope.$call('quotes.create', (t) => quoteService(t.signal), {
      attempts: 3,
      timeoutMs: 2_000,
      backoffMs: (n) => 200 * n,
    });
  },
  'quote',
).build();

const executor = new FlowChartExecutor(chart);
await executor.run({ timeoutMs: 10_000 });
const [call] = executor.getSnapshot().executionTree.attempts ?? [];
// { kind: 'call', target: 'quotes.create', series: 'quote#0@1.1', attempt: 1, of: 3, outcome: 'ok', next: 'done', … }
```

| What | How it is recorded |
|---|---|
| **Every call, even a single one** | `$call` with no policy is `{ attempts: 1 }` — and still ONE record: timing and outcome evidence with no retry. Each attempt is an `AttemptRecord` of kind `'call'` on the stage's `attempts` and on `onAttempt` (with the stage's `traversalContext`, so the run's correlation rides it), told in the narrative: `Call quotes.create, attempt 1 of 3, failed in 812ms (rate-limited: 429), retrying in 4s.` |
| **Its series** | `<runtimeStageId>@<stage attempt>.<k>` — the `k`-th call that stage attempt made — so `<series>@<attempt>` is the attempt id of foottrace's grammar. Calls of an earlier, failed stage attempt stay on the node (a discard keeps evidence). |
| **Its time** | It runs under its stage attempt: capped by `min(policy.timeoutMs, the time that attempt has left)`; a wait that would outlast it is never started (`no-time-left`); cut when the attempt is cut — `timeout` at a cap or the deadline, `aborted` on a cancellation. `t.signal` aborts with it: pass it on. |
| **Its error** | Served under the run's redaction rule, exactly as a stage's error is: on the record, the hook and the narrative line. The record never holds the thrown value. |
| **Its name** | `target` is a NAME from code — 1–128 characters, not blank, no control, format, line-separator, private-use or noncharacter code point — never a value and never something a model wrote. Anything else is refused with a `TypeError` before the call runs. |
| **Refusal vs failure** | A malformed call (target, function, policy) or one made after its attempt ended THROWS at `$call(...)`, synchronously, like every scope refusal — your code broke the contract. A call that runs and fails REJECTS with its last attempt's own error. |
| **Bounds** | A stage keeps its first 1000 call and observed records; the rest are counted in `attemptsDropped` (each still fires `onAttempt`). |

**A call lives within the attempt that made it — await it.** Once that stage attempt is over — it timed out, threw while the call was in flight, returned without awaiting it, or committed — the call STOPS: its signal aborts, a wait ends, no further attempt of it starts (no blind retry of an outside call), a record that arrives late is refused, and a `$call` or an `observed()` after the end is refused. A call is never sent past its deadline, even when a busy event loop runs the stage past its cap before the timer fires. An orphan's rejection (the library stopped it) never surfaces as an unhandled one. Each refusal is recorded by name, `lateWrites: [{ attempt, key: 'call:<target>' | 'observed:<target>', channel: 'attempt' }]`. The record of a call attempt CUT by its stage attempt's end is kept — the cut is the evidence. Let the call's function RETURN its answer rather than write the scope: what it does after its attempt ended cannot be told apart from the stage's own work.

**Adapter advice — an SDK that retries on its own.**

1. **Prefer ONE loop.** Turn the SDK's own retries off (`maxNetworkRetries: 0`, `maxRetries: 0`, …) and run the call under `$call` with the policy you want. Then the deadline, the record and the decision are one thing — and nothing retries out of sight.
2. **Never both.** An SDK that retries 3 times under a `$call` with `attempts: 3` makes up to 9 calls, and the record sees only 3 of them.
3. **Where the SDK must keep its retries, report each one** from whatever it exposes — a request/response event with an elapsed time, a retry callback, a logger line — through the attempt's `observed()`:

   ```typescript
   import type { AttemptContext } from 'footprintjs';

   // Inside a stage (or a $call's function): `t` is scope.$attempt(), or the call's own context.
   function reportSdkTry(t: AttemptContext, attempt: number, ok: boolean, ms: number, error?: unknown) {
     t.observed({ target: 'payments', attempt, of: 3, outcome: ok ? 'ok' : 'failed', durationMs: ms, error });
   }
   ```

   Each report is an `AttemptRecord` of kind `'observed'` (`source: 'sdk'` unless you name another), under the stage attempt's call level, told as `Observed: the payments SDK made attempt 2 of 3, failed in 600ms (server: busy).` Only the named fields are read — a request body or headers on the object are never read, so they cannot reach the record — and the error is served under the redaction rule; no hook is handed your error object itself (an SDK error can carry its request). A report that arrives after its attempt ended — an SDK callback firing after the stage's cap — is dropped and recorded by name (`lateWrites`, `observed:<target>`), never thrown into the SDK's callback; a malformed report is still a `TypeError`.
4. **Where it exposes nothing, report ONE attempt for the whole call, without `of`** — "the SDK ran this, its count unknown" — rather than a pretended count. Pass `of` whenever you report attempt by attempt.

An observed attempt never changes control flow. Its `decision` is the library's reading of the report under the default policy (every error retryable, no deadline) — never the SDK's own decision, which the record cannot know, so the narrative line carries no decision clause.

**Outside a stage**, the same runner is `attempt(fn, policy?, { target, series, deadline, signal, onAttempt })`: the same record, delivered only to your `onAttempt` (there is no run, so there is no execution tree and no redaction rule). A deadline already past, or a signal already aborted, starts no attempt.

Worked example: [`examples/runtime-features/retry/05-attempts-inside-a-stage.ts`](../../examples/runtime-features/retry/05-attempts-inside-a-stage.ts).

### A crash-safe record

**Why.** `getSnapshot()` lives in the process that ran the chart. When that process is killed in the middle of a retry, runs out of memory or is frozen by a serverless host, the record of the run you most need to explain dies with it — and a stage killed between its attempts never commits, so even a log that survived would not hold its attempts.

**What.** Give the executor a **sink** and every log of the run hands it its entries *as they land*: the root log and each subflow mount's own log, each at its address (`{ logRunId, drillPath }` — the same address the snapshot names). Four kinds of entry:

| Entry | When | What it carries |
|---|---|---|
| `opened` | the log is created (a run, a fresh-executor resume, a mount) | the fold base, and `meta`: `runId`, `chart: { id, name }`, and when present `correlation`, `deadline`, `budgetMs`, `resumedFrom` (a mount: `subflowId`) |
| `commit` | each bundle lands | the log's own frozen bundle — the same bytes `getSnapshot().commitLog` serves |
| `note` | an attempt ENDS (`kind: 'attempt'`, `data: { record }`); a same-executor resume starts (`kind: 'resume'`, `data: { runId, resumedFrom }`) | the served `AttemptRecord` — every attempt the stage's node keeps, its own and its calls' |
| `closed` | the log ends | `outcome` (`ok`, `failed`, `paused`), the number of commits, and `meta`: `runId`, and on a failure the served `error` (`name`, `message`, `code` — never the thrown value) |

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks'; // Node only
import { readStoredRecord, stateAt } from 'foottrace';

const chart = flowChart<{ orderId?: string }>('Receive order', (scope) => {
  scope.orderId = 'A-17';
}, 'receive').build();

const executor = new FlowChartExecutor(chart, { sink: fileSink('/var/footprint/orders.jsonl') });
await executor.run();                   // the closing entry, then the file's fsync, before run() settles
executor.getSnapshot().sink;            // { entries: 3, failed: 0 }
const runId = executor.getSnapshot().runId; // keep it beside your request — the stored log's address

// Later — in another process, after a crash:
const record = readStoredRecord(readRecordFile('/var/footprint/orders.jsonl').entries);
const root = record.root(runId)!;
root.complete;                          // false: no closing entry — the run never finished
root.notes;                             // the attempts that ended, even of a stage that never committed
stateAt(root.source(), root.commitLog.length - 1).state; // what had landed
```

`readStoredRecord` reads the entries back into the same log the live snapshot holds (pinned by a property test over random charts); a run that never finished reads `complete: false` — the visible incompleteness a viewer shows before any fold — and still folds what landed. A commit the store lost is a gap at its own index, never a silent shift.

**Which sink.** `memorySink()` (`foottrace/write`) is the reference adapter and the one for tests. `fileSink(path, { maxBytes? })` (`footprintjs/sinks`, **Node only** — the one door that imports `node:fs`) appends one JSON line per entry; `readRecordFile(path)` reads it back (a regular file only, at most `maxBytes`, default 256 MiB) and names every torn or corrupt line by number instead of failing. The sink keeps its file open until you call `sink.close()`. Your own store (a bucket, a table) implements the four methods of `RecordSink` (`foottrace/write`); an adapter that writes somewhere slow queues each entry and drains in `flush()`.

**The laws.**

1. **No secret reaches the sink.** The redaction policy applies before any entry is written: the `opened` base is the run's served form of it (a policy key seeded by `initialContext` or a checkpoint is the log's placeholder), a commit is the log's own scrubbed bundle, an attempt's error is the served one, and the lifecycle meta is scrubbed like any record handed out whole. **No retroactive scrub (a ruled law):** a per-call mark (`$setValue(k, v, true)`), a mapper's taint or an identity inheritance scrubs every entry from the moment it is made — but an entry already stored stays as it was (the base written when the log opened; a commit made before the mark), exactly as in the in-memory log. To keep a seeded or early-written secret off the sink, name it in the POLICY (`setRedactionPolicy({ keys })`), which applies from the first entry.
2. **A failing sink never stops the run** (`onFailure: 'report'`, the default). A method that throws or rejects, an entry the log refuses to send and a flush that fails are counted on `getSnapshot().sink` (`{ entries, failed, lastError? }`), with one dev-mode warning per run; the adapter's own `onFailure` still hears each loss. When the record *is* the product, opt in: `{ sink: { adapter, onFailure: 'fail' } }` fails the run at the first lost entry with a `RecordSinkError` (`cause` = the adapter's error) — the run's signal aborts, so it stops at the next stage boundary; a run that finished with a loss rejects with it (a PAUSED leg too — its checkpoint is still on `getCheckpoint()`); a run that failed on its own keeps its own error. The mode is per leg: a resume starts with a clean slate (the counts go on).
3. **The file sink writes only the path you give, and every resource it spends is bounded.** It is opened once when you make it: a symbolic link there is refused (a directory above it is followed; Windows has no `O_NOFOLLOW` and no owner check), and so is an existing file with another hard link, owned by another user, or writable by others; a file it creates is owner-only (`0o600`), and each entry is one line, encoded whole, given its own offset and handed to the I/O pool at once — the method returns immediately and never blocks; the pool's threads write it while your stages run on, so a process killed after a pool thread wrote it keeps it. **The window is the I/O pool's:** microseconds on a free pool, but Node's pool (4 threads by default) is shared with DNS lookups (every `fetch`), zlib, crypto and other file work, and while it is busy an accepted entry waits as long as that work — measured: a kill with no backoff kept the attempt note 100/100 on a quiet machine, ~97/100 under load, and 0/20 with the pool saturated by crypto (a 100 ms backoff kept it 10/10 even then). Because writes complete out of order, a kill can lose an entry mid-file; `readRecordFile` reports the hole. Raise `UV_THREADPOOL_SIZE` if your app keeps the pool busy. This window is accepted (ruled): **a hard kill can lose the last in-flight entry.** A future `durability: 'sync'` option would close it; it is not built yet. A line torn by a failed write never swallows the next entry. Every bound refuses by name and the run counts it: `maxEntryBytes` (one line, 8 MiB), `maxQueuedBytes` (accepted but not yet written, 16 MiB — past it an entry is dropped, never buffered without limit), `maxBytes` (the file, 64 MiB counting what it already holds — once full, every further entry is refused; a closing entry may use a 64 KiB reserve, so a full file can still say how the run ended), `flushTimeoutMs` (10 s). One sink per file per process (a second is refused, across the CommonJS and ESM builds); give each PROCESS its own file — two processes on one path overwrite each other's offsets, which `flush()` detects (best effort) and counts as a loss. Call `await sink.close()` when you are done with it: an unclosed sink keeps its file open, and the path refused to another sink, for the life of the process. `flush()` waits for the queue, then `fsync`s — the step that also survives the machine losing power.
4. **Flushing.** `run()` / `resume()` await the adapter's `flush()` after the closing entry (`flush: 'auto'`, the default) — bounded by the run's time left (at least 1 s, at most 30 s): a flush that never settles is counted as a loss, never a run held open. With `{ sink: { adapter, flush: 'manual' } }`, call `await executor.flushRecord({ timeoutMs })` yourself — before a serverless freeze, say; it resolves `{ done, failed, pending }`, the `drainObservers` shape.

**Resume.** A same-executor resume continues the SAME root log (it is the same log in memory): the stored log gets a `resume` note naming the new leg's `runId`, then the leg's commits, then a second `closed` — the reader takes the closing entry that covers every commit. A fresh-executor resume opens a NEW root log under its own `runId`, with `resumedFrom` on its `opened` meta; chain the two with `timeTravel([paused, resumed])` as you would two live snapshots.

**What a JSON line keeps.** The file sink stores what `JSON.stringify` keeps: a `Date` becomes its ISO string, a `Map` an empty object, `undefined` disappears. A record of plain JSON values reads back exactly; for richer values, bring an adapter with a richer encoding.

Worked example: [`examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts`](../../examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts). The hard-kill proof — a real process killed with SIGKILL during attempt 2 — is `test/lib/sinks/scenario/hard-kill.test.ts`.
### Side effects

A retry is free for a read. For a charge, an email or a write to another service it is a second charge — unless the outside system can tell a retry from a new request, by an **idempotency key**. And a charge that timed out is the worst case: nobody knows whether it went through, so "it failed, try again" is exactly the wrong conclusion. So a stage that changes an outside system declares it:

```typescript
import { flowChart, FlowChartExecutor, type TypedScope, UnknownEffectError } from 'footprintjs';

interface Order { chargeId?: string }

// Local payments fixture: the same key twice is one charge.
const charges = new Map<string, string>();
const payments = {
  charge: async (key: string) => charges.get(key) ?? (charges.set(key, `ch_${charges.size + 1}`), charges.get(key)!),
};

const chart = flowChart<Order>('Load order', () => undefined, 'load')
  .addFunction(
    'Charge card',
    async (scope: TypedScope<Order>) => {
      const { idempotencyKey } = scope.$attempt();
      scope.chargeId = await payments.charge(idempotencyKey as string);
    },
    'charge',
  )
  .touches('payments', { idempotencyKey: ({ args }) => `order-${(args as { orderId: string }).orderId}` })
  .retry({ attempts: 3, timeoutMs: 20_000 })
  .build();

const executor = new FlowChartExecutor(chart);
try {
  await executor.run({ input: { orderId: '77' } });
} catch (error) {
  if (error instanceof UnknownEffectError) {
    // Reconcile: look the operation up by error.idempotencyKey before trying again.
  }
}
```

| What | How |
|---|---|
| **The build law** | A stage that `touches` a system and may retry (`attempts > 1`, in either order of `.touches()` and `.retry()`, at every declaration site) must declare a key rule — refused at build otherwise. A StageNode a stage returns at run time, and a chart edited after `build()`, are held to the same rule: the stage fails before anything is sent. There is no library-made default key: the run id changes across a resume and a caller's whole-run retry, exactly where a double charge happens. |
| **The key** | The rule runs ONCE per execution (not per attempt), before attempt 1, with `{ args, getState, runId, runtimeStageId }`; every attempt gets the same key as `scope.$attempt().idempotencyKey` — pass it to the system. Make it name the OPERATION — from the input (`order-${args.orderId}`) or from state (`getState('orderId')`) — never `runId` alone and never something a model wrote. **Across a resume:** a paused touching stage resumes under the key its checkpoint carries (`checkpoint.idempotencyKey`, a real value like `sharedState`), never a recomputed one. The run's input does not cross a resume, so a rule that reads `args` on a resumed leg's root throws and the stage fails before sending — keep the key in state for a chart that pauses. A stage that `interrupt()`s is re-run from its top by `resume()`, so a keyless touching stage may not interrupt (its interrupt fails the stage, and a checkpoint of one is refused at `resume()`). It must be 1–255 printable ASCII characters with no space (it travels in a request header); otherwise the stage fails with a `TypeError` that never echoes it. A rule that throws fails the stage with its error, before any attempt. |
| **`effect` on each attempt** | `'applied'` for an attempt that answered; `'none'` for a failure whose error itself declares `effect: 'none'` (the adapter's word: nothing was sent); `'unknown'` for anything else — a timeout, a cancellation, a pause, or a failure the adapter did not mark. The record also names the `system` and the key. The narrative says it: `Attempt 2 of 2 at Charge card timed out after 20s, effect on payments unknown; stopped: no attempts left.` |
| **An unknown effect** | When ANY attempt left the effect unknown and the series stops without an answer, the stage fails with `UnknownEffectError { system, idempotencyKey, attempts, cause }` — never the attempt's own error (a later `effect: 'none'` speaks for its own attempt only), so nothing downstream reads "failed" and retries blindly. `cause` is the last attempt's own error. A pause stays a pause. A touching stage always runs on the attempt runner, so even a lone attempt with no policy is recorded (and a lone failure is unknown too: it may have sent the request). |
| **Redaction** | The key is a value. The records, the hook and `UnknownEffectError` carry it retained as the diagnostic entry `{ idempotencyKey }`: `keys: ['idempotencyKey']` or `diagnostics: { keys: ['logs.idempotencyKey'] }` scrub it everywhere the library serves it — and so does any rule that selects a value the key may be made of: a key derived from an input that holds a selected key, or built by a stage after it read a selected value, is served as the placeholder. Then `UnknownEffectError.idempotencyKey` is the placeholder too: recompute the key from the input you gave to reconcile. The stage itself always gets the real key. The decision evidence never holds it — only `keyPresent`. |
| **`$call`** | The same law inside a stage: `scope.$call(target, fn, policy, { touches: 'payments', idempotencyKey: key })`. A touching call that may retry without a key — or a key without `touches`, or a malformed key — throws at the call, before anything is sent. The call's function gets the key as `t.idempotencyKey`; each record carries its `effect`; an unknown last attempt rejects with `UnknownEffectError`. |
| **The spec** | `touches: 'payments'` on the node — the name only; the key rule is a function and stays on the chart. |

Worked example: [`examples/runtime-features/retry/04-side-effects-and-idempotency.ts`](../../examples/runtime-features/retry/04-side-effects-and-idempotency.ts).

### Where you declare it

`.retry(policy)` applies to the stage you just added. Where the cursor would be ambiguous, the policy goes in that method's own option bag:

| Stage | How |
|---|---|
| `start()` / `addFunction()` / `addStreamingFunction()` / `addPausableFunction()` | `.retry(policy)` chained after it |
| The chart's first stage | `flowChart(name, fn, id, { retry })` |
| `addDeciderFunction()` / `addSelectorFunction()` | `options.retry` (these return a sub-builder, so a chained `.retry()` could mean the decider *or* the branch just added) |
| `addFunctionBranch()` / `addPausableFunctionBranch()` | `options.retry` |
| `addListOfFunction()` fork children | the child's `retry` field |

The builder **refuses** `.retry()` where it could never fire or could silently hit the wrong stage: on a subflow mount (declare it on the stages *inside* the subflow), on a `addParallelForEach` fan-out (declare it inside the branch chart), on a loop reference, twice on one stage, and directly after a subflow mount or `addListOfFunction` — those attach children without moving the cursor, so the policy would land on the stage *before* what you just wrote.

It also refuses a policy whose `attempts` is not a whole number ≥ 1 — `0`, `2.5`, `NaN`, `Infinity`. A StageNode a stage *returns* at run time is held to the same rule, in the same words: the returning stage fails on its error path, before the node runs.

### Scope of this release

- **Backoff is a plain awaited timer**, cancelled by the run's `AbortSignal`. It is not a pause: a chart **cannot be checkpointed in the middle of a backoff**.
- **A resumed stage.** After `interrupt()`, resume re-runs the stage's own function and the policy comes with it. After an `addPausableFunction` pause, resume runs `resumeFn` — a different function under a different contract — **without** the policy.
- **A timeout cannot stop the function's own work.** See "Time budget" above: the cap ends the waiting and fences the attempt's scope; pass `scope.$attempt().signal` on so the work stops too.
- Each attempt gets a **fresh scope**, which is what makes attempt isolation real. So scope-channel `onStageStart` fires **once per attempt**, and `onStageEnd` fires only for an attempt whose function returned — the same shape a failing stage already has today. Nothing is hidden.

Worked examples: [`examples/runtime-features/retry/`](../../examples/runtime-features/retry/) — `01-declare-a-retry.ts` (the evidence: the attempt records, the hook, the narrative), `02-attempt-isolation-and-limits.ts` (the two safety rules, and the arithmetic), `03-deadline-and-timeout.ts` (the time budget), `04-side-effects-and-idempotency.ts` (`.touches()`, the key, `effect`) and `05-attempts-inside-a-stage.ts` (`$call`, `observed()` and `attempt()`).

---

## Error Narrative

A validation pipeline fails. The trace tells the story:

```
Stage 1: The process began with FetchData.
  Step 1: Write rawPayload = {name: "Bob", age: -5}
Stage 2: Next, it moved on to Validate.
  Step 1: Read rawPayload = {name: "Bob", age: -5}
  An error occurred at Validate: Validation failed: age must be positive.
```

An LLM reading this trace can immediately explain: *"The validation failed because the age field was -5, which was provided in the raw payload from FetchData. Age must be a positive number."* No log reconstruction needed.

---

## Structured Error Preservation

By default, errors flow through the trace system as structured objects — not flat strings. When a stage throws an `InputValidationError`, the field-level `.issues` are preserved all the way to FlowRecorders and the narrative output.

### How It Works

When a stage throws, the engine:
1. Calls `extractErrorInfo(error)` to build a `StructuredErrorInfo`
2. Attaches it to the `FlowErrorEvent` as `structuredError`
3. Dispatches to all FlowRecorders with the full structured data

```typescript
import {
  flowChart,
  FlowChartExecutor,
  type FlowRecorder,
  type FlowErrorEvent,
  InputValidationError,
} from 'footprintjs';

// A custom recorder that uses structured error details
const errorObserver: FlowRecorder = {
  id: 'error-observer',
  onError(event: FlowErrorEvent) {
    console.log(`Stage: ${event.stageName}`);
    console.log(`Message: ${event.message}`);

    // Access structured details — no string parsing needed
    if (event.structuredError?.issues) {
      for (const issue of event.structuredError.issues) {
        console.log(`  Field: ${issue.path.join('.')} — ${issue.message}`);
      }
    }
  },
};

const chart = flowChart('Validate', () => {
  throw new InputValidationError('Validation failed', [{ path: ['age'], message: 'Must be positive' }]);
}, 'validate').build();
const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(errorObserver);
await executor.run().catch(() => undefined);
```

### StructuredErrorInfo

```typescript
interface StructuredErrorInfo {
  message: string;             // Human-readable error message
  name?: string;               // Error class name (e.g. 'InputValidationError')
  issues?: ValidationIssue[];  // Field-level validation issues
  code?: string;               // Machine-readable code (e.g. 'INPUT_VALIDATION_ERROR', 'ENOENT')
  raw: unknown;                // Original error object
}
```

The `extractErrorInfo()` and `formatErrorInfo()` utilities are available as public API exports for use in custom recorders or error handling logic.

### Narrative Enrichment

When an `InputValidationError` is thrown, the default `NarrativeFlowRecorder` enriches the error sentence with field-level details:

```
An error occurred at Validate: Validation failed. Validation issues: email: Required; age: Must be positive.
```

Standard `Error` objects produce the same narrative as before — no regression.

---

## Recorder Error Isolation

Recorders observe scope operations. If a recorder throws, the error is caught and forwarded to `onError` hooks of other recorders. The scope operation continues normally. Recorders can never break execution.

This is tested with up to 50 concurrent recorders (25 throwing + 25 normal) — execution always continues.

---

## Debug Recorder

The `DebugRecorder` observes the scope channel: scope-operation errors, plus
mutations, reads, and lifecycle events in verbose mode. A stage function's thrown
error belongs to the flow channel; use the structured flow-error observer above
to capture it. The debug entries can still show the writes that preceded it:

```typescript
import { flowChart, DebugRecorder, FlowChartExecutor } from 'footprintjs';

const chart = flowChart<{ age: number }>('Validate', (scope) => {
  scope.age = -5;
  throw new Error('age must be positive');
}, 'validate').build();
const debug = new DebugRecorder({ verbosity: 'verbose' });
const executor = new FlowChartExecutor(chart);
executor.attachScopeRecorder(debug);
await executor.run().catch(() => undefined);

// After execution:
const entries = debug.getEntries();
console.log(entries.map(({ type, stageName }) => ({ type, stageName })));
// [
//   { type: 'stageStart', stageName: 'Validate' },
//   { type: 'write', stageName: 'Validate' },
// ]
// The write entry's data includes { key: 'age', value: -5 }.
// No debug 'error' entry is emitted for this thrown stage error.
```

### Mermaid Diagrams

The builder can generate Mermaid flowchart diagrams for visualization. `toMermaid()`
lives on the **builder**, so call it before `build()` (the compiled chart returned by
`build()` has no `toMermaid`):

```typescript
const builder = flowChart('A', fnA, 'a')
  .addFunction('B', fnB, 'b')
  .addDeciderFunction('Route', routeFn, 'route')
    .addFunctionBranch('x', 'X', xFn)
    .addFunctionBranch('y', 'Y', yFn)
    .end();

console.log(builder.toMermaid());
// flowchart TD
//   a["A"]
//   a --> b
//   b["B"]
//   b --> route
//   route["Route"]
//   route --> x
//   x["X"]
//   route --> y
//   y["Y"]

const chart = builder.build();
```

---

## Parallel Fan-Out Error Semantics

When a stage fans out into several children that run **in parallel**, one child
throwing has two possible meanings. footprintjs lets you pick which:

| Mode | Underlying primitive | What a child error does | Use when |
|------|---------------------|-------------------------|----------|
| **DEFAULT** (best-effort) | `Promise.allSettled` | Collected, **NOT** rethrown. Every sibling still runs to completion; the run **resolves** and continues past the fan-out. | Children are independent and partial success is acceptable (e.g. best-effort enrichment, parallel tool calls where some may fail). |
| **`failFast: true`** | `Promise.all` | The **first** error **rejects the whole run** (aborts). Siblings already in flight are abandoned. | Every selected child is **REQUIRED** — if one fails the result is meaningless (e.g. assembling an LLM request from system-prompt + messages + tools slots). |

### The footgun this prevents

Under the default, a **required** parallel branch that throws is **silently
swallowed** — the run resolves "successfully" with a half-built result. This is
easy to miss because the error never surfaces as a rejection. If all selected
branches must succeed, set `failFast: true` so the failure propagates.

### Where to set it

`failFast` lives on the **fan-out node** and is honored by every parallel
surface — plain-function branches, **subflow** branches, and bare parallel
lists alike:

```typescript
// Root selector (flowChartSelector) — required slots assembled into one request
flowChartSelector('Pick', selectorFn, 'pick', { failFast: true })
  .addSubFlowChartBranch('sf-system-prompt', sysSlot, 'System Prompt')
  .addSubFlowChartBranch('sf-messages', msgSlot, 'Messages')
  .addSubFlowChartBranch('sf-tools', toolsSlot, 'Tools')
  .end()
  .addFunction('messageAPI', assembleFn, 'message-api') // only runs if ALL slots succeeded
  .build();

// Mid-chain selector (addSelectorFunction) — 5th arg is the options bag
builder.addSelectorFunction('Pick', selectorFn, 'pick', 'Route', { failFast: true });

// Bare parallel list (addListOfFunction)
builder.addListOfFunction([{ id: 'a', name: 'A', fn: aFn }, { id: 'b', name: 'B', fn: bFn }], { failFast: true });
```

`failFast` defaults to `false` (best-effort) everywhere, so existing charts keep
their current behavior. See `examples/runtime-features/parallel/` and
`test/lib/builder/unit/selector-failfast.test.ts`.

### Interaction with `$break` propagation

`failFast` (a branch *threw*) is distinct from `$break` (a branch *chose* to
stop). For a fan-out, the existing break rule still applies: the parent breaks
only when **all** fork children broke. See **Break + Propagation** in the
architecture notes.

---

## What Consumers Can Do After Failure

- **Retry with modifications** — Inspect the snapshot, fix inputs, re-run
- **Partial results** — Fork children that succeed still return results (default mode)
- **Fail-fast** — Opt into `failFast: true` when any child error should abort the whole fork
- **Timeout/cancel** — Use `timeoutMs` or `AbortSignal` for external cancellation
- **Post-mortem** — Feed the narrative + snapshot to an LLM for root-cause analysis

---

For architecture details, see [src/lib/engine/README.md](../../src/lib/engine/README.md) and [src/lib/memory/README.md](../../src/lib/memory/README.md).
