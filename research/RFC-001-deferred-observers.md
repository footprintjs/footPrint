# RFC-001 — Deferred Observer Delivery ("one beat behind")

*Design doc + implementation plan. Companion to `observer-channels-study.md` (channel taxonomy,
payload-mutability verification, precedent survey §7). Status: proposed. June 2026.*

---

## 1. Summary

Give every recorder/listener an opt-in `delivery: 'deferred'` mode in which the engine **captures**
an immutable envelope inline (microseconds), **enqueues** it on one bounded, merged, totally-ordered
queue, and **delivers** it in batches at the next microtask checkpoint — so observer cost leaves the
traversal's critical path. Inline delivery remains the default; nothing breaks. The platform supplies
the *when* (`queueMicrotask`); footprintjs supplies the guarantees that make it evidence-grade:
frozen payloads, total order, honest bounds, terminal flush.

**One-line claim:** bounded-staleness delivery with terminal flush preserves narrative byte-identity
for all Class-A consumers while removing listener latency from per-stage cost.

---

## 2. Problem

All four observer channels dispatch synchronously, inline with traversal (verified:
`FlowRecorderDispatcher` loops; `ScopeFacade._invokeHook` at :495/:535/:560; `emitEvent` documented
"delivered synchronously"). Error isolation exists (try/catch); **latency isolation does not**.

Consequences, quantified for the primary workload (full-feature agent, 50 iterations):
- Event volume: C4 emit ≈ 10⁴–10⁵ (token-dominated), C2 scope ops ≈ 10³–10⁴, C3 flow ≈ 10²–10³.
- Run latency penalty = Σ(handler time × event count). A 5 ms handler on stream tokens at 10⁴
  events adds ~50 s to a run.
- agentfootprint's `EmitBridge → EventDispatcher → user listeners` chain rides the same stack, so
  every consumer `.on()` handler is on the engine's hot path today.

Single-thread reality: an "immediate" listener runs *instead of* the engine's next line. If the
engine must not pause, some deferral is logically unavoidable; the microtask is the smallest
deferral the platform offers (runs at the engine's own next `await` boundary — not a timer).
Because agent stages are I/O-dominated (LLM/tool calls), batched listener work largely executes
**inside the engine's network-wait idle time** — near-zero added wall-clock.

---

## 3. Goals / non-goals

**Goals**
1. Deferred-tier listeners cannot add per-stage latency beyond capture cost (~µs/event).
2. Zero breaking changes: absent opt-in ⇒ byte-identical behavior, full existing suite green.
3. Preserve the three invariants (study §3): cross-channel total order; redaction-at-source;
   terminal completeness (`await run()` resolves ⇒ everything delivered — including error & pause).
4. Honest loss accounting: bounded queue, explicit policy, counters surfaced as evidence.
5. Same code path in Node and browser (Lens / AgentThinkingUI) — `queueMicrotask` only.

**Non-goals (v1)**
- True parallelism for CPU-heavy listeners (worker tier — future, §12).
- Replacing inline tier for engine-internal recorders (narrative/metrics stay inline by default).
- Cross-process delivery (OTLP exporter is a separate track — BACKLOG #19).
- Changing what events exist or their payload shapes.

---

## 4. Background (from the channels study — read it first)

- **Class A** payloads are already immutable at source (CommitBundle, CommitEvent mutations, all
  C3 flow events incl. decide() evidence via `summarizeValue`) → defer free.
- **Class B** payloads carry live refs (C2 onRead/onWrite values, C4 emit object payloads,
  run-boundary payloads) → need capture-at-source policy.
- **Class C** is out of scope (build-time StructureRecorder, redaction decisions, pause signal).
- Precedents (study §7): DOM Mutation Events → MutationObserver (sync tree observers deprecated
  platform-wide; replacement = immutable change records, batched, one microtask behind); DB row
  triggers → CDC consumers; DataLoader microtask batching; React useLayoutEffect/useEffect two-tier.

---

## 5. Design

### 5.1 Data flow

```
            INLINE (µs, on traversal path)              │   DEFERRED (microtask checkpoint)
                                                        │
 dispatch site ──► tier router ──► capture() ──► merged ring ──► flush ──► dispatcher ──► listeners
 (scope·flow·emit)  (B6)            (B1)          (B2+B3)   │    (B4)       (B5)
        │                                                   │
        └── inline tier (default): direct call, unchanged ──┘
 run end · run failed · pause ──► terminal flush (B8) — drain before returning
 ring internals ──► counters {depth, drops, flushMs} on snapshot (B9)
```

### 5.2 Core types

```ts
interface CaptureEnvelope {
  readonly seq: number;                  // arrival stamp — total order across channels
  readonly channel: 'scope' | 'flow' | 'emit';
  readonly method: string;               // 'onWrite' | 'onStageExecuted' | 'onEmit' | ...
  readonly runtimeStageId: string;
  readonly runId: string;
  readonly payload: unknown;             // per capture policy — never a live engine ref
  readonly capturedAt: number;
}

type CapturePolicy = 'summary' | 'clone' | 'ref';
type OverflowPolicy = 'block' | 'drop-oldest' | 'sample';

interface DeferredOptions {
  delivery?: 'inline' | 'deferred';      // absent ⇒ 'inline' (today's exact path)
  capture?: CapturePolicy;               // default 'summary' (the evidence.ts pattern)
  maxQueue?: number;                     // default 10_000
  overflow?: OverflowPolicy;             // default 'drop-oldest'
}
```

### 5.3 Semantics (normative)

- **Ordering:** one merged queue; `seq` assigned at capture under the engine's single thread ⇒
  drain order == arrival order across all channels. Per-listener delivery is in-order.
- **Scheduling:** `enqueue` arms at most ONE pending flush (`armed` flag). Flush drains a snapshot
  (`splice(0)`); events enqueued *by listeners during flush* go to the next checkpoint (no
  starvation/infinite flush).
- **Capture:** runs strictly AFTER the redaction decision at the dispatch site. `'summary'` uses
  `summarizeValue` (bounded, ref-free); `'clone'` = `structuredClone`; `'ref'` = pass-through,
  caller asserts immutability (legit for token strings). Dev-mode warns when `'ref'` receives a
  mutable object.
- **Backpressure:** ring at `maxQueue`; policy applies; every loss increments `drops` — surfaced,
  never silent. `'block'` is provided for audit-mandatory consumers and documented as
  "re-introduces blocking by your explicit choice."
- **Terminal flush:** `onRunEnd`, `onRunFailed`, and the pause path drain the queue synchronously
  before `run()` returns/rejects. Guarantee restored: post-run reads are complete and identical to
  inline mode for the same events.
- **Error isolation:** unchanged per-listener try/catch; a throwing listener affects neither
  siblings nor producer. Async listener rejections are caught via `Promise.resolve(r).catch`
  routing to the existing error path (closes today's unhandled-rejection hole).
- **runId discipline:** envelopes carry `runId`; the queue is drained at run start (Convention 4)
  so cross-run leakage is impossible even if a consumer never drains.
- **Mid-run reads:** deferred consumers observe bounded staleness (≤ one checkpoint). Documented;
  topology/live-status consumers already advertise "live-queryable" semantics compatible with this.

### 5.4 Public API (additive only)

```ts
// footprintjs — all existing calls unchanged; options are NEW and optional:
executor.attachFlowRecorder(rec, { delivery: 'deferred' });          // options-bag form
executor.attachCombinedRecorder({ id: 'x', delivery: 'deferred', onEmit });  // field form
snapshot.observerStats; // { depth, drops, flushes, p95FlushMs }      // B9

// agentfootprint — EmitBridge gains the same option; default unchanged in v6:
agent.observe({ delivery: 'deferred' });   // opt-in minor; default flip in next major
```

Compatibility contract: no `delivery` ⇒ the literal pre-RFC code path. The no-breakage proof gate
is CI running the ENTIRE existing suite with zero opt-ins and asserting narrative byte-identity.

---

### 5.5 Listener contract — sync and async, one signature

The deferred tier makes "passive observer" an enforced property rather than a convention: a
listener cannot crash the run (isolation), cannot slow it (capture-only inline cost), cannot
corrupt what others see (frozen envelopes), cannot reorder history (`seq`), cannot leak across
runs (runId drain). Fire-and-forget from the engine's perspective; delivered-or-accounted from
the consumer's (terminal flush + drop counters). Two deliberate exceptions: `overflow: 'block'`
re-couples by explicit choice, and CPU-heavy listeners still own the thread during their flush
slot (passive ≠ free — worker tier is the escalation).

**One public signature** — `(envelope) => void | Promise<void>`. No sync/async registration split;
the dispatcher normalizes:

```ts
const inflight = new Set<Promise<void>>();
function invoke(listener: DeferredListener, env: CaptureEnvelope) {
  try {
    const r = listener.onEvent(env);
    if (r && typeof (r as Promise<void>).then === 'function') {
      const p = (r as Promise<void>).catch(routeToErrorPath)   // rule 2
                 .finally(() => inflight.delete(p));
      inflight.add(p);                                          // tracked, NOT awaited
    }
  } catch (e) { routeToErrorPath(e); }                          // sync throw
}
```

Normative rules:
1. **The flush never awaits listeners.** Awaiting would let one slow async listener delay the
   batch and the next checkpoint — coupling re-introduced sideways. Flush invokes in order and
   moves on; async continuations rejoin the event loop like any other promise.
2. **Rejections are caught and routed** to the error path. (This fixes a pre-existing hole: in
   today's inline design an async recorder's rejection escapes the try/catch as an unhandled
   rejection.)
3. **Terminal flush guarantees invocation; completion is a knob.** `await
   executor.drainObservers({ timeoutMs })` = `Promise.allSettled([...inflight])` with timeout
   (same shape as `flushAllDetached`). Default off — a durable listener's persistence is its own
   contract. Mandatory in serverless (§11).
4. Invocation order is guaranteed per listener; an async listener's *internal* processing may
   interleave across its own awaits — consumers needing strict serial processing chain
   internally (future option: `serial: true`).

## 6. Why this way — alternatives considered

| Alternative | Verdict |
|---|---|
| Wrap dispatch in bare `queueMicrotask` | Broken: listeners read live refs one beat late (torn state); no bounds; one microtask per event; loss on crash. "Later" without "safely later." |
| Full `structuredClone` per event | Re-adds the clone tax the perf track (#13/#14) removes; capture policies subsume it as opt-in. |
| Proxy snapshot (original idea v0) | No isolation — lazy reads see the future. Rejected in discussion; capture-at-source is the corrected form. |
| Per-channel queues | Breaks cross-channel total order that narrative flush + Lens bracket-pairing rely on. |
| Worker-first | Real parallelism but serialization cost + can't share live anything; correct as tier 2 AFTER envelopes exist (envelope ≈ wire format already). |
| OTLP-only (export, no local tier) | Loses local zero-dep consumers (UIs, tests); complements rather than replaces. |
| `setTimeout(0)` / `setImmediate` | Macrotask: later than needed, timer clamping in browsers, different Node/browser behavior. Microtask is the earliest portable slot. |

Precedent alignment: this is the MutationObserver/CDC/DataLoader shape with one addition the
precedents lack — **terminal flush as a hard guarantee**, required because footprint's consumers are
evidence systems, not best-effort telemetry.

---

## 7. Implementation plan — ten blocks, each shippable & testable alone

> File layout: `src/lib/observer-queue/{envelope.ts, ring.ts, mergedQueue.ts, flushDriver.ts,
> deferredDispatcher.ts, index.ts}` — Blocks 1–5 have ZERO engine imports.

| # | Block | Builds on | Deliverable | Acceptance test | Effort |
|---|---|---|---|---|---|
| 1 | `capture()` + `CaptureEnvelope` | — | pure fn, 3 policies (reuse `summarizeValue`) | property: envelope survives source mutation; redacted values never captured | S |
| 2 | `BoundedRing` | — | push/drain, 3 overflow policies, counters | property: size ≤ cap; pushes − drains == drops | S |
| 3 | `MergedQueue` | 2 | seq stamping, 4-channel merge | fast-check: random interleavings drain in push order | S |
| 4 | `FlushDriver` | 3 | armed-once `queueMicrotask` batcher | fake-clock: N pushes ⇒ 1 flush; re-arms; listener-emitted events go to NEXT flush | S |
| 5 | `DeferredDispatcher` | 1–4 | capture→enqueue→flush→invoke + isolation (sync throw AND async rejection) | slow/throwing/rejecting listener never delays or kills producer | S/M |
| 6 | Tier router in `attach*` | 5 | `delivery` field + options-bag; absent ⇒ inline | **gate:** full existing suite green, narrative byte-identical, zero opt-ins | S |
| 7 | Wire 3 dispatch sites | 6 | ScopeFacade · FlowRecorderDispatcher · emitEvent route deferred tier; capture after redaction | property: no pre-redaction value in any envelope | M |
| 8 | Terminal flush | 7 | drain on onRunEnd/onRunFailed/pause before return | crash mid-stage ⇒ all events delivered before rejection; pause ⇒ before getCheckpoint() | S/M |
| 9 | `observerStats` on snapshot | 8 | depth/drops/flushes/p95FlushMs | forced-drop scenario shows true counters | S |
| 10 | agentfootprint opt-in + bench | 9 | EmitBridge `delivery` option; bench | p95 traversal latency, 5 ms listener × 10⁴ events, inline vs deferred | M |

Stop-anywhere property: after any block the repo is releasable; blocks 1–5 can ship as an internal
module before any engine line changes.

### Test plan per Convention 3 (all seven types)
Unit (each block) · Functional (deferred recorder end-to-end on a real chart) · Integration
(agent chart + Lens-style consumer) · Property (ordering, bounds, no-pre-redaction, envelope
immutability — fast-check) · Security (redaction-order, `'ref'` misuse dev-warn, no PII in dropped
-event counters) · Performance (capture ≤ 2µs p95; flush batch 1k ≤ 1ms p95) · Load (10⁵ emits,
bounded RSS, drop counters exact). Per Convention 2: `examples/runtime-features/deferred-observers/`
01-basic · 02-backpressure · 03-terminal-flush · 04-slow-listener-bench — examples ARE the
integration layer.

---

## 8. Success metrics

1. **Latency:** p95 per-stage traversal overhead with a 5 ms deferred listener ≤ 1.1× no-listener
   baseline (vs ≥ stage+5 ms inline).
2. **Fidelity:** narrative byte-identity for Class-A consumers, inline vs deferred (golden test).
3. **Completeness:** 0 lost events across 10⁴ randomized crash/pause injections (terminal flush).
4. **Honesty:** forced-overflow runs report exact drop counts; no silent loss path exists.
5. **Compatibility:** existing suites of footprintjs AND agentfootprint pass unmodified with the
   feature merged and nobody opted in.

## 9. Risks & mitigations

- **Summary-policy loses payload fidelity for some consumer** → per-recorder `capture: 'clone'`;
  doc the trade; B-class "delta-pointer into commitLog" is the future zero-copy fix (study §6).
- **Pure-CPU pipelines see listener cost between stages anyway** → stated honestly (single
  thread); worker tier is the escalation; bench includes a CPU-only chart to keep us honest.
- **`'block'` overflow reintroduces stalls** → loud doc + dev-mode warn on first block event.
- **Ordering bug class** (flush re-entrancy, pause interleavings) → property tests are the
  primary defense; #15 trampoline lands in the same region — sequence this AFTER #7/#15 merge
  windows to avoid double-churn in the traverser.
- **Two dispatch paths drift** → inline and deferred share the SAME per-listener invoke helper;
  only scheduling differs.

## 10. Rollout

1. footprintjs **minor**: blocks 1–9, default inline, docs (`docs/guides/observers-deferred.md`).
2. agentfootprint **minor**: EmitBridge opt-in + bench published in README (the headline number).
3. agentfootprint **next major**: deferred becomes EmitBridge default; migration note (mid-run
   timing only; order & completeness unchanged).
4. Paper/post: "Deprecating synchronous observers in an evidence engine" — study §7 is related
   work; metric #1–#3 are the results table.

## 11. Serverless / stateless runtimes (AWS Lambda et al.)

Lambda is the design's strictest test — and it passes by construction, with one added rule.

**Execution model:** one container serves one request at a time; when the handler's promise
resolves the container is **frozen** — pending timers and in-flight promises stop mid-air and may
thaw inside a *later* invocation on the same warm container (the classic serverless
background-work bug).

**Why the design survives:**
1. **Terminal flush (B8) is the Lambda safety guarantee.** The queue drains synchronously before
   `run()` returns — no envelopes frozen on the rail, nothing thawing into the next request.
   Without B8 this design would be unusable in Lambda; with it, it is safe by construction.
2. **Async listeners are the one thing the consumer must close.** Un-awaited listener promises
   freeze mid-flight. The serverless pattern makes §5.5 rule 3 mandatory:

   ```ts
   export const handler = async (event) => {
     const executor = new FlowChartExecutor(chart);   // per-invocation — stateless
     try {
       return await executor.run({ input: event });
     } finally {
       await executor.drainObservers({ timeoutMs: 2000 });
     }
   };
   ```
3. **Billing alignment.** Lambda bills wall-clock; agent stages are LLM/network waits where the
   paid-for CPU is idle. Deferred listener work executes inside those gaps — zero added duration,
   zero added cost in the common case.
4. **Statelessness is the documented pattern anyway.** Executor-per-invocation (envelope doc #2)
   is enforced for free by Lambda's concurrency model; warm-container ghosts are neutralized by
   runId discipline (envelopes carry `runId`; queue drains at run start, Convention 4).
5. **Pause/resume composes.** Checkpoints are JSON-safe and cross-executor; terminal flush fires
   on the pause path, so the observer story closes before the checkpoint leaves the container.

**Escalation for durability:** telemetry that must survive timeout/OOM kill needs the
out-of-process tier — a future detach driver targeting SQS/EventBridge, or the OTel exporter
(BACKLOG #19) to a collector/extension. Same envelopes, different transport — one more reason to
align the envelope shape with OTel GenAI attributes (§12).

## 12. Open questions

- Expose `stateAt(runtimeStageId)` (commitLog-prefix replay) for deferred consumers needing
  state reads? (Engine-side time-travel — study §6.)
- Should `CombinedNarrativeRecorder` get a deferred mode post-byte-identity proof, or stay inline
  forever as the reference consumer?
- Envelope as wire format: alignment pass with OTel GenAI attributes before #19 lands so one
  shape serves both.
