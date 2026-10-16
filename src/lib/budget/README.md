# budget/

The static time budget: how long a BUILT chart can take, read from the retry policies it declares — before a single stage runs (design `docs/design/2026-10-time-and-failure-evidence.md` §3.2, packet P5).

| File | One job |
|---|---|
| `timeBudget.ts` | `timeBudget(chart, options?)` — the walk and the report; `budgetRefusal` / `budgetWarning` (the builder's words at `build()`); `warnDeadlineUnderBudget` (the executor's run-start warning) |
| `index.ts` | the barrel |

## Why it exists

A retry policy is a promise about time. `{ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 }` allows 4 × 40 000 + 3 × 1 000 = 163 000 ms. A caller who gave the request 120 s is not served by it, and both numbers are declared, so the mismatch is a bug the author can fix while writing the chart. `.budget(ms)` declares the caller's contract; `build()` refuses a chart whose declared policies already allow longer.

```typescript
import { flowChart, timeBudget } from 'footprintjs';

const chart = flowChart('Read', () => undefined, 'read', { retry: { attempts: 1, timeoutMs: 5_000 } })
  .addFunction('Charge', () => undefined, 'charge')
  .retry({ attempts: 3, timeoutMs: 20_000, backoffMs: 1_000 })
  .budget(120_000) // checked at build(): 5 000 + 3 × 20 000 + 2 × 1 000 = 67 000 ms — kept
  .build();

const report = timeBudget(chart); // also chart.timeBudget()
report.worstCaseMs; // 67000 — or null when a path is unbounded
report.criticalPath; // [{ stageId: 'read', … }, { stageId: 'charge', attempts: 3, timeoutMs: 20000, backoffMs: 2000, worstMs: 62000, passes: 1 }]
report.unbounded; // [] — or [{ stageId, why }] for every stage it cannot bound
```

## The rules

- **One walk, each chain once per start.** The walk reads the built `StageNode` graph. A run of `next` pointers (a chain) is computed once per start node, however often its subflow is mounted. Nesting uses an explicit stack, never recursion, so a 5 000-deep subflow nesting walks. The walk is capped at `MAX_WALK` (250 000) node visits and stops with a `RangeError` past it: a builder chart visits each node at most twice, but a hand-built graph whose chains share their tails walks the shared tail once per chain.
- **A stage:** `attempts × timeoutMs` plus the waits between its attempts, as the runner waits them. A number `backoffMs` is arithmetic (under `maxBackoffMs` when declared; a non-finite or negative wait is 0). A FUNCTION `backoffMs` is never called: it may read the error, a stated `Retry-After`, and no error exists at build, so asking it with none could underestimate. It is counted at its declared ceiling, `maxBackoffMs` per wait, which the runner enforces (`attempt/policy.ts · cappedWaitMs`). With no ceiling the stage is unbounded (`backoff`) and its waits count 0. Without `timeoutMs` the stage is unbounded (`no-timeout`).
- **A mount** is decided as the engine decides it: a subflow root with a subflow id and no function of its own (`node.fn`) and no children. The stage map is never asked for a mount, so a mount named like another stage is still its subflow.
- **Shapes:** a sequence is the sum. A decider, a selector or a fork is its own stage plus its slowest child; fork children and a selector's picks run at once. A mounted subflow is walked under the ids the run gives its stages (`pay/charge`). A lazy subflow is unbounded (`lazy-subflow`) unless `assume.lazy[subflowId]` names its chart.
- **`parallelForEach`:** one branch. The branches run at once and `maxBranches` truncates, so the number of items never adds time. The branch chart is built at run time, so the stage is unbounded (`items`) unless `assume.branches[stageId]` names that chart. Its stages are then reported under the first branch (`review~0/score`).
- **A loop is never iterated.** With no assumption it is unbounded (`loop`, named by its target) and counted once. `assume.loops[targetId] = n` bounds it: each time the chart reaches the loop, every stage from the target to the loop's furthest source runs at most `n` times, each at its slowest. Nested loops multiply. Two loops that overlap without nesting form one region, bounded by the product of their passes, because each can re-enter the other. A property test checks the passes against a brute-force walk of every valid run. Two kinds of loop no assumption can bound, and they stay unbounded: an object cycle in a hand-built graph (through a `next`, a child or a subflow that mounts itself), and a loop to a target its chart does not hold.
- **Two numbers.** `knownMs` counts what is bounded: an unbounded stage counts as 0, and a loop with no assumption counts once. Without assumptions it is a time the declared policies ALLOW a run to take (`retryOn` is not read; it may only stop a series sooner), so a budget below it cannot be promised. `over` and the build refusal read it, on an unbounded path too. `worstCaseMs` equals `knownMs` when every path is bounded and is `null` otherwise. With an assumed loop it is an upper bound under that assumption.
- **Saturation.** Sums and products stop at `Number.MAX_SAFE_INTEGER`, so the result is never `Infinity` or `NaN`, and the report is JSON-safe and frozen. A budget must be at most `Number.MAX_SAFE_INTEGER` for the same reason: a larger one could never be exceeded.
- **Assumptions are read once.** Each own enumerable key is copied into a fresh null-prototype record and validated; the walk reads only the copy. So a prototype member, a non-enumerable key, a getter that changes between reads, or a Proxy can never hand the walk an unvalidated value. A loop count must be a whole number ≥ 1, and an assumed chart must be a built chart; anything else is a `TypeError`.

## What it does not count

- The engine's own work between stages.
- A stage function that blocks the thread: a timeout stops the WAITING, see `attempt/README.md`.
- A StageNode a stage returns at run time. Any stage may grow the graph this way, so the budget covers the graph the chart DECLARES.

## Who reads it

- The builder: `FlowChartBuilder · budget` puts `budgetMs` on the spec root, and `applyRetryPolicy` puts `timeoutMs` beside `retryAttempts`. `build()` refuses through `budgetRefusal` when `knownMs > budgetMs`. In dev mode it warns through `budgetWarning`, naming every stage it cannot bound.
- The runner: `RunnableChart · makeRunnable` gives the built chart `timeBudget(options?)`. `FlowChartExecutor · run` calls `warnDeadlineUnderBudget`, a dev-mode warning given once per chart when the run's deadline leaves less time than the declared budget.

Layer: L7. It is its own module, not part of `builder/`, because both sides consume it. A `runner → builder` edge would close the builder ⇄ runner module cycle (`scripts/layering.config.cjs`).
