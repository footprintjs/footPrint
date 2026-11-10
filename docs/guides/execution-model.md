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

The error is `RunInFlightError`, exported from `footprintjs`, with code
`ERR_RUN_IN_FLIGHT`. Its `runnerId` is the display label `FlowChartExecutor`;
it is not a unique identity or an authentication claim. `activeRunId` is present
only after native ID generation. Admission happens before schema and option
callbacks, recorder reset or resume notification, and remains held through the
native returned promise, including recorded sink settlement.

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
whichever run/resume most recently executed. Capture values you need to retain;
these raw getters do not become per-run handles.

## A reusable logical runner

`createRunLifecycle` is the ownership boundary for a reusable component built
around a compiled chart. Build it once per logical runner. Different lifecycle
objects can run concurrently, even when they share a display label or chart.
One object's `withRun` reserves synchronously, before caller code, and holds
ownership through setup, native execution, postchecks and registered cleanup.

```ts
import {
  createRunLifecycle, flowChart,
  type RunLifecycle, type RunSlot,
} from 'footprintjs';

let owner: RunLifecycle;
let counts: RunSlot<{ count: number }>;
const chart = flowChart<{ result?: number }>('Count', async (scope) => {
  const bound = owner.forScope(scope);
  const local = bound.local(counts, () => ({ count: 0 }));
  local.count += 1;
  scope.result = local.count;
}, 'count').build();

owner = createRunLifecycle(chart, { runnerId: 'counter' });
counts = owner.slot('runtime');

async function count() {
  return owner.withRun(async (run) => {
    await run.execute({ kind: 'run' });
    // Typed validation and required filing belong inside this owned body.
    return run.snapshot()?.sharedState.result;
  });
}
```

The body may request zero or one native execution. A body that omits `await`
does not release early: its started native promise is observed and joined.
A body failure requests cancellation through the existing native signal path
and still joins settlement. This does not prove that abandoned underlying I/O
stopped. `onFinalize` registers cleanup in reverse order; pending cleanup keeps
the runner busy. Every cleanup runs even after another fails. The original
body failure wins, otherwise the native/setup failure, otherwise the first
cleanup failure. Secondary failures are observed and reported as value-free
counts through the existing logger; diagnostic logging is not a new awaited
dependency.

### Finish inside the body

By default the finalizers run after the body returns, so they run outside any
async context the body set up. Code that wraps the body's work, for example in
an `AsyncLocalStorage`, cannot see what they file. `run.finish()` runs them
from inside the body instead, while the lease is still held:

```ts
import { createRunLifecycle, flowChart } from 'footprintjs';

// An AsyncLocalStorage<string> from node:async_hooks.
declare const turn: { run<R>(store: string, work: () => R): R; getStore(): string | undefined };
const owner = createRunLifecycle(flowChart('Work', () => undefined, 'work').build(), { runnerId: 'turns' });

await owner.withRun((run) =>
  turn.run('turn-1', async () => {
    run.onFinalize((end) => console.log(turn.getStore(), end.kind)); // "turn-1 completed"
    await run.execute({ kind: 'run' });
    await run.finish();
  }),
);
```

- `finish()` waits for a started execution, then decides the end from it:
  `failed` (cancellation included), `paused`, or `completed`. The finalizers
  get that end, once, in reverse order. A body that requested no execution
  finishes as `completed`.
- Calling it is the body's word that its own part did not fail. A body that
  throws afterwards still rejects `withRun` with its error and still withdraws
  the SAME continuation, but the finalizers do not run again and the end they
  saw stands. Call `finish()` only once the body's outcome is settled.
- It rejects with the first cleanup failure, unless the run paused (a pause
  wins, as before). `withRun` keeps the same failure precedence.
- A second call shares the first and runs nothing again. A call after the body
  settled refuses (`Owned run body has closed`, then `Owned run has retired`):
  the point is to run inside the body.
- After `finish()`, `onFinalize` refuses with `Owned run has finished`, so a
  cleanup can never be registered and then silently skipped; `execute` refuses
  the same way.
- The lease and pause ownership do not change: a second `withRun` is still
  refused until the body returns, and `continuation()` is offered only after it.
  `withRun` releases the lease as before and finalizes nothing again.
- A body that never calls `finish()` behaves exactly as before.

Runnable: `examples/runtime-features/run-lifecycle/02-finish-inside-body.ts`.

Private slots have two lifetimes. A `leg` slot is shared through one native
root leg. A `runtime` slot is separate for each runtime invocation, including
each mount of a shared child. Inside compiled stages use `forScope(scope)`;
`view()` is the external read door and cannot identify a mounted invocation.
A child mounted by two parents gets separate banks, without calling its public
run method or starting a second executor. Arbitrary application closure state
is not automatically isolated: move per-run values into these explicit slots.

Declare keys before first admission or valid mounted use. `read` distinguishes
absent from stored `undefined`; `local` initializes synchronously once; `set`
replaces a cell; `take` reads and deletes it synchronously. Wrong-owner or
fabricated keys refuse. A retired binding can read an existing old cell but
cannot initialize or replace one. Values themselves are opaque and are not
deep-frozen; a stored Promise is not automatically awaited. Cells, credentials
and programs never automatically enter state, env, checkpoints or recorder
payloads. They are not a persistence or authorization mechanism.

`run.origin` is undefined before native origin admission. Optional synchronous
`onOrigin(cells, origin)` setup runs after the native ID is bound and before the
first run-start/stage hook. Its temporary cell capability expires when the
callback returns. A returned thenable is a contract error; the lifecycle still
observes and joins it, with no stage started. Setup also accepts ordered native
recorder attachment descriptors, each with its existing `AttachRecorderOptions`,
redaction and optional native narrative options. Inline evidence and deferred
observers keep their different existing delivery semantics. `narrative: {}`
explicitly enables the native narrator with its defaults; absence adds no new
enable call.

`view()` exposes the active execution, then the latest actual execution between
admissions. During preparation a snapshot is undefined, not the preceding run's
heap. A captured view stays attached to that execution; if its executor starts
another native leg, its methods throw `TypeError` before reading the newer leg.
The native snapshot's borrowed-value and redaction rules still apply: a captured
view fixes identity, not the mutability of a live heap. Unknown redaction coverage
in a framework adapter must still refuse public serving.

After a native pause, `continuation()` returns its opaque token only while idle.
Resume with `{ kind: 'resume', mode: 'same', continuation, input }` to retain that
executor's native log/counters/narrative. It consumes the latest token once,
including an attempt later refused during setup or native validation. A new
native leg gets a new native ID and new private banks. Old scope bindings keep
their old origin and bank; they do not follow a reused runtime. The retained
native log address is not rewritten to equal the new leg ID.

For persistence, save `token.checkpoint()` and use
`{ kind: 'resume', mode: 'fresh', checkpoint, input }` after loading it. The
export is detached native checkpoint data; serializing the token itself cannot
restore its process-local capability. Framework history-only continuations
remain a separate validated domain contract. No private cell or token supplies
a distributed lock, authentication or exactly-once execution guarantee.

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
- **Fn-bearing dynamic-next chains share that budget.** A stage that returns
  a fresh function-bearing `next` node bypasses the per-node loop counter
  (no back-edge to count), so the run-total chain of such hops is bounded by
  the same `maxIterations` (default 1000) with its own error
  (`Maximum dynamic-next continuations (N) exceeded at stage '…'`) — a
  runaway dynamic chain errors instead of running forever on the flat
  trampoline.
- **Memory still bounds long loops.** Per-iteration state deltas, commit-log
  entries, and narrative entries all accumulate. In particular, appending to
  a tracked **array** each iteration makes every commit record the full
  changed array — retained commit-log size grows O(N²) and OOMs around a
  couple thousand iterations on an 8 GB machine. Keep tracked state bounded
  (scalars, windowed arrays) for long loops, or accept the cost deliberately.
- `RunOptions.maxDepth` still guards runaway **recursive composition**
  (unbounded nested dispatch). It counts NESTING along the call path —
  parallel siblings share one level, so a fork of any width is one level.
  500 covers any realistic chart shape; raising it is rarely needed now that
  chains, loops and fan-out width don't consume it. A reached cap fails the
  run: `onError` fires and `run()` rejects with `TraversalDepthError`.

Splitting long linear chains into subflows is no longer necessary for depth —
compose subflows for meaning, not to dodge a frame budget.

## Stage boundaries are scheduling points — by design

The traverser `await`s every stage function, so the JavaScript microtask
queue runs at **every stage boundary** — even in a pure-CPU chart with no
I/O anywhere. This is a deliberate structural guarantee, not an accident
of async style:

- As a chart **grows** — more stages, deeper subflows, longer loops — its
  number of scheduling points grows with it. The engine never degenerates
  into one long synchronous block.
- Consumer stage code is free to be heavy: the boundary awaits guarantee
  the platform (timers, promise continuations, and anything scheduled on
  microtasks) gets the thread between stages, regardless of what a stage
  did inside.
- The granularity is the **stage**: JavaScript cannot preempt, so a
  synchronous loop *inside* one stage runs to completion before the next
  boundary. If you need finer-grained breathing, split long CPU work
  across stages — the boundaries do the rest.

## Clone-cost model — what a stage pays today

State safety is bought with structured clones. Current costs per stage:

| Operation | Cost today |
|---|---|
| Stage's first **write** | Constructs the transaction buffer: **zero state clones** since 9.29.0 (copy-on-write) — it holds committed state by reference and copies its root; each write copies only the containers on its own path. (Before 9.29.0: two `structuredClone`s of the entire shared state.) |
| First read of a committed container AFTER the stage's first write | One `structuredClone` of THAT value — the stage's private copy, taken once per container per stage (so an in-place edit of a read stays private, as before) |
| Reads before any write (`getValue`/`getValueDirect`) | **Zero state clones** — reads never construct the buffer; they read straight from shared memory until a write exists (#13) |
| Each tracked read (`getValue`) | Policy-gated (#14): one `structuredClone` of the value under the DEFAULT `readTracking: 'full'`; a cheap type/size/preview marker under `'summary'`; **zero** under `'off'` |
| Each net-changing write | **Zero clones at write time** since 9.23.0: the buffer and write tracking hold references until commit. At commit, one clone per surviving path for the record, plus the write-TRACKING retained form, taken once per key. That retained form is policy-gated (#13c-A): a clone under the DEFAULT `writeTracking: 'full'`; a cheap type/size/preview marker under `'summary'`; **zero** under `'off'` |
| TypedScope object/array write | The same as any write: since 9.24.0 the proxy hands the value over as assigned (no JSON round-trip) |
| `getValueDirect` | No tracking, no per-read clone (the escape hatch for hot reads) |
| Commit of a writing stage | The next state generation copies the root and the containers on each written path and SHARES the rest (9.29.0) — independent of everything the stage did not write. (Before: one `structuredClone` of the entire state per commit, two with a redaction mirror.) |
| Commit of a read-only / no-touch stage | **Zero clones** — the (empty) commit bundle is still recorded, but without buffer construction or state replay |

Rules of thumb: a huge key costs a stage only when the stage writes it, or reads
it after its first write (since 9.29.0 nothing clones the whole state; before,
one huge key taxed every **writing** stage); prefer `getValueDirect` for read-hot inner loops;
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
gated by this dial — the separate `commitValues: 'delta'` dial (#13c-B) encodes them as deltas.

One contract to know when reading at the `ScopeFacade`/`StageContext` tier:
**read values are borrowed — do not mutate them.** Pre-write reads return
references into committed shared state (edited in place and written back, such a
value records NO change since 9.29.0 — the diff base is that same object; dev
mode warns); post-write reads return the stage's own copy (taken on the first
read of each container). Write changes back via `setValue`/`updateValue`.
TypedScope consumers are safe automatically (the proxy routes every mutation
through tracked writes). See `src/lib/memory/README.md`.

### Staging-state lifetime — released at commit (#13b)

A stage's transaction buffer (before 9.29.0 two full-state clones; now a root
copy plus whatever its writes and reads copied) and its first-touch state view (a
reference pinning one committed-state **generation** — generations share every
unchanged subtree since 9.29.0) live exactly as long as the stage **executes**. `StageContext.commit()` releases both at its end; they
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
half; `commitValues: 'delta'` (#13c-B) shrinks the commit log's payloads).


**Per-call limits:** `maxDepth` and `maxIterations` are options of the CALL —
`resume()` does not inherit the values passed to `run()`; supply them again
(iteration counters reset on resume).

## Pause / resume — what a checkpoint captures

A checkpoint is JSON-safe and contains what `resume()` reads, plus the
pause's own record: `sharedState`, the paused stage id + subflow path (and
`pausedBy`), the pre-pause scope of each subflow on that path
(`subflowStates`), the execution and visit counters, any parallel siblings
still waiting (`pendingPauses`), the redaction marks (names only), and
`pauseData` / `pausedExecution` / `invokerStageId` / `pausedAt`.

Its size is the state's, never the run's length (format 2, the lean
checkpoint). Format 1 also carried the execution tree and the finished
subflows' results — the run's record, which no resume read: after 60 agent
turns whose resumable state (root plus captures) is 0.13 MB the checkpoint
was 19.3 MB, and is now 0.13 MB (`npx tsx bench/checkpoint-size.ts`). That
record is the snapshot's: keep `executor.getSnapshot()` from before
`resume()` if you want it. A format 1 checkpoint still resumes — the codec's
upcaster drops the two fields.

**Not captured — by design:**

- **The run's history.** The execution tree, the commit log and the finished
  subflows' results are served by `getSnapshot()`, not carried by the
  checkpoint.

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
`subflowStates`, `pendingPauses`, `pauseData`). It shares
no structure with the engine: mutating a checkpoint you hold cannot corrupt
engine state, and a later same-executor resume cannot mutate a checkpoint
you already persisted. `resume()` is isolated in the other direction too —
it clones the checkpoint pieces it seeds into the engine, so the engine
never holds a reference to your object.

**Where non-serializable values can enter a checkpoint, and what happens to
each:**

- **Diagnostic values** (`$debug`/`$error`/`$metric`/`$eval`) — these accept
  ANY value at write time without cloning, so a logged function/Promise/etc.
  can legitimately be present when a run pauses. They never enter a
  checkpoint (it carries no execution tree), so the pause **succeeds**; the
  live engine diagnostics — `getSnapshot()`, a same-executor resume — keep
  the raw value.
- **`pauseData`** (returned by a pausable stage's `execute()`) — consumer-owned
  checkpoint data, so the JSON-safe contract applies. A non-cloneable value
  here fails the pause with a **descriptive contract error** naming the
  offending checkpoint field (the raw `DataCloneError` is preserved as
  `error.cause`) — instead of silently surviving in-process and breaking on
  real persistence. A naked `DataCloneError` never escapes the executor.
- **Shared state** (stage writes, the executor's `initialContext` /
  `defaultValuesForContext` options) — must be structured-cloneable from the
  start: a function here fails the stage at **commit**, when the transaction
  buffer `structuredClone`s the staged value — long before any pause. A
  `try`/`catch` inside the stage does not see it, and none of that stage's
  writes land.

`getSnapshot().sharedState` is different: in production it remains a
**zero-copy live view** of working memory — treat it as read-only. In dev
mode (`enableDevMode()`) it is a **deep-frozen clone**, so any accidental
consumer mutation throws immediately instead of silently corrupting engine
state. Clone-always in production is deferred until benchmarked (a 1 MB
state costs ~4 ms per `structuredClone`, measured on Node 22/M-series —
fine for a one-off pause, real money for snapshot-polling consumers).

## Saving a run so something else can draw it

A snapshot is what HAPPENED. It is not what the chart LOOKS like — and a
viewer needs both. Save three things together:

```ts
const chart = flowChart<State>('Seed', seedFn, 'seed').addFunction(/* … */).build();

const executor = new FlowChartExecutor(chart);
executor.attachCombinedRecorder(narrative());   // the story, on the snapshot
await executor.run({ input });

const recording = {
  snapshot:  executor.getSnapshot(),      // state + commit log + every recorder's data
  structure: chart.buildTimeStructure,    // THE CHART. Nothing else can draw it.
};
fs.writeFileSync('run.json', JSON.stringify(recording));
```

`buildTimeStructure` is stamped on the built chart by the build-time structure
recorder — stages, edges, and nesting, with no run in it. It is the one
required ingredient `getSnapshot()` deliberately does NOT carry: the snapshot
is per-run and the structure is per-chart, and a chart executed a thousand
times would otherwise ship a thousand copies of the same drawing.

The practical consequence is worth stating plainly: **a saved `getSnapshot()`
on its own cannot draw a chart.** It can colour one — the commit log says
which stage wrote what, in order — but the shape has to come from
`buildTimeStructure`. Save one without the other and the viewer that reads it
has to either go dark or invent a shape; a good one goes dark and says so.

## Summary — the envelope in one box

| Dimension | Supported today |
|---|---|
| Concurrency | one in-flight execution per executor (guarded); executor-per-run on servers |
| Chain length | unbounded (flat trampoline); depth guards tree NESTING only (default 500) |
| Loop iterations | bounded by `maxIterations` (default 1000 per node, raisable per run) and by memory — not by stack depth |
| Dynamic-next chains | fn-bearing dynamic `next` hops bounded by the same `maxIterations` budget (run-total, default 1000) |
| State size | a write costs what it writes (copy-on-write, 9.29.0); a value is cloned when a stage writes it, or reads it after its first write — never the rest of the state |
| Introspection | last-run-wins getters; `sharedState` is a read-only live view (dev mode: frozen clone) |
| Checkpoints | what a resume reads — state, the pause path's subflow states, counters — plus the pause data, **deep-copied at creation**; size independent of the run's length (format 2: no execution tree); **not** recorders, detached children or the run's history |


### Private cells in subflow mappers

Native input mappers receive `(parentData, binding)` and output mappers receive
`(childOutput, parentData, binding)`. The separately supplied
`NativeMappingBinding` captures the mount's parent stage frame before the child
starts. Input and output receive distinct frozen objects naming that same parent
runtime and stage origin. A branch's output write address does not change this
binding. Resolve it with the component owner's `forScope(binding)`; do not resolve
raw parent data or look up the owner's latest run.

The carrier exposes only readonly native `origin` metadata. It can resolve the
existing active private-cell operations, including writes; readonly metadata is
not read-only cell authority. The engine never inserts the binding or its private
cells into mapped data, state, env, records or checkpoints. The existing data,
taint, detachment and merge rules still apply. Retained bindings keep their old
frame and bank after resume; retired writes refuse. Copies or serialized origins
cannot recreate the weak identity registration. This is process-local ownership,
not authentication, deep freezing of host values or a hostile-host sandbox.

The callback binding type is optional because the exported pure mapping helpers
also work outside an engine. Those calls supply `undefined`, which `forScope`
refuses. Actual native mapper calls require an explicitly registered parent stage
frame; a missing frame fails before either mapper rather than guessing an origin.


## Private component state across internal charts

`createRunLifecycle` has three private slot lifetimes. A `leg` slot spans the
native leg. A `runtime` slot belongs to one native runtime, so every subchart
mount gets a different value. A `component` slot fills the middle: one runner's
internal charts share its value, while each independently mounted runner entry
gets a fresh value. The chart is still built once.

Declaring a component slot declares that chart root as a boundary process-wide.
Every entry of the same compiled chart is then a boundary for every lifecycle,
including lifecycles that use only leg/runtime slots. This creates stricter
isolation, never shared state between separate entries. Lifecycles still have
separate slot namespaces. This is cooperative chart configuration, not identity
authentication.

```ts
import {
  createRunLifecycle, flowChart, FlowChartExecutor,
  type RunLifecycle, type RunSlot,
} from 'footprintjs';

let owner: RunLifecycle;
let counter: RunSlot<{ visits: number }>;
const seen: object[] = [];
const internal = flowChart('Internal', (scope) => {
  const cell = owner.forScope(scope).local(counter, () => ({ visits: 0 }));
  cell.visits++;
  seen.push(cell);
}, 'internal').build();
const component = flowChart('Entry', (scope) => {
  const cell = owner.forScope(scope).local(counter, () => ({ visits: 0 }));
  cell.visits++;
  seen.push(cell);
}, 'entry').addSubFlowChartNext('inside', internal, 'Inside').build();
owner = createRunLifecycle(component, { runnerId: 'example' });
counter = owner.slot('component');
const parent = flowChart('Parent', () => undefined, 'parent')
  .addSubFlowChartNext('first', component, 'First')
  .addSubFlowChartNext('second', component, 'Second').build();
await new FlowChartExecutor(parent).run();
console.log(seen[0] === seen[1]); // true: entry and internal chart share
console.log(seen[0] === seen[2]); // false: the second mount is independent
```

Declare component slots before entry. Declaration after graph prefixing works;
declaration after entry does not retarget an existing frame, and access without
the captured boundary refuses. Each new native leg, including same-executor
resume, starts with fresh private banks. Rebuild private computation from
admitted continuation facts; cells never become checkpoint storage. A declared
component retires at its own terminal, even while its parent is still running:
captured bindings keep their reads, and their writes and new finalizer
registrations refuse. The owner's `run` handle stays open until the `withRun` body
closes. An undeclared internal subchart does not retire the component around it.
Input/output mapper bindings name the parent component;
stages inside a declared child name that child's component.


### Advanced mapper execution

The mapper helpers on `footprintjs/advanced` are still pure data helpers. Running
`SubflowExecutor` directly with mappers is not supported: it refuses, because only
the engine's own traversal captures the parent stage a mapper is bound to. Run a
compiled chart through `FlowChartExecutor` or `createRunLifecycle`; there is no
public way to register a parent stage yourself. During a run, an input mapper
receives the binding as its second argument, and an output mapper as its third.
Wrap a function whose extra parameters have another meaning, for example
`inputMapper: (data) => hostMapper(data)`, instead of passing it by reference.

### When `chart.root` is read

Each `run()` and `resume()` reads `chart.root` once, as soon as the call is accepted
and before any caller or setup callback runs. That one value is used for resume
planning, component identity, the runtime's name, traversal, the saved record's
opening metadata and budget warnings. Replacing `chart.root` during setup affects
the next run or resume, not this one. Graph nodes and subflow maps can still be
changed as before.
