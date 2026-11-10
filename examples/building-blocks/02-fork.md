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
| Outputs | Results from all children | Results from selected children | One chosen branch |
| Waits for | All to finish | All matched to finish | The chosen one |

Think of it as the parallelism spectrum: Fork (always all) → Selector (picks many) → Decider (picks one).

## What you'll see in the trace

```
Stage 1: The process began with LoadOrder.
Step 1: Write order = {customerId, items, amount}
Step 2: Write orderId = "ORD-001"
[Parallel]: Forking into 2 parallel paths: CheckInventory, RunFraudCheck.
Stage 2: Next, it moved on to RunFraudCheck.
Step 1: Read order = {customerId, items, amount}
Step 2: Write fraudScore = 0.05
Step 3: Write fraudCleared = true
Step 4: Write fraudFlags = []
Stage 3: Next, it moved on to CheckInventory.
Step 1: Read order = {customerId, items, amount}
Step 2: Write inStock = true
Step 3: Write warehouse = "WH-East"
Step 4: Write estimatedShip = "2-3 business days"
Stage 4: Next, it moved on to FinalizeOrder.
Step 1: Read runs = {RunFraudCheck, CheckInventory}
Step 2: Read runs = {RunFraudCheck, CheckInventory}
Step 3: Write orderStatus = "confirmed"
Step 4: Read orderId = "ORD-001"
```

The branches run in parallel, so they finish in whatever order their work takes: here the fraud check (20 ms) finishes before the inventory check (30 ms).

The narrative distinguishes which writes came from which branch — no guessing who wrote what.

## Reading branch results

In this top-level fork, the children can read the parent's values, but each child's writes land under its own `runs/<childId>` namespace. After the join, `scope.inStock` does not read the inventory branch's result. Read the branch path explicitly:

```typescript
const inStock = scope.$read('runs.CheckInventory.inStock');
const fraudCleared = scope.$read('runs.RunFraudCheck.fraudCleared');
const status = inStock === true && fraudCleared === true ? 'confirmed' : 'held-for-review';
```

Here, sibling typed writes to the same field name stay in separate branch namespaces. Nested forks can retain an enclosing branch namespace, so do not assume this separation for every nesting arrangement. Do not mutate borrowed parent objects in place. For isolated child charts with explicit parent outputs, use subflows with `outputMapper`; avoid having their mappers overwrite the same parent key.

The runnable example checks that `ORD-001` is `confirmed` and throws if that result changes. `npm run test:examples` type-checks the examples, builds the package, and runs this fork example as a runtime regression check. The same command runs a few other examples the same way (the tests listed in `vitest.built-package-tests.ts`); the rest are only type-checked.

## Key API

- `.addFunction(...)` followed by `.addListOfFunction([{ id, name, fn }, ...])` — mount a parallel fork.
- Each branch runs to completion; `scope.$break()` in one branch does **not** cancel the others.

## Related concepts

- **[Selector](./04-selector.md)** — filtered parallel: only matching branches run.
- **[Decider](./03-decider.md)** — exclusive branching: exactly one branch runs.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/stages/)** — covers fork, decider, selector, and the scope contract.
