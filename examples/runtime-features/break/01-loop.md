---
name: Break (Loop Exit)
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/patterns/loops-and-retry/
---

# $break — Stop Cleanly, Any Stage

`scope.$break()` tells the engine *"I'm done — commit what I wrote, then stop."* It's the clean way to exit a loop, short-circuit a pipeline, or end a terminal branch.

```
Init → FetchPage ← ── loop ──┐
         │                    │
         ├── more pages ─────┘
         └── empty page → $break() → (done)
```

## When to use

- **Pagination** — fetch pages until one returns empty.
- **Retry loops** — stop once the request succeeds.
- **Terminal branches** in a decider — "we've rejected this, don't run the rest of the pipeline."
- **Early-exit validation** — first failure halts the flow, narrative records why.

## The contract

| Behavior | What happens |
|---|---|
| Writes in the current stage | ✅ Committed before exit |
| Subsequent stages | ❌ Skipped |
| Loop back-edge (`loopTo`) | ❌ Not followed |
| Narrative | Records the break event with the stage name |

`$break()` is **not** an exception. It's a clean signal — no try/catch needed, no error handling concerns.

## The pattern

```typescript
.addFunction('FetchPage', async (scope) => {
  const items = await api.fetch(scope.page);
  scope.allItems = [...scope.allItems, ...items];
  scope.page += 1;

  if (items.length === 0) {
    scope.$break();   // ← stop the loop
  }
})
.loopTo('fetch-page')
```

The `$break()` call returns normally. Any writes after it in the same stage still execute — but the loop back-edge is suppressed.

## Break scope

`$break()` stops execution at the **current traversal level**:

| Inside | Stops |
|---|---|
| A top-level loop | The whole chart |
| A subflow | Just the subflow — parent continues |
| A decider branch | The chart (if not in a subflow) |
| A fork branch | Just that branch — siblings complete |

This means you can safely use `$break` inside a subflow without affecting the parent flow. **See the Break → Subflow Scoped sample** for a demonstration.

## What you'll see in the trace

```
Stage 1: Init
Stage 2: FetchPage  (iteration 1)
  Step 1: Write allItems = [a, b, c]
  Step 2: Write page = 1
Stage 3: FetchPage  (iteration 2)
  Step 1: Write allItems = [a, b, c, d, e]
  Step 2: Write page = 2
Stage 4: FetchPage  (iteration 3)
  Step 1: Write allItems unchanged
  Step 2: Write page = 3
  Execution stopped due to break.
```

The iteration count, the final writes, and the break event are all visible. Debugging a broken loop is no harder than debugging a linear chain.

## Key API

- `scope.$break()` — signal exit. Call from any stage function.
- Works inside: regular stages, decider/selector branches, subflow stages.
- Does NOT work across the flowchart `run()` boundary — to stop a run from outside, use `AbortSignal` via `run({ env: { signal } })`.

## Related

- **[Loops](../../building-blocks/06-loops.md)** — the primitive `$break` partners with.
- **[Break → Subflow](./02-subflow.md)** — how `$break` behaves inside a mounted subflow.
- **[Pause / Resume](../pause-resume/01-linear.md)** — the other way to "stop" execution (temporarily, with a checkpoint).
