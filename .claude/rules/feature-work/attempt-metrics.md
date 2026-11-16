---
paths:
  - "src/lib/recorder/AttemptRecorder.ts"
  - "src/lib/recorder/attempt*.ts"
  - "test/lib/recorder/**"
---

# Attempt metrics — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-093"></a>

## Attempt metrics (10.1, P7)

<a id="cl-094"></a>

`recorder/AttemptRecorder.ts` owns the opt-in `attempts()` flow recorder (`footprintjs/recorders`). It composes
`KeyedStore` and collects named scalar rows at onAttempt/onDecision/run lifecycle time, never by walking a tree.
`attemptMetrics.ts` aggregates exact retained facts and nearest-rank latency; `attemptMetricRows.ts` is the single
live/store row admission boundary; `attemptOTel.ts` projects typed histogram/sum JSON. Keys, inputs, outputs, error
text/raw causes and unknown envelope fields never enter metric rows. Physical IDs/outcomes stay physical; explicit
logical controls use recorded retryLoop decisions. Kinds remain visible when target names collide. Memory rows,
exemplars and all owned I/O are bounded; asynchronous losses/timeouts remain disclosed. A timed-out I/O retains its
slot until actual settlement. Sum of durations is work time, not wall-clock budget; absent original budget stays
absent. Governing guide: docs/guides/attempt-metrics.md; source rules: src/lib/recorder/README.md.

<a id="cl-095"></a>

P7 admission reads plain own data descriptors (including nested loops and array windows) before field access;
external getters/coercion hooks never run. Stored logical decisions join exact physical IDs/targets/loop identity.
`AttemptMetricRef` preserves the compact existing `AttemptRef`; target, run and OTLP views retain nonzero exemplar
capacity. Optional store `stats()` discloses known retention omissions, including reference-memory truncation.

<a id="cl-096"></a>

Queued-sibling re-raise notifications use current-leg root context at `FlowchartTraverser.walkThenRaise`; they do
not pretend the sibling re-executed or overwrite its original pausedExecution link. P7 pause lifecycle updates are
idempotent across sibling hooks, exact run IDs isolate shared recorders, and a real failure can supersede a pause.

<a id="cl-097"></a>

A shared recorder's auto-clear preserves already-emitted rows for active/paused ownership; completed projections
reset normally. Keep omission accounting while active ownership exists, never rebuild an apparently complete empty
run header after deleting its attempts. All retained row/identity maps remain bounded.
