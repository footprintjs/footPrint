# Deferred observers — "one beat behind" (RFC-001)

Every recorder in footprintjs historically ran **synchronously inline**: an
`onWrite` hook executes inside the producing `scope.setValue(...)` statement,
an `onStageExecuted` hook inside the traversal step. A slow or allocating
observer therefore taxes every stage of every run.

The deferred tier inverts the deal with **one option** on the attach call:

```ts
executor.attachScopeRecorder(metrics, { delivery: 'deferred' });
executor.attachFlowRecorder(audit, { delivery: 'deferred' });
executor.attachEmitRecorder(tokenMeter, { delivery: 'deferred' });
executor.attachCombinedRecorder(observer, { delivery: 'deferred' });

// CombinedRecorder also supports the FIELD form — declare the tier on the object:
executor.attachCombinedRecorder({ id: 'audit', delivery: 'deferred', onWrite, onDecision });
```

- the engine pays only for **capture** — a cheap, bounded, never-throwing
  snapshot of the event into an envelope on ONE totally-ordered queue;
- **delivery** happens at the next microtask checkpoint ("one beat behind"),
  under an explicit time budget;
- backpressure is a **policy with honest accounting** — a bounded queue with
  counted drops, never an OOM, never a silent stall;
- at every terminal boundary (run resolve, run reject, pause) the queue is
  **drained synchronously before control returns to you** — nothing is lost
  at exit.

Omit `delivery` and nothing changes: the inline path is byte-identical to
previous releases, and an executor where nobody opts in allocates nothing.

## The options bag

Accepted by all four `attach*Recorder` methods:

| Option | Default | Meaning |
|---|---|---|
| `delivery` | `'inline'` | `'deferred'` opts this recorder into the queue |
| `capture` | `'clone'` | Payload materialization — see below |
| `maxQueue` | `10000` | Queue bound (envelopes) |
| `overflow` | `'drop-oldest'` | Policy at the bound: `'drop-oldest'` / `'sample'` / `'block'` |
| `sampleEvery` | `10` | `'sample'` only — admit 1 in N saturated arrivals |
| `flushBudgetMs` | `2` | Per-checkpoint delivery budget; `Infinity` = full drain |

**One queue per executor.** `capture` / `maxQueue` / `overflow` /
`sampleEvery` / `flushBudgetMs` configure the executor's single shared
dispatcher and are applied by the **first** deferred attach; a later attach
passing different values keeps the original configuration and dev-warns
(per-recorder queues would break the total cross-channel event order).

**Tier swap is clean.** Attach is idempotent by `id` ACROSS tiers:
re-attaching id `X` with a different `delivery` moves it — an id is never
delivered on both tiers.

## Capture policies — what your hooks receive

A deferred hook receives the envelope's **materialized payload**, not the
live event:

- **`'clone'` (default)** — a `structuredClone` of the event: the **same
  shape an inline recorder sees**, fully detached. `{ delivery: 'deferred' }`
  is therefore a drop-in port — `event.key` / `event.value` /
  `event.runtimeStageId` all keep working unchanged. Unclonable payloads
  degrade to `'summary'` with a dev-warn.
- **`'summary'`** — a bounded, reference-free `PayloadSummary` tree
  (depth ≤ 3, ≤ 16 entries/level, ≤ 128 nodes, 80-char previews). Cheapest
  and detached — but it is **not the original event shape**: a recorder
  reading `event.key` must be written against the summary shape instead.
  Choose it explicitly for "what happened" telemetry at minimum cost.
- **`'ref'`** — the live event object, zero copy. The event WRAPPERS the
  engine dispatches are fresh per event, but nested values (e.g. an
  `onWrite`'s `value`) can alias engine state — you assert immutability for
  the delivery window. Dev-warned on every capture.

Redaction always wins: capture happens strictly **after** the redaction
decision at each dispatch site, so a deferred envelope can never contain a
pre-redaction value — under any policy, including `'ref'`.

## Backpressure — honest, never silent

When a single stage bursts more events than `maxQueue` between two
checkpoints:

- **`'drop-oldest'`** — evict the oldest envelope. Every loss increments
  `observerStats.drops` and leaves a visible gap in the delivered stream.
- **`'sample'`** — under saturation admit 1 in `sampleEvery`; the rest are
  counted drops. A thinned but fresh stream under sustained overload.
- **`'block'`** — lose NOTHING: the overflow event is delivered
  synchronously **inline** instead (you explicitly buy back blocking
  delivery for zero loss; counted in `observerStats.inlineDeliveries`).
  Ordering caveat: an inline-delivered overflow event overtakes the queued
  backlog.

## Terminal boundaries + shutdown

- `run()` resolve / reject and pause all drain the queue **synchronously
  before returning** — a crash report or a checkpoint handoff always comes
  with the complete observer record. A pathological listener that keeps
  enqueueing during the terminal flush is cut off by a round cap; the
  stranded remainder is counted in `observerStats.terminalStranded` and
  dev-warned — never silent.
- **Async listeners** (hooks returning Promises) are never awaited by a
  flush. Before process exit / serverless freeze, settle them explicitly:

```ts
await executor.run({ input });
const { done, failed, pending } = await executor.drainObservers({ timeoutMs: 5_000 });
// pending === 0 ⇒ fully drained; non-zero is an honest report, not a silent loss
```

## Stats — `snapshot.observerStats`

Present on `executor.getSnapshot()` only when a deferred observer was
attached (zero-cost discipline for everyone else):

```ts
{
  depth: 0,              // current backlog
  drops: 0,              // events LOST to overflow — also visible as gaps
  flushes: 51,           // completed checkpoint flushes
  budgetExhausted: 0,    // flushes cut short by flushBudgetMs
  p95FlushMs: 0.4,       // rolling p95 flush duration
  inlineDeliveries: 0,   // 'block' refusals delivered synchronously
  inflight: 0,           // async listener continuations not yet settled
  terminalStranded: 0,   // events cut off by the terminal-flush cascade cap
  perListener: { audit: { events: 51, totalMs: 12.3, lastFlushMs: 0.2 } }, // name the hog
}
```

## FAQ

**Do recorders slow my chart down?**
Inline recorders do — they run inside the producing statement. A deferred
recorder costs the engine only the capture (≈ microseconds: summarize/clone
+ enqueue). The observer's real work runs at scheduling checkpoints, off the
stage path. With no recorders (or only deferred ones doing nothing), stage
code runs at full speed.

**When does the deferred work actually run?**
At the next microtask checkpoint. The engine `await`s every stage function,
so the microtask queue runs at **every stage boundary** even in pure-CPU
charts — a flush armed during stage N runs before stage N+1's body. In
I/O-bound charts the work lands in the idle await window and overlaps the
wait (see `examples/runtime-features/deferred-observers/04-slow-listener-bench.ts`).

**Can deferred work pile up until the end of the chart?**
No. Every enqueue arms a flush at the next checkpoint, and each flush drains
under `flushBudgetMs` (re-arming if backlog remains) — delivery interleaves
with execution, "one beat behind". The queue is bounded (`maxQueue`), so even
a pathological burst cannot grow memory without bound; the overflow policy
decides, with counted evidence. Whatever is still queued at the end is
drained synchronously before `run()` returns.

**Will my recorder see a different order than inline?**
No — per-listener delivery is FIFO in arrival order, totally ordered ACROSS
all three channels (one merged queue, `seq` stamped at capture). The relative
order inline recorders observe (reads/writes before the stage's flow event,
etc.) is preserved. The single exception is `'block'` overflow: a refused
event is delivered inline immediately and overtakes the queued backlog.

**What about slow or heavy listeners?**
They can't block a stage anymore. The flush budget (`flushBudgetMs`, default
2ms) bounds how much listener time any single checkpoint spends; the rest
re-arms for the next one. Per-listener time accounting
(`observerStats.perListener`) names the hog. A throwing or rejecting
listener is isolated — siblings and the engine never see the failure (it
routes to the other observers' `onError` and a dev-warn).

**What happens on crash, pause, or serverless freeze?**
Run reject and pause both drain the queue synchronously BEFORE the rejection
reaches your `catch` / before the checkpoint is available — the record is
complete at the moment you observe the outcome. For serverless / shutdown,
`await executor.drainObservers({ timeoutMs })` settles async listener
continuations and reports an honest `pending` count if the deadline cuts it
off.

## When to stay inline

- The built-in `CombinedNarrativeRecorder` (`enableNarrative()` /
  `chart.recorder(narrative())`) stays inline by design — it is cheap and
  its output feeds `getNarrativeEntries()` consumers synchronously.
- Recorders whose results you read MID-run with zero lag (e.g. a live UI
  polling between stages) — deferred data is one beat behind until the next
  checkpoint.
- Anything else — metrics, audit logs, exporters, token meters, quality
  scorers — is a deferral candidate.

## See also

- Design: [docs/design/rfc-001-deferred-observers.md](../design/rfc-001-deferred-observers.md)
- Examples: [examples/runtime-features/deferred-observers/](../../examples/runtime-features/deferred-observers/)
  — 01 basic (inline vs deferred, same record), 02 backpressure,
  03 terminal flush, 04 slow-listener bench
- Scheduling background: [execution-model.md — "Stage boundaries are scheduling points"](./execution-model.md#stage-boundaries-are-scheduling-points)
