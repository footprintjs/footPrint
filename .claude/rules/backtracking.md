---
paths:
  - src/lib/memory/TransactionBuffer.ts
  - src/lib/memory/StageContext.ts
  - src/lib/memory/SharedMemory.ts
  - src/lib/memory/EventLog.ts
  - src/lib/memory/utils.ts
  - src/lib/memory/verbs.ts
  - src/lib/memory/pathOps.ts
  - src/lib/memory/commitLogUtils.ts
  - src/lib/memory/backtrack.ts
  - src/lib/pause/**
  - src/lib/runner/FlowChartExecutor.ts
  - src/lib/runner/checkpoint.ts (buildPauseCheckpoint + sanitize, 9.41.0)
  - src/lib/engine/handlers/SubflowExecutor.ts
  - src/lib/engine/handlers/StageRunner.ts
  - src/lib/engine/handlers/ContinuationResolver.ts
  - src/lib/engine/handlers/NodeResolver.ts
  - src/lib/engine/handlers/ResumeEntry.ts
  - src/lib/engine/traversal/FlowchartTraverser.ts
  - src/lib/recorder/ControlDepRecorder.ts
  - src/lib/recorder/qualityTrace.ts
  - src/lib/recorder/QualityRecorder.ts
  - src/lib/slice/**
  - src/lib/time-travel/**
---
<!-- analyzed-at: 22953d9 @ 2026-07-02 | model: fable-5 -->
# Backtracking in footprintjs — 7 mechanisms (M6 and M7 are read-time query layers over the others), ZERO rollback

There is NO state rollback anywhere. M1 is commit-on-error by design (`TransactionBuffer.ts:13-18` — "What it is NOT: a rollback mechanism").

**#P1 per-write read provenance (fourth dial):** `writeProvenance: 'reads-prefix'`
(FlowChartExecutorOptions) makes every staged write stamp `TraceEntry.readKeys` —
the keys tracked-read BEFORE that write (temporal prefix; monotone within a
stage, so delta-mode's one-entry-per-path keeps the LAST prefix == the union).
Capture: StageContext keeps a lazy `_provenanceReads` Set filled in `getValue`
(INDEPENDENT of readTracking — key strings only); `getTransactionBuffer` hands
the buffer a live `readKeysProvider` closure; both commit payloads
(`toChangeOnlyPayload` per-op, `toDeltaPayload` last-op-per-path) carry it.
Default `'off'` = byte-identical logs. Same 6-site propagation as the other
three dials. Snapshot discriminant: `getSnapshot().writeProvenance`.

## M1 — TransactionBuffer staging + net-change commit
Files: `TransactionBuffer.ts:31` (ctor — since 9.29.0 holds the base BY REFERENCE and copies only the root, `ownedRootOf`; `set`/`delete`/`merge` copy their own path, `ownSpine`; `get` → `privatise` (a read after the first write is the stage's own copy); `detachBase` (a read the working copy cannot answer is served LIVE by `StageContext · readState`, the diff base first gets a private copy at that path); set :49-56; commit :153-168; net-change filter `toChangeOnlyPayload` :187-216 with deepEqual drop :202; delta encoding `toDeltaPayload` :248-307) · `StageContext.ts` (lazy buffer :308-313 with `firstTouchState` :289-294 base; commit :531-598 — zero-buffer fast path :532-556, `applyPatch` :567, staging release :595-597; buffer-aware read :420-425) · `SharedMemory · applyPatch` → `verbs · nextGeneration` (copy the root + each written path, apply verbs via `foldRows`, SWAP — copy-on-write since 9.29.0; untouched subtrees shared with the previous generation). Commit sites: `FlowchartTraverser.ts:1084` (pause), `:1088` (ERROR), `:1094` (success).

| Step | SAVED | RESTORED | DISCARDED |
|---|---|---|---|
| first write | baseSnapshot = the committed generation BY REFERENCE; workingCopy = a root copy (9.29.0 — before: 2 whole-state structuredClones) | — | — |
| during stage | ops in workingCopy/overwritePatch/opTrace | own writes readable (read-your-writes) | — |
| commit (success) | net-change CommitBundle → commitLog; new state generation swapped in | — | no-op & write-then-revert paths; buffer + stateView released |
| stage THROWS | **same commit still happens** (:1088), then rethrow | — | NOTHING — writes never vanish |

Invariant: committed state is immutable-after-swap (a generation is never edited — copy-on-write, 9.29.0), so a bare-reference first-touch view is a stable snapshot & diff base even under parallel-fork sibling commits — unless USER code edits a committed object in place: a raw read before the stage's first write, edited and written back, then records no change (M7; dev mode warns).
Breaks when: code assumes rollback (write-then-throw IS committed), or a consumer mutates production `getSnapshot().sharedState` (zero-copy live view; frozen only in dev mode, `FlowChartExecutor.ts:1588`).

```
onFirstWrite: buf = new TransactionBuffer(firstTouchState)   // base by reference, root copy (9.29.0)
write(p,v):   ownSpine(workingCopy, p); workingCopy[p]=v; overwritePatch[p]=v (ref); opTrace.push
read(p):      privatise(p) — a container still shared with committed state → a private deep copy, once
              nothing at p (deleted/unset) → LIVE state, after detachBase(p): base[p] = a private copy
commit():     keep ops where !deepEqual(base[p], working[p]); payload values cloned once
              sharedMemory.context = nextGeneration(state, bundle)  // copy written paths, share the rest, swap
              eventLog.record(bundle); release buf/stateView
onError:      commit(); rethrow          // NO abort path exists
```

## M2 — Pause/Resume checkpointing (the only resume-from-prior-point)

**TWO raise shapes, ONE checkpoint (9.14.0).** `addPausableFunction` returns
non-void → StageRunner throws PauseSignal → resume runs the node's `resumeFn`.
`interrupt(scope, {reason, expects?})` throws an InterruptSignal that
StageRunner converts to `new PauseSignal(payload, node.id, 'interrupt')` — the
ONE conversion point every stage function passes through (linear, decider,
selector, fork child, subflow body). The checkpoint shape is unchanged apart
from an optional `pausedBy:'interrupt'`; `resume()` reads it to pick the
re-entry, and the interrupt re-entry RE-RUNS THE STAGE'S OWN FUNCTION FROM ITS
TOP (stages are atomic), depositing the resume input in a WeakMap keyed by the
scope object so the `interrupt()` call that threw returns it. Consequences:
the pre-interrupt half runs twice (keep it idempotent — no rollback exists),
`onStageEnd` does NOT fire (the fn threw — the error path's shape), and an
interrupt inside a GENERATED `parallelForEach` branch pauses but cannot resume
(the branch is not in the static chart; refused via the shipped
`findNodeInGraph` miss, no marker special-casing).

Files: `pause/types.ts` (`PauseSignal` — `captureSubflowScope`, `prependSubflow` (grows the pending siblings' paths too), `addPendingPause`/`pendingPauses`/`toPendingPause`; `FlowchartCheckpoint`, `PendingPause`) · `StageRunner.ts` (pausable stage returns non-void → throw PauseSignal) · `ChildrenExecutor.ts · raisePauses` (9.28.0 — several children of one fan-out paused: the first, in CHILD order, is raised, every other queued on it; fail-fast forks wait for siblings on a pause) · `FlowchartTraverser.ts` (Phase 3 pause catch: commit + onPause + rethrow; invoker stamps replayed innermost-first in `executeNode`; Phase 0 routes a mount's loop-ref `next` through `ContinuationResolver`; `execute` starts at the one-shot `entry` and — `walkThenRaise` — raises the level's waiting sibling pauses once the entry's chain ends; the node map is built from `root` — the real chart — only) · `SubflowExecutor.ts · executeSubflow` (bubble-up: snapshot nested sharedState onto signal, prepend subflowId; on entry asks `ResumeEntry.enterSubflow` — a hop seeds the nested runtime from its capture (the inputMapper still runs, for the args only), starts the subflow's traversal at the hop's entry and hands it the siblings waiting there) · `engine/handlers/ResumeEntry.ts` (9.28.0 — THE owner of the one-shot law: `plan` resolves the start + one hop per subflow on the path against the chart as built, attaches each level's dispatcher continuation, queues sibling pauses at their fan-out, refuses a path the chart cannot walk or cannot walk unambiguously; `enterSubflow` hands a hop out at most once; `raiseQueuedPause` / `queueBehind`) · `FlowChartExecutor.ts` (`buildPauseCheckpoint` — ONE structuredClone, sanitize retry, `pendingPauses` when siblings wait; `resume()` — validation, `standInFor` (the paused node itself, fn swapped; `resumeFn`/`isPausable` dropped, `retry`/streaming kept on the interrupt re-entry only, tags on both), `ResumeEntry.plan`, THEN counter seeding, fresh runId, `onResume` naming the stand-in's own runtimeStageId, `preserveRecorders: true`).

**The one-shot law (9.28.0).** The resume's synthetic structure — the stand-in for the paused stage, the captured per-subflow states, the entries — is used EXACTLY ONCE, for the re-entry. The stand-in is where the resumed traversal STARTS (`TraverserOptions.entry`, consumed by the first `execute()`); it is never in a node map or the subflow dictionary. Each subflow on the pause path takes its hop (capture + entry point + waiting siblings) on its FIRST entry. The traverser's `root` and `subflows` stay the REAL chart, so every loop target, every later subflow entry (real root, inputMapper) and every re-visit of the paused stage (which pauses again) resolves as on a run. A pause N subflows deep re-enters each outer subflow AT the next mount on the path.

**One rule at every level (9.28.0).** Each level's entry — the mount of the next subflow on the path, or the stand-in — is the child with its DISPATCHER's continuation attached where its chain ends (`{ ...child, next: dispatcher.next }`: a decider's or selector's `next`, a fork's join; past a dispatcher with no `next`, outward to the one enclosing it). Read from the chart (`ResumeEntry.plan` indexes node → enclosing dispatcher per level), never from the checkpoint's `continuationStageId` — which stays on the checkpoint as a record. So a paused subflow mounted as a branch or fork child hands control back to its parent's continuation AT THE PARENT'S LEVEL.

**Parallel siblings (9.28.0).** Several children of one fan-out paused → the checkpoint asks the first and carries the rest (`pendingPauses`). At that fan-out's level the entry is the child's own chain only (no join); once it ends the traverser raises the next sibling's pause as recorded (nothing re-runs; `onPause` fires); a pause raised inside the chain carries the queue. The join runs after the last sibling is resumed.

Before 9.28.0 the traversal was rooted at the stand-in and the leaf root was swapped for the whole run (a loop to the paused id re-ran the resume half; a loop target upstream of the resume point hit a bare loop stub and the run ended silently; a 2-deep pause re-ran the outer subflow's pre-mount stages); a branch/fork-child mount lost its dispatcher's continuation; a second pausing sibling was dropped.

| Step | SAVED | RESTORED | DISCARDED |
|---|---|---|---|
| pause throw | pre-pause writes committed (M1); pauseData on signal | — | — |
| fan-out settles | every paused child: the first raised, the rest queued on it as `pendingPauses` (their own captures + questions) | — | — |
| bubble-up | per-subflow sharedState captures + subflowPath (+ the queue's paths) + invoker stamps | — | nested runtimes (GC'd) |
| checkpoint | one deep-cloned detached FlowchartCheckpoint | — | per-iteration `#` subflowResults keys + per-subflow commit history stripped (`buildPauseCheckpoint`); recorder state NEVER captured |
| resume() plan | — | the stand-in + `ResumeEntry.plan` (start + one hop per subflow on the path, each with its dispatcher continuation; waiting siblings queued at their fan-out) — refused before anything runs when a mount is unreachable or ambiguous, or a pending record is not a sibling | captures for subflows OFF the path (never handed out); the checkpoint's `continuationStageId` (a record only) |
| resume() run | fresh runId | sharedState → runtime; each path subflow's FIRST entry seeds from its capture (the inputMapper runs for the args only) and starts at the next mount / the stand-in — or, missing its capture, at its root with its inputMapper; `executionCount`/`visitCounts` re-seed the shared counter + per-stage visit map (by mutation — traverser holds them by ref) so runtimeStageIds stay unique + loopIteration monotonic on cross-executor resume | the hops, as each is taken (one-shot); cross-executor narrative/recorders start empty |
| sibling raise | the next sibling's pause re-raised as recorded, the rest behind it; the levels above capture themselves afresh | — | — |

Invariant: the chart graph is static and id-stable — resume reconstructs the cursor purely from `pausedStageId + subflowPath` against the CURRENT chart; checkpoint fully detached; after the re-entry the run is indistinguishable from one that never paused — same trace, same final state — for every placement of every subflow on the path (linear, decider/selector branch, fork child) and with parallel siblings pausing together (pinned as a fast-check property: test/lib/pause/resume-real-chart.property.test.ts). Record-level differences remain by design: the stand-in is one more execution (runtimeStageId, visit) of the paused stage; the loop budget is per LEG.
Breaks when (pinned in test/lib/pause/resume-known-limitations.test.ts): a pause inside a LAZY subflow or a `parallelForEach` branch (refused — their graphs are not in the chart); a paused parallel-branch STAGE resumes in its dispatcher's context, not `runs/<branch>`; the resumed child of a fan-out runs outside the fan-out's `allSettled` (a failure after the resume fails the run). A subflow id mounted twice → resume refused (the path cannot say which mount). The loop budget is per LEG (`ContinuationResolver`'s counters are per traverser; the checkpoint carries visit counts, not loop counters). Also non-cloneable pauseData (a function) → contract error after sanitize retry.

```
pause:  stage returns data → throw PauseSignal(data, stageId)
        fan-out: first paused child raised; others → first.addPendingPause(...)
        each subflow boundary: signal.capture(sfId, nestedState); path.unshift(sfId) (queue too)
        executor: checkpoint = structuredClone({state, tree, cursor, sfStates, pendingPauses?})
resume: node    = findNodeInGraph(cp.pausedStageId, cp.subflowPath)
        standIn = {...node, fn: resumeHalf} − resumeFn/isPausable (− retry/streaming unless interrupt)
        entry   = ResumeEntry.plan(chart, cp.subflowPath, cp.subflowStates, standIn, cp.pendingPauses)
                  // level i: child = mount(path[i]) | standIn; entry = {...child, next: dispatcher(child).next ...}
                  // hop(path[i]) = {capture, entry(i+1), queue(i+1)} — no capture on an outer level: no entry
        traverser(root = chart.root, entry = entry.start, resume = entry)   // fresh runId
        subflow entry: hop = entry.enterSubflow(id)   // ONE-SHOT: later entries get nothing
        level's entry chain ends with a queue: throw raiseQueuedPause(queue)
```

## M3 — Commit-log replay / time-travel reconstruction
Files: `EventLog.ts` (`materialise(stepIdx)` — clone base ONCE, replay 0..idx into it via `applySmartMergeInto` (the live law below the root, 9.29.0); `record` stamps bundle.idx) · `verbs · applyVerb` = THE single verb law (set/append/delete/merge; an unknown verb is refused, `UnknownVerbError`), folded by `foldRows` (one bundle — behind `nextGeneration` (live), `applySmartMergeInto` (folds), `dryFold` (comparison) and the public `applySmartMerge` (fully detached, the 9.28.0 contract)) and `foldKey` (one path across a log) · `commitLogUtils.ts` (`commitValueAt` = `keyTouches` + `foldKey` anchored at the last set/delete; `findLastWriter`). Delta producer: `TransactionBuffer.toDeltaPayload` :248-307.

Invariant: replaying trace verbs in order over the base reproduces committed state byte-for-byte in BOTH `commitValues` modes (property-tested, `TransactionBuffer.ts:316-318`).
Breaks when: a key seeded into the run's INITIAL state (executor `initialContext`, resume's `checkpoint.sharedState`, or a subflow inputMapper seed) is only ever `merge`d — no `set` anchor in the log, `commitValueAt` folds from absent (documented blind spot `commitLogUtils.ts:54-58`). (`run({input})` is the frozen args channel and never enters shared state.) Also reading `bundle.overwrite[key]` as "the full value" under delta mode — an `append` bundle holds only the tail.

```
materialise(k): out = clone(base); for i in 0..k-1: applySmartMergeInto(out, steps[i])
commitValueAt(log, idx, key):
  touches = trace entries on key in log[0..idx]
  start   = last touch with verb set|delete            // full-value anchor
  fold forward: set→clone; delete→undefined; append→concat; merge→deepSmartMerge
```

## M4 — Loop re-entry (loopTo): retry-from-prior-point WITHOUT state reset
Files: `FlowChartBuilder.ts:346` (branch loopTo) / `:1817` (chain loopTo) — both plant stub `next = {id, isLoopRef: true}` · `FlowchartTraverser · executeNodeStep` (Phase 2b decider continuation, Phase 6 linear/dynamic next, Phase 0 a subflow mount's `next`) → `ContinuationResolver.ts` (`resolveTarget` :107-169; iteration guard :176-191 throws past maxIterations, default 1000 :29; dynamic-next run-total budget `dynamicNextHops` :60, guard :117-125). Resume interaction: since 9.28.0 a resumed traversal walks the REAL chart (its node map is built from the chart root, never from the resume's stand-in), so a loop-ref stub resolves after a resume exactly as on a run — including a loop back to the paused stage, which reaches the real stage and pauses again, and a decider-level `loopTo` taken right after the stand-in (its `next` is the decider's real stub). A SUBFLOW MOUNT's loop-ref `next` (a subflow mounted as a decider branch with `loopTo`) routes through `ContinuationResolver` too (`FlowchartTraverser · executeNodeStep` Phase 0) — before 9.28.0 Phase 0 hopped into the bare stub, even on a normal run: one stage ran and the run ended.

| Step | SAVED | RESTORED | DISCARDED |
|---|---|---|---|
| loop edge taken | iteration counter++ (per node id); visitCount++; new StageContext in tree | NOTHING — target re-reads live committed state | — |
| each iteration | its own CommitBundle (distinct `stage#N`) | — | previous iteration's staging (released at its commit) |

Invariant: loop re-entry is FORWARD execution over accumulated state — never a rewind; flat trampoline hops mean the stack never bounds a loop.
Breaks when: a stage returns a fresh fn-bearing StageNode each visit — no stable id, bypasses the per-node counter (`ContinuationResolver.ts:114-117`); bounded only by the run-total dynamicNextHops budget.

```
loopTo(id):  next = {id, isLoopRef:true}                        // build time
at runtime:  if next.isLoopRef: {node,ctx} = resolveTarget(id)  // count++, throw if > max
             return hop(node, ctx)                              // flat re-entry, state as-is
```

## M6 — slice/ query layer (variable-first triage over M3+M5)

Files: `src/lib/slice/` — `sliceForKey.ts` (anchor at `findLastWriter` →
delegate to causalChain; honest absence `missing: 'empty-log'|'never-written'`;
DEFAULTS to `edgeAttribution: 'per-write'` + `rootLinkKeys: [key]` — safe, logs
without readKeys degrade to stage level per node) · `elementProvenance.ts`
(append-fold: replays the commitValueAt verb fold from the FIRST touch — never
anchor-skip, that erases full-mode births — carrying index-aligned
`ElementBirth`s labeled `'append-verb'`(exact)/`'prefix-inference'`(heuristic)/
`'whole-value'`(reset); absence `missing: …|'not-an-array'`) ·
`keysReadSources.ts` (strategy interface; execution-tree source carries
`coverage` — `stepsWithReads === 0` is the readTracking-off signature) ·
`serialize.ts` (`sliceToJSON` flat/linear; `formatSlice` bounded string —
**never `JSON.stringify` a slice root**: shared-node DAG explodes
combinatorially on diamonds).

Invariants: births index-aligned with the folded value (property-pinned
against commitValueAt); per-write slice ⊆ stage-level slice (property-pinned).
Breaks when: slicing across a subflow MOUNT (isolated runtime — re-anchor with
the subflow's own `treeContext.history` + tree, see slice/README.md); an
initial-state-seeded key (never-written blind spot shared with findLastWriter).

## M5 — Backward causal slicing over the commit log (read-only analysis)
Files: `backtrack.ts` (`causalChain` :311-478 — idxMap :329-332, BFS :359, `linkParent` :368-427 with control edges + weigher isolation, truncation flags :464-475; strategy switch linear-scan vs reverse-index at N=256 :204) · `commitLogUtils.ts:23` findLastWriter · `ControlDepRecorder.ts` (controlDeps lookup) · `qualityTrace.ts:56-108` (per-step scores; root cause = biggest score drop :88-100).

**edgeAttribution (#P1):** `'stage'` (default) expands every node through ALL its stage reads; `'per-write'` expands a node reached via key k through only k's write-prefix `readKeys` (worklist: late links via other keys re-enqueue the DELTA, monotone toward the stage ceiling; `rootLinkKeys` anchors the root; any entry lacking readKeys → per-node stage-level fallback — mixed logs degrade exactly, never narrower).

Invariant: every data edge the slice follows is a tracked read matched to a `trace.path` in an earlier bundle; untracked consumption (args/env/silent) flags the node `incompleteSources` — never silently complete. Per-write refinement is SUBSET-safe: it removes spurious edges, never adds.
Breaks when: a stage derives its write purely from `$getArgs()`/`getEnv()`/silent reads — the slice stops early (marked `⚠ slice may be incomplete`, `backtrack.ts:554-557`); or `getKeysRead` comes from a different run's recorder (ids don't match → empty slice).

```
root = log[idx(startId)]; queue=[root]
while queue: node = pop
  for key in getKeysRead(node.id):
    writer = lastWriterBefore(key, node.idx)
    link(node → writer, 'data', key); enqueue if new & under maxDepth/maxNodes
  if controlDeps: link(node → governingDecider, 'control', ruleLabel)
stamp root.truncated if any budget cut
```

## M7 — time-travel/ read-time cursor (the reader's cursor over M3)

Files: `src/lib/time-travel/` — `types.ts` (Stop/Move/Mark/FoldedState/
TimeTravelStrategy — the seam) · `commitStops.ts` (THE shipped strategy: one
stop per executed stage, a mount's entry/exit bundles collapsed onto the first,
`'start'`/`'end'` bookends; `Stop.lastCommitIdx` is the end of the stop's slice
— fold through IT, not `commitIdx`, or a mount's state lags its own output
mapping) · `stateAt.ts` (detached frozen fold via `applySmartMergeInto` — the ONE
replay primitive, never a fifth verb-switch replica; `basis: 'initial+log' |
'log-only'` is the honesty channel) · `timeTravel.ts` (the cursor; `drill()`
returns a SEPARATE cursor over the subflow's own log) · 9.18.0: `axis.ts`
(`splitAxis` reads the `[start,…stages,end]` contract; `filterStops` composes a
filtering strategy — re-partition, `Stop.meta`, `Stop.prologue`) · `bundles.ts`
(`unknown[]` rows narrowed per bundle; a non-bundle is an index-holding GAP in
`FoldedState.skipped`) · `chain.ts` (`timeTravel([paused, resumed])` — one axis
over a cross-executor resume, run-local indices + `Stop.sourceIdx`, refused when
an id repeats, execution indices are not monotonic across legs, or a leg's
`initialState` is not the state the earlier legs fold to — the last check is
SKIPPED, not faked, when a leg has no base) · 9.21.0: `tagStops.ts` (the stops
a chart DECLARED — `filterStops(commitStops(...))` keeping stops whose FIRST
bundle's `CommitBundle.tags` shares any name with the list, `meta` = the
array; a declared tag is a build-time NAME stamped by the traverser, never a
runtime value). Exported from `footprintjs/trace`.

Substrate this needed (9.17.0): the fold base now TRAVELS with the log —
`RuntimeSnapshot.initialState` (`ExecutionRuntime.getSnapshot`) and
`SubflowResult.treeContext.initialState` — and `snapshot.commitLog` is a
detached frozen copy instead of the live `EventLog.list()` array.

| step | what happens |
|---|---|
| derive | `strategy.stopsFor(log, tree)` partitions the log into stops. Read-only; a strategy may group/filter/label what was recorded, never synthesize a stop for something never committed. |
| move | `first/last/prev/next/jumpTo/jumpToMark` return a `Move`. A refusal NEVER touches the position (`reason: 'clamped' \| 'miss' \| 'empty'`). |
| fold | `stateAt(stop)` replays `initialState` → `commitLog[0..stop.lastCommitIdx]` and deep-freezes the result. |
| diff | `changedSince(from)` reads keys straight off the bundles' traces — no fold. |
| drill | `drill(mountRuntimeStageId)` opens a new cursor over `subflowResults[mount].treeContext.history` + its own base. |

Laws: ONE cursor (drill is a separate cursor, never a second position) · a miss
never moves · a fold result is detached · marks live BESIDE the log (never
written into it) · stops are derived from the recorded log.

Breaks when: `getSnapshot({ redact: true })` — `initialState` is deliberately
OMITTED there (the raw pre-run seed never passed a redaction policy), so a
redacted snapshot folds `basis: 'log-only'` · a key seeded before the run and
only MERGED afterwards needs the base, which is exactly why it travels · a
fresh-executor resume restarts `bundle.idx` at 0, so commit indices are
RUN-LOCAL — a cursor over ONE snapshot spans one leg; `timeTravel([paused,
resumed])` (9.18.0) chains the legs into one axis of STEPS while every stop's
`commitIdx` keeps indexing its own leg (`Stop.sourceIdx`) — no global index is
invented, and a chain is refused when an id repeats, execution indices are not
monotonic, or a leg's `initialState` is not the state the legs before it fold to
(that third check needs the base on the record; without it the chain rests on
the two index checks and `basis` says so).

## Cross-mechanism blast radius
- M1's trace verbs are the contract everything replays, and `verbs · applyVerb` is the ONE place a verb is interpreted: `foldRows` has its consumers through four doors — live commit and the redacted mirror (`SharedMemory · applyPatch` → `nextGeneration`), the folds (`EventLog.materialise`, `stateAt` → `applySmartMergeInto`), the admitted record's comparison (`dryFold`), and external callers (the public `applySmartMerge`); `commitValueAt` and `arrayProvenance` fold one path through `foldKey` (same step, same clone discipline). A new/renamed verb is one arm of `applyVerb` + its row in `TRAITS`; the compiler lists the rest, and the differential (test/lib/memory/property/verb-law-differential.property.test.ts) plus delta-parity tests pin it.
- M2 depends on M1's commit-on-pause (`FlowchartTraverser · executeNodeStep`, Phase 3's pause catch) — pre-pause writes reach `checkpoint.sharedState` only because pause commits first.
- M2 checkpoints exclude recorder state and per-subflow commit logs (`runner/checkpoint.ts · buildPauseCheckpoint`); M5 on a cross-executor-resumed run sees only post-resume commits.
- M2 does NO graph surgery (9.28.0): the resume's stand-in and entries are only start nodes (never registered), and M4's loop-ref stubs resolve against the real chart through `ContinuationResolver` exactly as on a run. Changing the stub shape (`isLoopRef`) still breaks every loop, resumed or not.
- M2 depends on the fan-out's settle order: `ChildrenExecutor` raises the FIRST paused child in child order and queues the rest; a fork that re-threw on the first pause would drop the others (the fail-fast mode waits for its siblings on a pause for this reason).
- Parallel fan-out (`ChildrenExecutor`, failFast) is error COLLECTION, not rollback — a failed branch's committed writes persist either way.
