---
paths:
  - src/lib/memory/TransactionBuffer.ts
  - src/lib/memory/StageContext.ts
  - src/lib/memory/SharedMemory.ts
  - src/lib/memory/EventLog.ts
  - src/lib/memory/utils.ts
  - src/lib/memory/pathOps.ts
  - src/lib/memory/commitLogUtils.ts
  - src/lib/memory/backtrack.ts
  - src/lib/pause/**
  - src/lib/runner/FlowChartExecutor.ts
  - src/lib/runner/checkpointSanitize.ts
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
Files: `TransactionBuffer.ts:31` (ctor clones base twice :42-46; set :49-56; commit :153-168; net-change filter `toChangeOnlyPayload` :187-216 with deepEqual drop :202; delta encoding `toDeltaPayload` :248-307) · `StageContext.ts` (lazy buffer :308-313 with `firstTouchState` :289-294 base; commit :531-598 — zero-buffer fast path :532-556, `applyPatch` :567, staging release :595-597; buffer-aware read :420-425) · `SharedMemory.ts:59` applyPatch → `utils.ts:254-272` applySmartMerge (clone-whole-state, apply verbs, SWAP). Commit sites: `FlowchartTraverser.ts:1084` (pause), `:1088` (ERROR), `:1094` (success).

| Step | SAVED | RESTORED | DISCARDED |
|---|---|---|---|
| first write | 2 structuredClones (baseSnapshot + workingCopy) | — | — |
| during stage | ops in workingCopy/overwritePatch/opTrace | own writes readable (read-your-writes) | — |
| commit (success) | net-change CommitBundle → commitLog; new state generation swapped in | — | no-op & write-then-revert paths; buffer + stateView released |
| stage THROWS | **same commit still happens** (:1088), then rethrow | — | NOTHING — writes never vanish |

Invariant: committed state is immutable-after-swap, so a bare-reference first-touch view is a stable snapshot & diff base even under parallel-fork sibling commits.
Breaks when: code assumes rollback (write-then-throw IS committed), or a consumer mutates production `getSnapshot().sharedState` (zero-copy live view; frozen only in dev mode, `FlowChartExecutor.ts:1588`).

```
onFirstWrite: buf = new TransactionBuffer(firstTouchState)   // 2 clones
write(p,v):   buf.workingCopy[p]=v; buf.overwritePatch[p]=clone(v); opTrace.push
commit():     keep ops where !deepEqual(base[p], working[p])
              sharedMemory.context = applySmartMerge(clone(state), bundle)  // swap
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

Files: `pause/types.ts` (`PauseSignal`, `captureSubflowScope`, `FlowchartCheckpoint`) · `StageRunner.ts` (pausable stage returns non-void → throw PauseSignal) · `FlowchartTraverser.ts` (Phase 3 pause catch: commit + onPause + rethrow; invoker stamps replayed innermost-first in `executeNode`; `execute` starts at the one-shot `entry`, the node map is built from `root` — the real chart — only) · `SubflowExecutor.ts · executeSubflow` (bubble-up: snapshot nested sharedState onto signal, prepend subflowId; on entry asks `ResumeEntry.enterSubflow` — a hop seeds the nested runtime from its capture, skips the inputMapper, and starts the subflow's traversal at the hop's entry) · `engine/handlers/ResumeEntry.ts` (9.27.1 — THE owner of the one-shot law: `plan` resolves the start + one hop per subflow on the path against the chart as built, refusing a path the chart cannot walk; `enterSubflow` hands a hop out at most once; `findMount`) · `FlowChartExecutor.ts` (`buildPauseCheckpoint` — ONE structuredClone, sanitize retry; `resume()` — validation, counter seeding, the stand-in (copies `pausedNode.tags` on both re-entries, `retry` on the interrupt re-entry only), `ResumeEntry.plan`, fresh runId, `preserveRecorders: true`).

**The one-shot law (9.27.1).** The resume's synthetic structure — the stand-in for the paused stage, the captured per-subflow states — is used EXACTLY ONCE, for the re-entry. The stand-in is where the resumed traversal STARTS (`TraverserOptions.entry`, consumed by the first `execute()`); it is never in a node map or the subflow dictionary. Each subflow on the pause path takes its hop (capture + entry point) on its FIRST entry. The traverser's `root` and `subflows` stay the REAL chart, so every loop target, every later subflow entry (real root, inputMapper) and every re-visit of the paused stage (which pauses again) resolves as on a run. A pause N subflows deep re-enters each outer subflow AT the next mount on the path. Before 9.27.1 the traversal was rooted at the stand-in and the leaf root was swapped for the whole run (a loop to the paused id re-ran the resume half; a loop target upstream of the resume point hit a bare loop stub and the run ended silently; a 2-deep pause re-ran the outer subflow's pre-mount stages).

| Step | SAVED | RESTORED | DISCARDED |
|---|---|---|---|
| pause throw | pre-pause writes committed (M1); pauseData on signal | — | — |
| bubble-up | per-subflow sharedState captures + subflowPath + invoker stamps | — | nested runtimes (GC'd) |
| checkpoint | one deep-cloned detached FlowchartCheckpoint | — | per-iteration `#` subflowResults keys + per-subflow commit history stripped (`buildPauseCheckpoint`); recorder state NEVER captured |
| resume() plan | — | the stand-in + `ResumeEntry.plan` (start + one hop per subflow on the path) — refused before anything runs when a mount is unreachable | captures for subflows OFF the path (never handed out) |
| resume() run | fresh runId | sharedState → runtime; each path subflow's FIRST entry seeds from its capture (inputMapper skipped) and starts at the next mount / the stand-in; `executionCount`/`visitCounts` re-seed the shared counter + per-stage visit map (by mutation — traverser holds them by ref) so runtimeStageIds stay unique + loopIteration monotonic on cross-executor resume | the hops, as each is taken (one-shot); cross-executor narrative/recorders start empty |

Invariant: the chart graph is static and id-stable — resume reconstructs the cursor purely from `pausedStageId + subflowPath` against the CURRENT chart; checkpoint fully detached; after the re-entry the run is indistinguishable from one that never paused (pinned as a fast-check property: test/lib/pause/resume-real-chart.property.test.ts).
Breaks when: the paused subflow is mounted as a DECIDER BRANCH or a FORK CHILD — the dispatcher's continuation lives one level up and the checkpoint carries only the innermost `invokerStageId`/`continuationStageId`, so a decider's `next` runs INSIDE the subflow (its writes stay there) and a fork's join never runs (pinned as known limitations: test/lib/pause/resume-known-limitations.test.ts; the fix needs the dispatcher's level on the record). The loop budget is per LEG (`ContinuationResolver`'s counters are per traverser; the checkpoint carries visit counts, not loop counters). Also non-cloneable pauseData (a function) → contract error after sanitize retry.

```
pause:  stage returns data → throw PauseSignal(data, stageId)
        each subflow boundary: signal.capture(sfId, nestedState); path.unshift(sfId)
        executor: checkpoint = structuredClone({state, tree, cursor, sfStates})
resume: node    = findNodeInGraph(cp.pausedStageId, cp.subflowPath)
        standIn = {id: node.id, fn: resumeHalf, next: node.next ?? continuation, tags}
        entry   = ResumeEntry.plan(chart, cp.subflowPath, cp.subflowStates, standIn)
                  // start = standIn | mount(path[0]); hop(path[i]) = {capture, mount(path[i+1]) | standIn}
        traverser(root = chart.root, entry = entry.start, resume = entry)   // fresh runId
        subflow entry: hop = entry.enterSubflow(id)   // ONE-SHOT: later entries get nothing
```

## M3 — Commit-log replay / time-travel reconstruction
Files: `EventLog.ts` (`materialise(stepIdx)` :25-32 — clone base, replay 0..idx via applySmartMerge; `record` :35-38 stamps bundle.idx) · `utils.ts:254-272` applySmartMerge = THE single replay primitive (verbs: set/append/delete/merge) · `commitLogUtils.ts` (`commitValueAt` :60-98 — anchor at latest set/delete :74-80, fold forward :82-96; `findLastWriter` :23-31). Delta producer: `TransactionBuffer.toDeltaPayload` :248-307.

Invariant: replaying trace verbs in order over the base reproduces committed state byte-for-byte in BOTH `commitValues` modes (property-tested, `TransactionBuffer.ts:316-318`).
Breaks when: a key seeded into the run's INITIAL state (executor `initialContext`, resume's `checkpoint.sharedState`, or a subflow inputMapper seed) is only ever `merge`d — no `set` anchor in the log, `commitValueAt` folds from absent (documented blind spot `commitLogUtils.ts:54-58`). (`run({input})` is the frozen args channel and never enters shared state.) Also reading `bundle.overwrite[key]` as "the full value" under delta mode — an `append` bundle holds only the tail.

```
materialise(k): out = clone(base); for i in 0..k-1: out = applySmartMerge(out, steps[i])
commitValueAt(log, idx, key):
  touches = trace entries on key in log[0..idx]
  start   = last touch with verb set|delete            // full-value anchor
  fold forward: set→clone; delete→undefined; append→concat; merge→deepSmartMerge
```

## M4 — Loop re-entry (loopTo): retry-from-prior-point WITHOUT state reset
Files: `FlowChartBuilder.ts:346` (branch loopTo) / `:1817` (chain loopTo) — both plant stub `next = {id, isLoopRef: true}` · `FlowchartTraverser.ts:1044-1057` (decider continuation) + `:1258` (linear) → `ContinuationResolver.ts` (`resolveTarget` :107-169; iteration guard :176-191 throws past maxIterations, default 1000 :29; dynamic-next run-total budget `dynamicNextHops` :60, guard :117-125). Resume interaction: since 9.27.1 a resumed traversal walks the REAL chart (its node map is built from the chart root, never from the resume's stand-in), so a loop-ref stub resolves after a resume exactly as on a run — including a loop back to the paused stage, which reaches the real stage and pauses again.

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
mapping) · `stateAt.ts` (detached frozen fold via `applySmartMerge` — the ONE
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
- M1's trace verbs are the contract everything replays: `applySmartMerge` (utils.ts:254) has 3 consumers — live commit (StageContext.ts:567), the redacted mirror (StageContext.ts:577), and `EventLog.materialise`; `commitValueAt` independently reimplements the same per-key verb fold (commitLogUtils.ts:82-96). New/renamed verb touches all of M1+M3 including commitValueAt's own switch + delta-parity tests.
- M2 depends on M1's commit-on-pause (`FlowchartTraverser.ts:1084`) — pre-pause writes reach `checkpoint.sharedState` only because pause commits first.
- M2 checkpoints exclude recorder state and per-subflow commit logs (`FlowChartExecutor.ts:990-1009`); M5 on a cross-executor-resumed run sees only post-resume commits.
- M2 does NO graph surgery (9.27.1): the resume's stand-in is only a start node, and M4's loop-ref stubs resolve against the real chart through `ContinuationResolver` exactly as on a run. Changing the stub shape (`isLoopRef`) still breaks every loop, resumed or not.
- Parallel fan-out (`ChildrenExecutor`, failFast) is error COLLECTION, not rollback — a failed branch's committed writes persist either way.
