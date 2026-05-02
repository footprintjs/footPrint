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
import { microtaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

let handles: DetachHandle[] = [];

.addFunction('Fanout', async (scope) => {
  for (const variant of scope.variants) {
    handles.push(scope.$detachAndJoinLater(microtaskBatchDriver, variantChart, variant));
  }
})
.addFunction('Join', async (scope) => {
  const results = await Promise.all(handles.map((h) => h.wait()));
  scope.bestVariant = pickBest(results);
})
```

> ⚠️  Keep handles in a closure-local variable, **not** in scope state.
> `executor.getSnapshot()` JSON-serializes shared state and would strip
> the handle's `wait()` method.
