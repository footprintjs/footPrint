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

The traverser is a **trampoline**: linear `next` hops, loop edges
(`loopTo` / dynamic next), and dynamic re-entries are followed in an
iterative driver loop, so neither the call stack nor the retained promise
chain grows with chain length or loop count. `MAX_EXECUTE_DEPTH = 500` caps
**tree nesting only** — one tick per fork child, per decider/selector branch
dispatch that must return to its invoker (a decider with its own
continuation), per subflow mount frame in the parent (the subflow body runs
on a fresh traverser with its own budget).

Practical consequences:

- **Linear chains and loop iterations are unbounded by depth.** A 5,000-stage
  chain or a 10,000-iteration `loopTo` loop runs at the default `maxDepth`
  with a flat stack (measured: 10k iterations of an agent-style loop chart
  in ~0.5 s, peak engine depth 1 — pre-trampoline the same chart hit the
  depth wall at iteration 249).
- **The loop-iteration limit is the binding constraint for loops** — default
  1000 per node, with its own actionable error
  (`Maximum loop iterations (N) exceeded for node '…'`). Raise it per run
  via `RunOptions.maxIterations` (propagates to subflows); the documented
  limit is now actually reachable instead of the depth guard firing first.
- **Memory still bounds long loops.** Per-iteration state deltas, commit-log
  entries, and narrative entries all accumulate. In particular, appending to
  a tracked **array** each iteration makes every commit record the full
  changed array — retained commit-log size grows O(N²) and OOMs around a
  couple thousand iterations on an 8 GB machine. Keep tracked state bounded
  (scalars, windowed arrays) for long loops, or accept the cost deliberately.
- `RunOptions.maxDepth` still guards runaway **recursive composition**
  (unbounded nested dispatch). 500 covers any realistic chart shape; raising
  it is rarely needed now that chains and loops don't consume it.

Splitting long linear chains into subflows is no longer necessary for depth —
compose subflows for meaning, not to dodge a frame budget.

## Clone-cost model — what a stage pays today

State safety is bought with structured clones. Current costs per stage:

| Operation | Cost today |
|---|---|
| Stage's first **write** | Constructs the transaction buffer: **two `structuredClone`s of the entire shared state** |
| Reads before any write (`getValue`/`getValueDirect`) | **Zero state clones** — reads never construct the buffer; they read straight from shared memory until a write exists (#13) |
| Each tracked read (`getValue`) | Policy-gated (#14): one `structuredClone` of the value under the DEFAULT `readTracking: 'full'`; a cheap type/size/preview marker under `'summary'`; **zero** under `'off'` |
| Each net-changing write | ~3 value clones (patch, write-tracking, commit diff). The write-TRACKING clone is policy-gated (#13c-A): it fires under the DEFAULT `writeTracking: 'full'`; a cheap type/size/preview marker under `'summary'`; **zero** under `'off'`. The patch + commit-diff clones remain in EVERY mode — they are the commit path, not tracking |
| TypedScope object/array write | + one JSON round-trip to unwrap the proxy |
| `getValueDirect` | No tracking, no per-read clone (the escape hatch for hot reads) |
| Commit of a read-only / no-touch stage | **Zero clones** — the (empty) commit bundle is still recorded, but without buffer construction or state replay |

Rules of thumb: keep shared-state values modest (the buffer clones the *whole*
state on a stage's first write, so one huge key taxes every **writing** stage —
read-only stages are free); prefer `getValueDirect` for read-hot inner loops;
batch array writes with `$batchArray`. For read-dominated production workloads
(agent loops), turn the per-read snapshot clone off wholesale:
`new FlowChartExecutor(chart, { readTracking: 'off' })` (or
`executor.setReadTracking('off')` before `run()`). The policy changes ONLY the
snapshot's `stageReads` payload — `onRead` events pass the live reference (never
cloned), so narrative and recorder output are identical in every mode. Measured:
50 tracked reads of a 1MB value drop from ~130ms (`'full'`) to **7µs** (`'off'`)
— `bench/BASELINE.md` §A.

The write side has the independent sibling dial (#13c-A):
`new FlowChartExecutor(chart, { writeTracking: 'summary' })` (or
`executor.setWriteTracking(mode)` before `run()`). It gates ONLY the
write-tracking clone into `stageWrites` — and, because the commit observer
payload is a spread of that view, `ScopeRecorder.onCommit` mutations carry the
same markers (`'summary'`) or arrive empty (`'off'`). Everything else is
untouched in every mode: the write still commits (shared state, commit log,
`onWrite` events, narrative are byte-identical), and redaction takes precedence
over the dial (`'[REDACTED]'` under `'full'`/`'summary'`, nothing retained
under `'off'`). The commit log's full value payloads are deliberately NOT
gated — that is #13c-B's lossless delta verb.

One contract to know when reading at the `ScopeFacade`/`StageContext` tier:
**read values are borrowed — do not mutate them.** Pre-write reads return
references into committed shared state; post-write reads return references into
the stage's transaction buffer. Write changes back via `setValue`/`updateValue`.
TypedScope consumers are safe automatically (the proxy routes every mutation
through tracked writes). See `src/lib/memory/README.md`.

### Staging-state lifetime — released at commit (#13b)

A stage's transaction buffer (those two full-state clones) and its first-touch
state view (a reference pinning one full committed-state **generation** — the
engine clones + swaps the whole state per commit) live exactly as long as the
stage **executes**. `StageContext.commit()` releases both at its end; they
re-create lazily if the engine touches the context again (fork double-commits,
subflow output double-commits — all observably identical, byte-for-byte).

This is what keeps LONG RUNS bounded by the audit trail instead of by state
history: the execution tree retains one `StageContext` per executed stage for
the lifetime of the run, and before the release each context pinned a distinct
full-state generation plus two clones — O(N²) retained heap on loop charts
(measured 849MB at 500 iterations on a growing-history chart; a 500-iteration
agent OOMed a default Node heap). After the release the tree retains **zero**
buffers and **zero** state generations; what still grows per iteration is the
audit surface by design — the commit log (each bundle records the full changed
value) and the per-stage `stageReads`/`stageWrites` snapshot clones
(`readTracking` (#14) gates the read half; `writeTracking` (#13c-A) the write
half; the commit log's full payloads + the per-commit clone wall cost remain —
tracked as #13c-B's delta verb).


**Per-call limits:** `maxDepth` and `maxIterations` are options of the CALL —
`resume()` does not inherit the values passed to `run()`; supply them again
(iteration counters reset on resume).

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
never holds a reference to your object.

**Where non-serializable values can enter a checkpoint, and what happens to
each:**

- **Diagnostic values** (`$debug`/`$error`/`$metric`/`$eval`) — these accept
  ANY value at write time without cloning, so a logged function/Promise/etc.
  can legitimately be present when a run pauses. Observability never aborts
  traversal: the pause **succeeds**, and the offending value is replaced in
  the checkpoint's `executionTree` with a marker string such as
  `'[non-serializable: function]'`. Only the checkpoint is sanitized — the
  live engine diagnostics (and a same-executor resume) keep the raw value.
- **`pauseData`** (returned by a pausable stage's `execute()`) — consumer-owned
  checkpoint data, so the JSON-safe contract applies. A non-cloneable value
  here fails the pause with a **descriptive contract error** naming the
  offending checkpoint field (the raw `DataCloneError` is preserved as
  `error.cause`) — instead of silently surviving in-process and breaking on
  real persistence. A naked `DataCloneError` never escapes the executor.
- **Shared state** (stage writes, the executor's `initialContext` /
  `defaultValuesForContext` options) — must be structured-cloneable from the
  start: a function here rejects at **write time**, when the transaction
  buffer `structuredClone`s the staged value — long before any pause.

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
| Chain length | unbounded (flat trampoline); depth guards tree NESTING only (default 500) |
| Loop iterations | bounded by `maxIterations` (default 1000 per node, raisable per run) and by memory — not by stack depth |
| State size | modest values; whole-state clone on first WRITE per stage (read-only stages clone nothing) |
| Introspection | last-run-wins getters; `sharedState` is a read-only live view (dev mode: frozen clone) |
| Checkpoints | state + tree + pause data, **deep-copied at creation**; **not** recorders or detached children |
