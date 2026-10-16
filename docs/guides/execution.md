# Execution Control

FootPrint provides three mechanisms for controlling pipeline execution: `breakFn`, exceptions, and external cancellation.

---

## breakFn — Graceful Early Termination

Every stage receives `(scope, breakFn)`. Calling `breakFn()` completes the current stage normally, then skips all remaining stages.

```typescript
const validateInput = async (scope: ScopeFacade, breakFn: () => void) => {
  const amount = scope.getValue('loanAmount') as number;
  if (amount > 50_000) {
    scope.setValue('rejection', 'Exceeds maximum loan amount');
    breakFn();  // stage output is committed, pipeline stops — no error
  }
};
```

Use cases:
- Validation gates that reject early
- Budget or quota limits
- Conditional short-circuits where remaining stages are unnecessary

---

## Throwing — Hard Abort

Throwing from a stage immediately aborts execution. The engine commits the trace (including partial writes from the failing stage) before re-throwing. See [Error Handling](./error-handling.md) for details.

```typescript
const callExternalAPI = async (scope: ScopeFacade) => {
  const response = await fetch(scope.getValue('apiUrl') as string);
  if (response.status === 403) {
    throw new Error('Access denied — cannot continue');
  }
};
```

---

## Cancellation & Timeout

For LLM pipelines where API calls can hang, `FlowChartExecutor.run()` supports cooperative cancellation:

### Timeout

Auto-abort after a duration:

```typescript
const result = await executor.run({ timeoutMs: 30_000 });
```

### AbortSignal

Cancel from outside:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);

const result = await executor.run({ signal: controller.signal });
```

The signal is checked before each stage starts and raced against async stage functions. Aborted executions throw with the signal's reason.

`env.signal` is honoured the same way (10.1 — it used to be readable only). A run that has a `signal`, an `env.signal` and a deadline composes them into ONE signal; a stage reads that one on `scope.$getEnv().signal` whenever the run has an env.

### Deadline

A timeout is a deadline in disguise. Give the run one, either way:

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart('Work', () => undefined, 'work').build();
const executor = new FlowChartExecutor(chart);

await executor.run({ deadline: Date.now() + 120_000 }); // epoch milliseconds
await executor.run({ timeoutMs: 120_000 }); // the same deadline, relative
```

| | |
|---|---|
| **Both given** | The earlier wins (and so does an `env.deadline` you pass, if it is earlier still). `timeoutMs` is honoured beside a `signal` too. |
| **What stages see** | `scope.$getEnv().deadline` (epoch ms), and `scope.$attempt().timeLeftMs()` — reading the time marks the stage's commit `untrackedSources: ['env']`. Subflows inherit it. |
| **When it passes** | The run's signal aborts, and `run()` rejects with `Execution timed out after <timeoutMs>ms` (or `Execution passed its deadline …`). A deadline already past stops the run before its first stage. |
| **The record** | Every stage of a run with a deadline records its attempt on its execution-tree node (`attempts`), so a stage the deadline cut short says so: `outcome: 'timeout'`. A retried stage never starts a wait the deadline would cut: it stops `no-time-left`. |
| **Pause and resume** | The deadline is per leg, like the loop budget: the checkpoint does not carry it. Pass a fresh one to `resume(checkpoint, input, { deadline })`. |

A deadline is not a cancellation: an attempt it ends **timed out** (it had no answer in the time it had); `aborted` stays the word for a run you cancelled. To cap a single stage's attempt, use `RetryPolicy.timeoutMs` — see [Error handling → Time budget](./error-handling.md#time-budget).

---

## Comparison

| Mechanism | Trigger | Stage completes? | Returns |
|-----------|---------|-----------------|---------|
| `breakFn()` | Inside stage | Yes | Stage output (no error) |
| `throw` | Inside stage | No | Error propagates |
| `AbortSignal` | Outside pipeline | Races async | Error propagates |
| `deadline` / `timeoutMs` | The clock | Races async | Error propagates; the cut stage's attempt says `timeout` |

---

## Fail-Fast Forks

By default, parallel children run to completion even if some fail (errors captured as `{ isError: true }`). For cases where you want immediate failure:

```typescript
flowChart('Fetch', fetchFn, 'fetch')
  .addListOfFunction([
    { id: 'api1', name: 'CallAPI1', fn: api1Fn },
    { id: 'api2', name: 'CallAPI2', fn: api2Fn },
  ], { failFast: true })  // first child error rejects the whole fork
  .build();
```

---

## Loops and Iteration Limits

The engine tracks iteration count per node. Default maximum is 1000 iterations per back-edge to prevent infinite loops from user code.

```typescript
flowChart('Init', initFn, 'init')
  .addFunction('Retry', retryFn, 'retry')
  .addDeciderFunction('Check', checkFn, 'check')
    .addFunctionBranch('again', 'Process', processFn)
    .addFunctionBranch('done', 'Finish', finishFn)
    .end()
  .loopTo('retry')
  .build();
```

---

For architecture details, see [src/lib/engine/README.md](../../src/lib/engine/README.md).
