---
name: Fork (Parallel)
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/building-blocks/stages/
---

# Fork (Parallel Branches)

A **fork** runs multiple stages **at the same time**, waits for all of them to finish, then continues.

```
              ┌── CheckInventory ──┐
LoadOrder ───┤                     ├── FinalizeOrder
              └── RunFraudCheck ───┘
```

## When to use

- The parallel stages are **independent** — they don't depend on each other's output.
- Running them serially would be wasteful (e.g., two API calls that could happen in parallel).
- Common examples: **enrichment** (fetch multiple facets concurrently), **verification** (inventory + fraud + credit checks), **analytics** (compute several metrics at once).

## Fork vs Selector vs Decider

| | Fork | Selector | Decider |
|---|---|---|---|
| Branches run | **All** | Some (filter-picked) | **One** |
| Inputs | Same scope | Same scope | Same scope |
| Outputs | Merge back | Merge back | Single winner |
| Waits for | All to finish | All matched to finish | The chosen one |

Think of it as the parallelism spectrum: Fork (always all) → Selector (picks many) → Decider (picks one).

## What you'll see in the trace

```
Stage 1: LoadOrder (done)
↓ Forking into 2 parallel branches
  Stage 2a: CheckInventory (running)
  Stage 2b: RunFraudCheck (running)
  Stage 2a: CheckInventory (done, 340ms)
  Stage 2b: RunFraudCheck (done, 510ms)
↓ Fork joined (waited 510ms for slowest)
Stage 3: FinalizeOrder
```

The narrative distinguishes which writes came from which branch — no guessing who wrote what.

## Gotcha: shared scope, race conditions

Parallel stages **share the same scope**. If two branches write to the same key, the last one wins — and that's non-deterministic. Solution:

- Use **distinct keys** per branch (`inStock`, `fraudCleared`) — not overlapping ones.
- Or use **separate subflows** with `outputMapper` if you need full isolation.

footprintjs captures all writes in the commit log, so you can audit after the fact — but avoiding the race upfront is cleaner.

## Key API

- `.addFunction(...)` followed by `.addFork(...)` — mount a fork.
- Each branch runs to completion; `scope.$break()` in one branch does **not** cancel the others.

## Related concepts

- **[Selector](./04-selector.md)** — filtered parallel: only matching branches run.
- **[Decider](./03-decider.md)** — exclusive branching: exactly one branch runs.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/stages/)** — covers fork, decider, selector, and the scope contract.
