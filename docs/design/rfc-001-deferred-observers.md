# RFC-001 — Deferred observer delivery ("one beat behind")

> Status: **accepted with amendments** (A1–A4 below). Blocks 1–5 (the pure
> module) shipped; Blocks 6–10 (engine wiring) pending.
> Audience: library maintainers + downstream recorder authors.
> Related code: [`capture/envelope.ts`](../../src/lib/capture/envelope.ts),
> [`observer-queue/`](../../src/lib/observer-queue/).
> Related notes: [`capture/policies.ts`](../../src/lib/capture/policies.ts)
> (retention ↔ capture vocabulary mapping, #13c-A),
> [`execution-model.md`](../guides/execution-model.md)
> ("Stage boundaries are scheduling points").

## The one-line rule

Observers stop running inside the engine's hot path: every observer event is
**captured** into a self-contained envelope at the moment it happens, staged
on **one bounded, totally-ordered queue**, and **delivered at the next
microtask checkpoint** — "one beat behind", never blocking a stage, never
losing an event silently.

## Why this exists

Today all three observer channels (`Recorder` / `FlowRecorder` /
`EmitRecorder`) dispatch **synchronously inline**: a slow or allocating
recorder taxes every stage of every run, and the engine cannot bound that
cost. The deferred pipeline inverts the deal:

- the producer pays only for **capture** (cheap, bounded, never throws);
- delivery happens at scheduling checkpoints under an explicit time budget;
- backpressure is a **policy with honest accounting**, not an OOM or a
  silent stall.

This is the delivery-tier sibling of the retention dials (#14 `readTracking`,
#13c-A `writeTracking`): retention asks "what does the engine *keep*?",
capture/delivery asks "what does an observer *receive*, and when?".

## Normative spec (§5, as accepted)

### Core types

```ts
interface CaptureEnvelope {
  readonly seq: number;                  // arrival stamp — total order across channels
  readonly channel: 'scope' | 'flow' | 'emit';
  readonly method: string;               // 'onWrite' | 'onStageExecuted' | 'onEmit' | ...
  readonly runtimeStageId: string;
  readonly runId: string;
  readonly payload: unknown;             // per capture policy — NEVER a live engine ref
  readonly capturedAt: number;
}
type CapturePolicy = 'summary' | 'clone' | 'ref';
type OverflowPolicy = 'block' | 'drop-oldest' | 'sample';
```

### Semantics

- **One merged queue.** `seq` is assigned at capture under the single JS
  thread ⇒ drain order == arrival order across all channels; per-listener
  delivery is FIFO in seq order — EXCEPT under `'block'` overflow, where
  the refused event is delivered inline and overtakes the queued backlog
  (`seq` preserves true arrival order; order-sensitive consumers re-sort —
  see the block-mode section). `seq` is monotonic and **gap-detectable**: a dropped
  event leaves a visible hole in the delivered sequence — loss is part of
  the record, never hidden (tested).
- **Scheduling.** Enqueue arms AT MOST one pending flush (armed flag) via
  `queueMicrotask`. A flush drains a **snapshot**: events enqueued BY
  listeners during the flush go to the NEXT checkpoint (no starvation).
  Re-arms if non-empty after the budget.
- **Capture policies.**
  - `'summary'` — bounded, reference-free, structured-clone-safe
    summarization (`summarizePayload`, see bounds below). The default.
  - `'clone'` — `structuredClone` at capture time. Unclonable payloads
    DEGRADE to `'summary'` with a `warn` — capture never throws into the
    producer. (`'clone'` ≈ retention `'full'`; see `capture/policies.ts`.)
    Degradation is signaled ONLY via `hooks.warn`: the envelope carries no
    `degraded` marker and `getStats()` has no degradation counter — a
    consumer needing degradation accounting binds `hooks.warn` to its own
    accumulator in the wiring layer.
  - `'ref'` — pass-through; the **caller asserts immutability** for the
    delivery window (safe for committed-state values, proven
    immutable-after-swap in #13/#13b). Dev-mode warned — see the seam below.
- **Backpressure.** Ring at `maxQueue` (default **10 000**); the overflow
  policy applies; **every loss increments `drops`** — surfaced in stats and
  visible as seq gaps, never silent.
- **Error isolation (Block 5).** Per-listener try/catch; sync throws AND
  async rejections route to an injected error callback
  (`{ listenerId, envelope, phase: 'sync' | 'async' }`); a throwing /
  rejecting / slow listener never affects siblings or the producer; a
  throwing error callback is itself swallowed. One listener signature:
  `(envelope) => void | Promise<void>`. The flush **never awaits**
  listeners; async continuations are tracked in an inflight set;
  `drain({ timeoutMs })` = `Promise.allSettled(inflight)` under a deadline
  (shaped like `flushAllDetached`).

### Resolution: the dev-warn seam (pure module vs `isDevMode()`)

`isDevMode()` lives in `scope/detectCircular` — an engine import the pure
module must not take. Resolution: `capture()` accepts a
`CaptureHooks { warn?, now? }` object; the pure module invokes `warn` on
every `'ref'` capture and every `'clone'` degradation and is otherwise
silent (no hooks ⇒ zero cost). The **wiring layer (Block 6)** binds `warn`
to an `isDevMode()`-gated, deduplicated console warner. The module stays
engine-free; consumers keep the central `enableDevMode()` contract.

### Resolution: what `'block'` means on a single thread

A single-threaded queue cannot literally block its producer. Accepted
interpretation: under `'block'`, a saturated enqueue **refuses the drop and
delivers that event synchronously inline** instead — degrading to inline
delivery for that one event. This **re-introduces blocking delivery by your
explicit choice** (the RFC's framing) in exchange for: zero loss, bounded
memory. Documented + tested ordering caveat: the inline event **overtakes
the queued backlog** (delivered before earlier-seq events still in the
queue); `seq` still records true arrival order, so consumers can re-sort.
Rejections are counted separately from drops — they are not losses.

## The four amendments (accepted)

- **A1 — Flush budget.** `flushBudgetMs` (default **2**, `Infinity` = full
  drain). Kernel-style: drain until the budget is exhausted or the queue is
  empty; if non-empty, re-arm for the next checkpoint. At least one item is
  processed per flush (guaranteed progress under any clock). Stats: backlog
  depth, budget-exhausted count.
- **A2 — Name the hog.** Per-listener time accounting — cumulative `totalMs`
  and `lastFlushMs` per listener id (sync delivery time; an async
  continuation does not block the flush and is not attributed). The ring is
  designed **cursor-ready**: v1 consumes destructively through one cursor
  (`head`); the v1.1 path keeps items in the ring with per-listener read
  cursors and advances `head` to `min(cursors)` (reclaim watermark) — only
  the consumption surface changes, not the storage layout. Documented, not
  implemented.
- **A3 — Worker-tier readiness.** Structured-clone-safety is **enforced**
  for `'summary'` and `'clone'` envelopes — property-tested:
  `structuredClone(envelope)` never throws (so the queue can later move
  across a worker boundary as a transport swap). `'ref'` is exempt by
  definition and documented as such.
- **A4 — Stats object** (consumed by Block 9):
  `{ depth, drops, flushes, budgetExhausted, p95FlushMs, inlineDeliveries,
  inflight, perListener: { id: { events, totalMs, lastFlushMs } } }` — a
  pure getter on the dispatcher (`getStats()`).

## Payload summarizer bounds (Block 1, documented contract)

Built ON TOP of the `summarize.ts` classification path (one code path with
the `__readSummary`/`__writeSummary` retention markers), extended with
bounded structural descent. Bounds constants: `PAYLOAD_SUMMARY_MAX_DEPTH` /
`MAX_ENTRIES` / `MAX_NODES` are exported from `capture/envelope.ts`;
`SUMMARY_PREVIEW_LENGTH` from `capture/summarize.ts` (all via the `capture/` barrel):

| Bound | Value | On overflow |
|---|---|---|
| Depth | `PAYLOAD_SUMMARY_MAX_DEPTH` = 3 | leaf with `depthClipped: true` |
| Breadth per level | `PAYLOAD_SUMMARY_MAX_ENTRIES` = 16 | `truncated: true` (honest `size` keeps the real count) |
| Total nodes per payload | `PAYLOAD_SUMMARY_MAX_NODES` = 128 | `truncated: true` |
| String preview | `SUMMARY_PREVIEW_LENGTH` = 80 chars | sliced |

Safety properties (tested): cycle-safe (`circular: true`), throwing-getter
safe (`'unreadable'` leaf), prototype-pollution safe (`__proto__` keys become
own data properties via `Object.fromEntries`), symbol keys ignored
(`Object.keys` semantics), `Map`/`Set` are leaves with their real entry
count. Output is reference-free and structured-clone-safe **by
construction** — every node is a fresh object of primitives.

## Module map (Blocks 1–5 — all pure, ZERO engine imports)

| Block | File | Owns |
|---|---|---|
| 1 | `src/lib/capture/envelope.ts` | `CaptureEnvelope`, `CapturePolicy`, `capture()`, `summarizePayload()` |
| 2 | `src/lib/observer-queue/ring.ts` | `BoundedRing<T>`, `OverflowPolicy`, loss counters |
| 3 | `src/lib/observer-queue/mergedQueue.ts` | seq stamping, 3-channel merge, enqueue outcomes |
| 4 | `src/lib/observer-queue/flushDriver.ts` | armed-once `queueMicrotask` batcher, `flushBudgetMs`, `flushSync` |
| 5 | `src/lib/observer-queue/deferredDispatcher.ts` | listener registry, isolation, inflight, `drain`, A4 stats |

Import discipline: `observer-queue/` may import only `../capture/` and its
own files; `capture/` imports nothing outside itself. The barrel
(`observer-queue/index.ts`) is **internal** — not exported from the public
footprintjs barrels until Block 6.

## Acceptance criteria per block (all shipped + green)

- **B1** — property: envelope survives source-object mutation after capture
  (`'summary'` + `'clone'`); A3 structured-clone-safety property; summarizer
  bound properties (depth/breadth/nodes/preview); security: sentinel
  isolation (no live refs anywhere in a `'summary'` envelope; `'ref'` bypass
  documented + warned); perf: capture ≤ 2µs p95 for a small payload.
- **B2** — property: size ≤ capacity under random push/drain; conservation
  `pushes === delivered + drops + rejections + size`; per-policy behavior;
  seq-gap detectability under `drop-oldest`.
- **B3** — property: randomized interleavings across 3 channels drain in
  push order (≥100 trials); gap count == drop counter.
- **B4** — fake-clock driven (injected `now()` — no real sleeps): N pushes ⇒
  1 flush; re-arms; listener-emitted events land NEXT flush; budget cut
  stops + re-arms; `Infinity` drains fully; `flushSync` cascade rounds with
  `maxRounds` runaway cap.
- **B5** — slow/throwing/rejecting listener never delays or kills producer
  or siblings; rejection routed to the error callback; inflight
  `drain({ timeoutMs })` settles (honest `pending` on timeout); per-listener
  stats accurate; FIFO per listener; `'block'` inline delivery + ordering
  caveat; perf: 1k no-op-listener flush ≤ 1ms p95.

## Blocks 6–10 (engine wiring — NOT in this change)

What the wiring needs from this module (all present):

1. `DeferredDispatcher` as the single attach point: Block 6 constructs one
   per executor, binds `CaptureHooks.warn` to `isDevMode()`, routes
   `onError` into the existing recorder error channel, and adapts the three
   dispatchers (`Recorder`/`FlowRecorder`/`EmitRecorder` hooks → 
   `dispatcher.capture({ channel, method, runtimeStageId, runId, payload })`).
2. Terminal flush: call `flushNow()` at run end (`onRunEnd`/`onRunFailed`
   boundaries) and `await drain({ timeoutMs })` on shutdown so the
   "one beat behind" never becomes "lost at exit".
3. Per-event policy override seam: committed-state reads may pass `'ref'`
   (immutable-after-swap, #13/#13b); everything else defaults to
   `'summary'`.
4. Byte-identity gate: wired-but-synchronous-compat mode must reproduce
   today's narratives byte-identically before deferral becomes a default.
5. Block 9 reads `getStats()` (A4) for the observability surface.

## Roadmap (v1.1 / v2)

- **Per-listener cursors (v1.1).** Replace destructive `shift()` with
  per-listener read cursors over the retained ring window; reclaim at
  `min(cursors)`. Slow listeners then lag without forcing the global drop
  policy; per-listener drop accounting follows. Storage layout already
  cursor-ready (A2).
- **Adaptive rule pack over stats.** A small policy engine reading the A4
  stats (e.g. budget-exhausted streak ⇒ widen budget; chronic backlog ⇒
  switch overflow to `sample`), with **every adaptation emitted as a typed
  event** on the emit channel — self-tuning that stays on the record.
- **agentfootprint one-consumer collapse.** agentfootprint attaches many
  recorders today; with deferred delivery it can collapse to ONE deferred
  listener that fans out internally — one queue traversal, one isolation
  boundary, one stats row per concern.
- **Worker tier as a transport swap.** A3 guarantees envelopes survive
  `structuredClone` — the worker boundary (postMessage) becomes a transport
  detail behind the same listener interface; the engine thread keeps only
  capture + enqueue.

## FAQ

- **"One beat behind" — how far behind, exactly?** At most one scheduling
  checkpoint. The engine `await`s every stage function, so the microtask
  queue runs at **every stage boundary** even in pure-CPU charts — see
  [execution-model.md — "Stage boundaries are scheduling points"](../guides/execution-model.md#stage-boundaries-are-scheduling-points).
  A flush armed during stage N runs before stage N+1's body; with budget
  cuts, the tail lands at the following boundaries.
- **Can a listener starve the run?** No. The flush drains a snapshot under
  `flushBudgetMs`; listener-emitted events go to the next checkpoint; a
  runaway self-enqueueing listener is capped by `flushSync`'s `maxRounds`
  at terminal flush.
- **Can I lose events without noticing?** No. Every loss increments
  `drops` (stats) and leaves a `seq` gap (per-event evidence). `'block'`
  loses nothing, at the price of inline (synchronous) delivery for
  overflow events.
- **What does a paused/failed run deliver?** Wiring concern (Blocks 6–10):
  the terminal flush hooks `onRunEnd`/`onRunFailed`/pause boundaries so the
  queue is drained before the executor yields control.
- **Is the envelope mine to mutate?** Envelopes are shallow-frozen and
  SHARED across listeners. Don't mutate `payload` — a later listener sees
  your edits. (`'summary'`/`'clone'` payloads are detached from the engine,
  so you can't corrupt engine state — only your sibling observers' view.)
