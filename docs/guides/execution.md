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

---

## Comparison

| Mechanism | Trigger | Stage completes? | Returns |
|-----------|---------|-----------------|---------|
| `breakFn()` | Inside stage | Yes | Stage output (no error) |
| `throw` | Inside stage | No | Error propagates |
| `AbortSignal` | Outside pipeline | Races async | Error propagates |

---

## Fail-Fast Forks

By default, parallel children run to completion even if some fail (errors captured as `{ isError: true }`). For cases where you want immediate failure:

```typescript
flowChart('Fetch', fetchFn)
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
flowChart('Init', initFn)
  .addFunction('Retry', retryFn, 'retry')
  .addDeciderFunction('Check', checkFn)
    .addFunctionBranch('again', 'Process', processFn)
    .addFunctionBranch('done', 'Finish', finishFn)
    .end()
  .loopTo('retry')
  .build();
```

---

For architecture details, see [src/lib/engine/README.md](../../src/lib/engine/README.md).
