# ADR-001: Emit Channel — Pass-Through, Not Buffered

**Status:** Accepted (Phase 3)
**Date:** 2026-04-17
**Context:** introducing the third observer channel — `EmitRecorder` + `scope.$emit(name, payload)` — to the library.

## Decision

The emit channel uses **pass-through semantics**. Calling `scope.$emit(name, payload)` synchronously dispatches to every attached `EmitRecorder.onEmit(event)` in call order. No buffering at the scope / stage / executor layer. Recorders are responsible for any accumulation they need.

## Alternative considered — side-bag (buffered)

`$emit(name, payload)` could instead have written to a `DiagnosticCollector`-style bag on `StageContext` and flushed to recorders at stage end. This would mirror the existing (and architecturally broken) pattern that `$debug` / `$metric` already use, where calls land in `logContext` / `metricContext` / `errorContext` / `evalContext` and surface only in the final snapshot.

## Why pass-through won

Seven-perspective review (preserved at `docs/internals/adr-001-review.md` notes) unanimously voted pass-through. Condensed reasoning:

### 1. Matches existing library pattern

`Recorder.onRead` and `onWrite` already dispatch synchronously — consumers expect "call-site = observation-site". The second rendered channel (`FlowRecorder`) also dispatches synchronously from the traverser. Adding a buffered third channel would introduce a new semantics for consumers to reason about ("when does my recorder actually see the event?"). Keeping pass-through means the mental model stays: **one event produced → one event consumed, now**.

### 2. Zero-allocation on the cold path

Pass-through with a fast-path check (`if (this._recorders.length === 0) return`) costs a single integer comparison when no recorder is attached. Buffering allocates a bag array per stage regardless of whether any recorder is listening. For high-frequency call sites (a loop firing `$emit` per iteration), buffering grows unboundedly per stage even when no observer cares.

### 3. No "stuck events" on stage error

A stage that throws after emitting would leave events in the bag unflushed (or leaked into snapshot depending on implementation). Pass-through delivers at call time — a later throw doesn't retroactively hide already-observed events.

### 4. OpenTelemetry / standard observability interop

OTel and most standard observability adapters expect synchronous event delivery; they handle their own batching in their exporters. Adding library-level buffering forces double-buffering (bag → flush → OTel batch) and complicates event-on-error semantics. Pass-through is the natural adapter shape.

### 5. Functional purity

A pure function of `(name, payload, recorders[])`. Trivially testable. Stateful buffering introduces lifecycle reasoning that must be coordinated across stage boundaries — harder to test, harder to reason about.

### 6. Concurrency / async

Scope operations are synchronous; `$emit` should be too. A buffered model has to answer "what if an async stage body keeps emitting after the bag was flushed at stage end?" — ambiguity. Pass-through: no such question.

### 7. Industry precedent

Node.js `EventEmitter`, Redux middleware, React Fiber pre-commit event dispatch, RxJS `Subject` — all pass-through for in-process ephemeral events. Buffering only appears when there is a durability or replay requirement (Kafka, event sourcing, WAL) — none of which apply to a single-run flowchart executor.

## Consequences

**Positive:**
- Uniform dispatch semantics across all three recorder channels.
- Zero cost in the unattached case.
- Simple mental model for consumers.
- Natural interop with standard observability tooling.

**Negative (accepted tradeoffs):**
- If a consumer attaches a recorder AFTER some emits have fired, they miss those. This mirrors how `onRead` / `onWrite` behave today — attach BEFORE `run()`. Documented contract.
- Consumers who want snapshot-style collection must implement a `CollectingEmitRecorder` and attach it. The library could ship one as a convenience helper (deferred to Phase 3.X).

## References

- Implementation: `src/lib/scope/ScopeFacade.ts::emitEvent()`
- Interface: `src/lib/recorder/EmitRecorder.ts`
- Example: `examples/runtime-features/emit/01-custom-events.ts`
- Tests: `test/lib/recorder/EmitRecorder.test.ts`
