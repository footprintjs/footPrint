---
name: Detach (Join-Later Fan-Out)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/detach/#fan-out
---

# `$detachAndJoinLater` — Parallel Sub-Evaluations

When you need to fire N children in parallel and gather all their results
later, `$detachAndJoinLater` returns a `DetachHandle` you can `wait()` on.
Combine many handles via `Promise.all` for fan-out.

```
ParentStage ─► detach config A ─┐
            └─► detach config B ─┼─► all queued microtasks flush
            └─► detach config C ─┘
                                  │
WaitStage ─► await Promise.all([A.wait(), B.wait(), C.wait()])
```

## When to use

- **Parallel evaluations.** Compare 5 prompt variants; pick the best.
- **Multi-vendor calls.** Hit OpenAI + Anthropic + Bedrock in parallel.
- **Backpressure.** "Don't run more than N at once" — keep handles in an
  array and drain when over budget.

## The contract

| Behavior                       | What happens                                          |
|--------------------------------|-------------------------------------------------------|
| `detachAndJoinLater` return    | A `DetachHandle` (sync, from the driver)              |
| `handle.status`                | Snaps from `queued` → `running` → `done` / `failed`   |
| `handle.wait()`                | Returns a CACHED Promise — same on every call         |
| `Promise.all([handles].wait()) | Resolves once every child terminal                    |

## The pattern

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { microtaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

// Deterministic local evaluator; replace with your model or vendor call.
const variantChart = flowChart('Evaluate', (scope) => {
  return scope.$getArgs<{ variant: string }>().variant.length;
}, 'evaluate').build();
interface State { variants: string[]; bestVariant: string }
const handles: DetachHandle[] = [];

const chart = flowChart<State>('Seed', (scope) => {
  scope.variants = ['brief', 'detailed', 'structured'];
}, 'seed')
.addFunction('Fanout', (scope) => {
  for (const variant of scope.variants) {
    handles.push(scope.$detachAndJoinLater(microtaskBatchDriver, variantChart, { variant }));
  }
}, 'fanout')
.addFunction('Join', async (scope) => {
  const results = await Promise.all(handles.map((h) => h.wait()));
  const scores = results.map(({ result }) => {
    if (typeof result !== 'number') throw new Error('Expected a numeric variant score');
    return result;
  });
  scope.bestVariant = scope.variants[scores.indexOf(Math.max(...scores))];
}, 'join')
.build();

await new FlowChartExecutor(chart).run();
```

> ⚠️  Keep handles in a closure-local variable, **not** in scope state.
> `executor.getSnapshot()` JSON-serializes shared state and would strip
> the handle's `wait()` method.

This is a single-run fixture. For concurrent requests, construct the chart and
its `handles` array inside a per-run factory.
