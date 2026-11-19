# Follow a write with `explain`

Enable `explain(true)` before a run when you need to follow a recorded write through earlier reads and local subflow handoffs. The engine gathers evidence as the chart runs. Foottrace 2.2.0 can check whether the available evidence covers the question. This uses no model calls.

Import `explain` from `footprintjs/explain` and pass `explain(true, hostOptions)` as the executor's options. It fills the settings the host left unset with full reads, read prefixes for writes, nested member reads, bounded scalar read sources, input/output/fan-out handoffs and capture coverage. Explicit host settings and evidence limits still apply. Coverage is required when the switch is on. With the switch omitted or `false`, the executor uses the host's original options. Redaction and storage are controlled separately.

## Ask about one live log

Run the [payment example](../../examples/post-execution/causal-chain/07-explain-coverage.ts) from a built checkout:

```bash
node --import tsx examples/post-execution/causal-chain/07-explain-coverage.ts
```

The payment child writes `txnId`. Its output mapper copies the value to the parent's `receipt`. The example finds the receipt's exact mount invocation, then passes the child's commit log, capture note and `captureWitnessOf(child.treeContext)` to `createRecordGraph` from `foottrace/cause`. Foottrace's `captureCoverage` reports `covered` for full reads over that child's recorded interval. The graph also names the child writer through the observed output handoff. Re-running the same chart without the switch yields `collection-unknown` for interval coverage. The receipt query stays at the mount boundary and reports a `not-collected` gap.

For the root log, call `captureWitnessOf(snapshot)`. For a child, call it on the exact served `treeContext` selected by the mount's runtime stage ID. The witness binds one native log address, producing run and half-open commit interval. A parent witness cannot attest its child's log. A spread, clone, JSON round trip or reopened saved record has no live witness. Saved coverage needs separate admitted storage evidence.

`covered` licenses a negative statement scoped to the query. With zero matching observations, you can say “no matching recorded read in this interval” for the requested channel and mode. Full reads here describe tracked state and its retained stage views. Untracked data, arithmetic, intent and outside outcomes need their own evidence. A recorded read before a write establishes an access in the recorded prefix. Privacy, partial capture, missing children and transport boundaries can prevent a coverage claim. An explicit disabled channel gives `not-collected`. An absent or unverifiable note leaves coverage `collection-unknown`.

Nested-read coverage applies to accesses the scope handles. It records tracked member reads and marks the channel partial when it hands out a raw value, unless a stronger limitation applies.

Host operations can reach the object behind a scope proxy without invoking its traps. Examples include Node's `util.inspect`, the object formatting used by `console.log`, and debugger inspection. A value taken from that output lies outside the guarantee of `covered`.

## Measured cost

The design measured 600 runs per arm after warmup on Node 24.21.0 on an Apple M5 Pro. The on arm used the preset's capture settings before the version 3 note and witness were added.

| Chart | Bytes per commit, off → on | Mean milliseconds per run, off → on |
| --- | ---: | ---: |
| [Payment output handoff](../../examples/post-execution/causal-chain/06-subflow-output-handoff.ts) | 634.2 → 1,645.5 | 0.078 → 0.142 |
| [Three-branch review](../../examples/runtime-features/parallel-for-each/01-fan-out-per-item.ts) | 989.1 → 1,977.6 | 0.224 → 0.397 |

Bytes are the UTF-8 JSON snapshot size per distinct root or child commit, including seeds. Time covers executor creation, execution and the first snapshot. Serialization, disk I/O, UI rendering and the final coverage metadata were outside this measurement.
