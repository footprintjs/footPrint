---
paths:
  - "src/lib/memory/attention.ts"
  - "src/lib/memory/StageContext.ts"
  - "test/lib/engine/**"
---

# Stage attention — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-098"></a>

## Stage attention (C2)

<a id="cl-099"></a>

`memory/attention.ts · StageAttention` owns attention bookkeeping; `StageContext` holds one helper and delegates at retained attempt/summary/error boundaries. Import shared `Attention` from Foottrace root without a FootPrint re-export. Use the official `buildAttemptId`/`parseAttemptId` codec, preserving owning execution and call identity; no `attempts:N` alias. Reset on a new execution and preserve across retries. Snapshot export only copies bounded marks (32 marks, 16 refs each), never scans attempts or classifies arbitrary diagnostic values. Missing proof stays `not-collected`; observed SDK suggestions are not actual retry decisions, and physical helper stops are not logical exhaustion. The engine must not inspect attached recorders or infer their quality. Quality rows remain recorder-owned and may be adapted at read time. No implicit outlier detector or new crash-safe attention format. Guide: `docs/guides/attention.md`; runnable example: `examples/runtime-features/attention/01-stage-attention.ts`.
