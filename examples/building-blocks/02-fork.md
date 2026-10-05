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
| Inputs | Read parent state | Read parent state | Read parent state |
| Outputs | Plain child writes under `runs/<childId>` | Plain child writes under `runs/<childId>` | One chosen branch |
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

## Reading branch results

Plain fork children can read the parent's values, but each child's writes land under its own `runs/<childId>` namespace. After the join, `scope.inStock` does not read the inventory branch's result. Read the branch path explicitly:

```typescript
const inStock = scope.$read('runs.CheckInventory.inStock');
const fraudCleared = scope.$read('runs.RunFraudCheck.fraudCleared');
const status = inStock === true && fraudCleared === true ? 'confirmed' : 'held-for-review';
```

Sibling typed writes to the same field name stay in separate branch namespaces. Do not mutate borrowed parent objects in place. For isolated child charts with explicit parent outputs, use subflows with `outputMapper`; avoid having their mappers overwrite the same parent key.

The runnable example checks that `ORD-001` is `confirmed` and throws if that result changes. `npm run test:examples` type-checks the examples, builds the package, and runs this fork example as a runtime regression check. Other examples are not automatically executed by that command.

## Key API

- `.addFunction(...)` followed by `.addListOfFunction([{ id, name, fn }, ...])` — mount a parallel fork.
- Each branch runs to completion; `scope.$break()` in one branch does **not** cancel the others.

## Related concepts

- **[Selector](./04-selector.md)** — filtered parallel: only matching branches run.
- **[Decider](./03-decider.md)** — exclusive branching: exactly one branch runs.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/stages/)** — covers fork, decider, selector, and the scope contract.
