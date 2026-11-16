---
paths:
  - "src/lib/memory/**"
  - "src/lib/engine/**"
  - "src/lib/runner/**"
  - "src/lib/recorder/**"
---

# Invariants — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-070"></a>

## Invariants (assumed, not stated)

<a id="cl-071"></a>

- **The admitted record (9.30.0)** — a commit's bundle, replayed onto the state its stage began from, gives back the stage's read-your-writes view (its working copy, by `deepEqual`, as a record can hold it — through `structuredClone`, so an `Error`'s dropped own fields never count) at every path it touched and at every container and array slot its writes made on the way there, below the stage's address (`runs/<id>` is where a namespaced stage writes, not a value it reads). VERIFIED for every commit that staged a `merge` or a nested op (foottrace's `TransactionBuffer · admit` → `admission.ts · lossyFamilies`: one `dryFold`, no clone, families of TOUCHED paths compared at their roots); a family that does not fold back is re-encoded as `set` rows of the read-back at its last touch (`emitReadBack`). BY CONSTRUCTION for a stage of `set`/`delete` only, directly under its address (no fold). Every commit that already folded back keeps its bytes. NOT covered: an in-place edit of a value the stage read but never wrote at or above (M2 — still lost), and readers (`commitValueAt`) that disagree with the fold. Pinned by foottrace's record-equals-read-back property (independent oracle) and, end to end on both engines, by the witness in test/lib/memory/property/copy-on-write-fixture.ts.

<a id="cl-072"></a>

- Committed state immutable-after-swap — a generation is NEVER edited, and since 9.29.0 generations SHARE every untouched subtree (copy-on-write). First-touch views AND the transaction buffer's net-change diff base hold bare references on that guarantee — an in-place mutation of a committed container corrupts every generation that shares it and blinds the diff. Every writer copies before it writes (foottrace's `pathOps · ownSpine` / `ownedRootOf`); pinned by the generations property in test/lib/memory/scenario/copy-on-write-commit.test.ts and the counted guard in test/lib/memory/boundary/commit-cost-independent-of-state.test.ts.

<a id="cl-073"></a>

- Reads are borrowed live references (recorders get them un-cloned) — never mutate.

<a id="cl-074"></a>

- The commit log is never the reader's to edit. Foottrace owns `freezeRecord` (`foottrace/write`) and `serveRecord` (`foottrace`), including copy-on-serve handling for values freezing cannot seal. `runner/snapshot.ts · servedSnapshot` serves `getSnapshot().commitLog` / `.initialState` through that shared law. The engine's internal snapshot (`ExecutionRuntime · getSnapshot`, via `EventLog.recorded`, once per subflow mount) is not a served public record. Known open surfaces are unchanged by extraction: the advanced runtime snapshot, subflow results, execution-tree reads/writes/diagnostics/messages, recorder rows, checkpoints and narrative entries are not all covered by this served-record law. Pinned by `test/lib/memory/scenario/served-record-doors.test.ts` and its property companion.

<a id="cl-075"></a>

- executionIndex globally monotonic per run; continues across resume. The FIRST CommitBundle per runtimeStageId is the stage's own: no `phase`, carries its tags. Only a later bundle of the same execution is a continuation, stamped by the WRITER (`phase: 'exit'` = a mount's exit after its merge-back; `phase: 'repeat'` = a fork child's fan-out settle), so a mount with no merge-back (lazy, `parallelForEach` branch, no `outputMapper`) is one bundle. Readers group by runtimeStageId and read `phase`, never the log's shape (9.39.0, F8); a pre-9.39.0 log is inferred only by `inferLegacyPhases` (on `foottrace`), only without a tree; tree-less, a `subflowResults` entry marks a mount. Empty commits are deliberate cursor stops.

<a id="cl-076"></a>

- runtimeStageId stamped BEFORE the stage runs — the entire event-correlation model rests on scope+flow events sharing it.

<a id="cl-077"></a>

- One executor = one run at a time (_isExecuting guard). State values must survive structuredClone.

<a id="cl-078"></a>

- A resume re-enters ONCE (`ResumeEntry`, 9.28.0): the stand-in carries the paused stage's id but is only a START node — every graph lookup (node map, loop targets, subflow roots) must go through the real chart, never through it; a pause-path capture seeds its subflow's first entry only; what runs after an entry is read from the chart, never from the checkpoint. A paused-and-resumed run equals the never-paused run — same trace, same final state — for linear, decider-branch, selector-branch and fork-child placements at every depth and with parallel siblings pausing together (fast-check property, test/lib/pause/resume-real-chart.property.test.ts). Qualified: the RECORD differs by design (the stand-in is one more execution of the paused stage; the loop budget is per leg), and the three pinned limitations above hold.

<a id="cl-079"></a>

- Loop-ref stubs deliberately VIOLATE node-id uniqueness — every graph search must skip `isLoopRef` first.

<a id="cl-080"></a>

- runId regenerates per run() AND per resume(); recorders detect new runs via traversalContext.runId. A fresh `run()` clears every attached recorder (`runner/attach.ts · clearForRun`); `resume()` preserves them (`preserveRecorders`).

<a id="cl-081"></a>

- Recorder errors never abort traversal (isolated by `recorder/hooks.ts · fire`; every recorder `ErrorEvent.error` is a `StructuredErrorInfo` built once by `recorderFailureEvent`, inline and deferred alike; `errorInfo` lives in the L0 leaf `src/lib/errors/`).

<a id="cl-082"></a>

- Deferred-observer capture default at the executor tier is **'clone'** (the `DeferredObserverTier` constructor), not 'summary'.

<a id="cl-083"></a>

- `getSnapshot().recorders` = ONE row per recorder **id**, across both channels and both delivery tiers (`runner/snapshot.ts · collectRecorderSnapshots`) — a shared-name hook (onError/onPause/onResume) puts one recorder on two lists by design, and rows must survive structuredClone (the narrative row drops `rawValue`, a live reference).
