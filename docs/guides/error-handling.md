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
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart<QuoteState>('Read request', readFn, 'read-request')
  .addFunction('Fetch rate', fetchRateFn, 'fetch-rate')
  .retry({ attempts: 3, backoffMs: (attempt) => 100 * attempt })
  .addFunction('Build quote', buildQuoteFn, 'build-quote')
  .build();
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

Each failed attempt that is followed by another fires `FlowRecorder.onStageRetry`:

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

The narrative renders it **in order, inside the stage**, between the attempts' own reads and writes:

```
Stage 2: Ask the rate service for today's conversion rate.
  Step 1: Read currency = "EUR"
  [Retry]: attempt 1 of 3 at Fetch rate failed (rate service unavailable). Waited 100ms before the next attempt.
  Step 3: Read currency = "EUR"
  [Retry]: attempt 2 of 3 at Fetch rate failed (rate service unavailable). Waited 200ms before the next attempt.
  Step 5: Read currency = "EUR"
  Step 6: Write rate = 1.09
```

**The event arithmetic, stated exactly** — so you can count what you should be seeing:

| Outcome | `onStageRetry` events | `onError` events |
|---|---|---|
| Succeeds on the first try | 0 | 0 |
| Succeeds on attempt N | N − 1 | 0 |
| Exhausts the policy | `attempts` − 1 | 1 |
| `retryOn` declines | **0** | 1 |

A declining `retryOn` is simply the error path behaving as if no policy existed — there is no event for "the policy chose not to act", because the error event already says everything that happened.

### Deciding what is worth retrying

A timeout deserves another go. "Card declined" does not — retrying it wastes time and can double-charge.

```typescript
.retry({
  attempts: 5,
  retryOn: (error) => !(error instanceof DeclinedError),
})
```

A `retryOn` that **throws** is treated as "do not retry" — a broken predicate must never turn a failing stage into an endless loop.

### What is never retried

- **A pause.** Neither `addPausableFunction`'s pause nor `interrupt()` is a failure — both suspend the run, and retrying them would break resume.
- **A cancelled run.** An aborted `AbortSignal` ends the stage immediately; the run never sits through a backoff and then tries again.
- **`scope.$break()`.** Breaking is not an error.

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

### Scope of this release

- **Backoff is a plain awaited timer**, cancelled by the run's `AbortSignal`. It is not a pause: a chart **cannot be checkpointed in the middle of a backoff**.
- **A resumed stage.** After `interrupt()`, resume re-runs the stage's own function and the policy comes with it. After an `addPausableFunction` pause, resume runs `resumeFn` — a different function under a different contract — **without** the policy.
- **Per-stage timeouts are out of scope.** Use `RunOptions.timeoutMs` or an `AbortSignal` for deadlines.
- Each attempt gets a **fresh scope**, which is what makes attempt isolation real. So scope-channel `onStageStart` fires **once per attempt**, and `onStageEnd` fires only for an attempt whose function returned — the same shape a failing stage already has today. Nothing is hidden.

Worked examples: [`examples/runtime-features/retry/`](../../examples/runtime-features/retry/) — `01-declare-a-retry.ts` (the evidence) and `02-attempt-isolation-and-limits.ts` (the two safety rules).

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

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(errorObserver);
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

The `DebugRecorder` captures errors automatically and optionally captures mutations and reads:

```typescript
import { DebugRecorder, FlowChartExecutor } from 'footprintjs';

const debug = new DebugRecorder({ verbosity: 'verbose' });
const executor = new FlowChartExecutor(chart);
executor.attachScopeRecorder(debug);

// After execution:
const entries = debug.getEntries();
// [
//   { type: 'write', stageName: 'Validate', timestamp, data: { key: 'rawPayload', value: {...} } },
//   { type: 'error', stageName: 'Validate', timestamp, data: { error: Error(...) } },
//   ...
// ]
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
