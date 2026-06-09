# Execution Model — the supported envelope

> **Like:** a rental car contract. The engine is happy to be driven hard — but
> here is what the warranty actually covers, in writing, so you find out from
> this page and not from a corrupted trace.

This page states footprintjs's *operating envelope* honestly: what one executor
is for, where the depth budget actually sits, what each read/write costs today,
and exactly what a pause checkpoint does and does not capture.

## One executor = one in-flight execution

`FlowChartExecutor` holds **per-run state on the instance** — the active
traverser, the `runId`, the execution counter, the last checkpoint — and
`run()` clears attached recorders when it starts. Two concurrent `run()` (or
`resume()`) calls on the same executor would interleave runIds and
cross-contaminate recorder/narrative state, so the executor **throws** on
concurrent entry:

```
FlowChartExecutor: run() called while another run()/resume() is in flight on
this executor. … create one executor per concurrent run.
```

**The server pattern:** build the chart once (module level — charts are
immutable), create a **fresh executor per request**:

```ts
const chart = flowChart(...).build();   // once

app.post('/run', async (req, res) => {
  const executor = new FlowChartExecutor(chart);   // per request
  res.json(await executor.run({ input: req.body }));
});
```

**Sequential reuse is fine** (run → run, run → pause → resume). After multiple
runs on one executor, the introspection getters — `getSnapshot()`,
`getCheckpoint()`, `getNarrativeEntries()` — are **last-run-wins**: they report
whichever run/resume most recently executed. There is no per-run handle today;
if you need to keep results from several runs, capture them after each run.

## Depth budget — what the 500 actually limits

The traverser executes stages by recursive `await`, so frames for linear
`next` hops and loop iterations **do not unwind** until the chain settles.
`MAX_EXECUTE_DEPTH = 500` caps the **longest chain within one traverser** —
not the whole run: every subflow mount gets a **fresh traverser with its own
depth counter**, and completed fork branches release their budget.

Practical consequences:

- A flat chart can execute at most ~500 chained stages/loop hops per
  traverser. Measured against agent-style loop charts: ≈ 7 frames per loop
  iteration → the wall sits around iteration 71 for a full-featured loop.
- The loop-iteration limit (default 1000, `ContinuationResolver`) is
  **independent of** the depth guard — for loop-heavy charts the depth guard
  fires first.
- `RunOptions.maxDepth` raises the guard, but past a point that trades a
  clear, named error for a real V8 stack overflow. Treat ~500 chained frames
  per traverser as the supported envelope until the trampoline lands (see
  the backlog).

Splitting long linear chains into subflows resets the budget at each mount and
is the supported way to run deeper pipelines today.

## Clone-cost model — what a stage pays today

State safety is bought with structured clones. Current costs per stage:

| Operation | Cost today |
|---|---|
| First tracked **read** in a stage | Constructs the transaction buffer: **two `structuredClone`s of the entire shared state** |
| Each tracked read (`getValue`) | One `structuredClone` of the value (for the read-tracking view) |
| Each net-changing write | ~3 value clones (patch, write-tracking, commit diff) |
| TypedScope object/array write | + one JSON round-trip to unwrap the proxy |
| `getValueDirect` | No tracking, no per-read clone (the escape hatch for hot reads) — but the stage's *first* state access of any kind still constructs the buffer |

Rules of thumb: keep shared-state values modest (the buffer clones the *whole*
state, so one huge key taxes every stage); prefer `getValueDirect` for
read-hot inner loops; batch array writes with `$batchArray`. The lazy-buffer
and summary-tracking optimizations are planned (backlog Phase 3) and will
revise this table.

## Pause / resume — what a checkpoint captures

A checkpoint is JSON-safe and contains: `sharedState`, the execution tree,
the paused stage id + subflow path, `pauseData`, and pre-pause subflow scopes
(`subflowStates`).

**Not captured — by design:**

- **Recorder state.** Checkpoints never capture recorder state. **Cross-
  executor resume** (a fresh executor/process restoring a stored checkpoint)
  therefore starts with an empty narrative — collect what you need before
  discarding the paused executor. **Same-executor resume** preserves and
  accumulates narrative/recorder state across the pause boundary. A fresh
  `runId` is generated for the resumed run either way.
- **Detached children.** `DetachHandle`s and in-flight children started via
  `footprintjs/detach` are invisible to checkpoints — they are fire-and-forget
  by contract. Drain them with `flushAllDetached()` before persisting a
  checkpoint if you need them settled.
- **In-flight timers/aborts.** `timeoutMs`/`signal` belong to the call, not
  the checkpoint; supply them again on `resume()`.

One more honesty note — now resolved: the checkpoint **is deep-copied at
creation** (one `structuredClone` of every field — `sharedState`,
`executionTree`, `subflowStates`, `subflowResults`, `pauseData`). It shares
no structure with the engine: mutating a checkpoint you hold cannot corrupt
engine state, and a later same-executor resume cannot mutate a checkpoint
you already persisted. `resume()` is isolated in the other direction too —
it clones the checkpoint pieces it seeds into the engine, so the engine
never holds a reference to your object. (Consequence of the JSON-safe
contract: a `pauseData` value that is not structured-cloneable — e.g.
contains a function — now throws at pause time instead of silently
surviving in-process and breaking on real persistence.)

`getSnapshot().sharedState` is different: in production it remains a
**zero-copy live view** of working memory — treat it as read-only. In dev
mode (`enableDevMode()`) it is a **deep-frozen clone**, so any accidental
consumer mutation throws immediately instead of silently corrupting engine
state. Clone-always in production is deferred until benchmarked (a 1 MB
state costs ~4 ms per `structuredClone`, measured on Node 22/M-series —
fine for a one-off pause, real money for snapshot-polling consumers).

## Summary — the envelope in one box

| Dimension | Supported today |
|---|---|
| Concurrency | one in-flight execution per executor (guarded); executor-per-run on servers |
| Chain length | ~500 chained stages/loop hops per traverser; subflow mounts reset the budget |
| State size | modest values; whole-state clone on first read per stage |
| Introspection | last-run-wins getters; `sharedState` is a read-only live view (dev mode: frozen clone) |
| Checkpoints | state + tree + pause data, **deep-copied at creation**; **not** recorders or detached children |
