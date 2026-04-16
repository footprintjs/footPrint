---
name: Loops
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/patterns/loops-and-retry/
---

# Loops (loopTo + $break)

A **loop** jumps execution back to an earlier stage, repeating the intervening stages until a break condition is met.

```
CallAPI ◀───┐
    │       │  (loop back with backoff)
    ▼       │
EvaluateResult ──── $break on success or max attempts
    │
    ▼
Done
```

## When to use

- **Retries with backoff** — unstable APIs, rate-limited services, transient failures.
- **Polling** — wait for a job to finish, a webhook to arrive, a file to land.
- **Agent loops** — call LLM → check if done → call again. (This is the core of the ReAct pattern.)
- **Iterative refinement** — improve a result until it's "good enough."

## The pattern

```typescript
.addFunction('CallAPI', async (scope) => {
  try {
    scope.result = await fetchData();
    scope.success = true;
  } catch (e) {
    scope.attempt++;
    scope.lastError = e.message;
  }
})
.addFunction('EvaluateResult', (scope) => {
  if (scope.success || scope.attempt >= scope.maxAttempts) {
    scope.$break();  // exit the loop
  }
  // else: fall through, and loopTo will send us back to CallAPI
})
.loopTo('call-api')   // back edge
```

Two pieces work together:
- **`.loopTo(stageId)`** — defines the back-edge. When execution reaches this point, it jumps to the named stage instead of continuing forward.
- **`scope.$break()`** — signals "stop looping." Without this, the loop would run forever (but footprintjs has an iteration limit for safety).

## Loops and state

Every iteration shares the **same scope**. Use this to accumulate:

```typescript
scope.attempt++;           // counter across iterations
scope.history.push(...);    // batch of results over time
scope.bestSoFar = ...;      // running best
```

The narrative shows each iteration clearly:
```
Iteration 1: CallAPI failed (Service unavailable)
Iteration 2: CallAPI failed (Service unavailable)
Iteration 3: CallAPI succeeded (tempC=22)
  → Breaking loop
```

## Safety rails

- **Iteration limit** — footprintjs caps loops at a configurable max (default generous but finite). Prevents runaway loops from hanging production.
- **Narrative captures each iteration** — so debugging a loop is no harder than debugging a linear flow.
- **`attempt` counter pattern** — convention, not requirement. Explicit and auditable.

## Key API

- `.loopTo('stage-id')` — back-edge to a prior stage.
- `scope.$break()` — signal loop exit from inside any stage.
- `scope.attempt` / `scope.maxAttempts` — convention for bounded retries.

## Related concepts

- **[Linear](./01-linear.md)** — the baseline flow without back-edges.
- **[Pause/Resume](../runtime-features/pause-resume/)** — when you need to wait on external input between iterations.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/patterns/loops-and-retry/)** — retry patterns, backoff, polling, and iteration limits.
