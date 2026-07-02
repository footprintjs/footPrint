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
  - src/lib/engine/traversal/FlowchartTraverser.ts
  - src/lib/recorder/ControlDepRecorder.ts
  - src/lib/recorder/qualityTrace.ts
  - src/lib/recorder/QualityRecorder.ts
  - src/lib/slice/**
---
<!-- analyzed-at: 22953d9 @ 2026-07-02 | model: fable-5 -->
# Backtracking in footprintjs — 5 mechanisms + the slice query layer, ZERO rollback

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
Files: `pause/types.ts` (`PauseSignal` :29, `captureSubflowScope` :116, `FlowchartCheckpoint` :190) · `StageRunner.ts:94-100` (pausable stage returns non-void → throw PauseSignal) · `FlowchartTraverser.ts:1083-1086` (commit + onPause + rethrow; invoker stamps replayed innermost-first :771-780) · `SubflowExecutor.ts:225-238` (bubble-up: snapshot nested sharedState onto signal, prepend subflowId; resume-seed skip-inputMapper :69-72, :126-128) · `FlowChartExecutor.ts` (`buildPauseCheckpoint` :987-1036 — ONE structuredClone :1024, sanitize retry :1028-1033; `resume()` :672 — validation :690-707, loop-ref stub resolution :762-768, synthetic resume node :783-789, fresh runId :812, outer-mount entry + LEAF-root swap :847-855, `preserveRecorders: true` :871).

| Step | SAVED | RESTORED | DISCARDED |
|---|---|---|---|
| pause throw | pre-pause writes committed (M1); pauseData on signal | — | — |
| bubble-up | per-subflow sharedState captures + subflowPath + invoker stamps | — | nested runtimes (GC'd) |
| checkpoint | one deep-cloned detached FlowchartCheckpoint | — | per-iteration `#` subflowResults keys + per-subflow commit history stripped (:996-1009); recorder state NEVER captured |
| resume() | fresh runId | sharedState → runtime; subflowStates re-seed nested runtimes (inputMapper skipped) | cross-executor narrative/recorders start empty |

Invariant: the chart graph is static and id-stable — resume reconstructs the cursor purely from `pausedStageId + subflowPath` against the CURRENT chart; checkpoint fully detached.
Breaks when: pause is **two subflow levels deep** (`['sf-a','sf-b']`) — resume enters through subflowPath[0]'s mount and only overrides the LEAF root (:841-856, "single-level covers all current use cases"), so sf-a's stages before the sf-b mount re-execute. Also non-cloneable pauseData (a function) → contract error after sanitize retry.

```
pause:  stage returns data → throw PauseSignal(data, stageId)
        each subflow boundary: signal.capture(sfId, nestedState); path.unshift(sfId)
        executor: checkpoint = structuredClone({state, tree, cursor, sfStates})
resume: node = findNodeInGraph(cp.pausedStageId, cp.subflowPath)
        resumeRoot = mount(cp.subflowPath[0]); subflows[leaf].root = {fn: resumeFn, next: continuation}
        seed runtime from clone(cp.sharedState); subflow entry seeds from cp.subflowStates (skip inputMapper)
        traverser.execute()   // fresh runId; recorders preserved same-executor only
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
Files: `FlowChartBuilder.ts:346` (branch loopTo) / `:1817` (chain loopTo) — both plant stub `next = {id, isLoopRef: true}` · `FlowchartTraverser.ts:1044-1057` (decider continuation) + `:1258` (linear) → `ContinuationResolver.ts` (`resolveTarget` :107-169; iteration guard :176-191 throws past maxIterations, default 1000 :29; dynamic-next run-total budget `dynamicNextHops` :60, guard :117-125). Resume interaction: loop-ref stubs resolved to real nodes at `FlowChartExecutor.ts:762-768`.

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

## Cross-mechanism blast radius
- M1's trace verbs are the contract everything replays: `applySmartMerge` (utils.ts:254) has 3 consumers — live commit (StageContext.ts:567), the redacted mirror (StageContext.ts:577), and `EventLog.materialise`; `commitValueAt` independently reimplements the same per-key verb fold (commitLogUtils.ts:82-96). New/renamed verb touches all of M1+M3 including commitValueAt's own switch + delta-parity tests.
- M2 depends on M1's commit-on-pause (`FlowchartTraverser.ts:1084`) — pre-pause writes reach `checkpoint.sharedState` only because pause commits first.
- M2 checkpoints exclude recorder state and per-subflow commit logs (`FlowChartExecutor.ts:990-1009`); M5 on a cross-executor-resumed run sees only post-resume commits.
- M4's loop-ref stubs are the one place M2 does graph surgery (`FlowChartExecutor.ts:762-768`) — changing the stub shape (`isLoopRef`) breaks resume-through-loop.
- Parallel fan-out (`ChildrenExecutor`, failFast) is error COLLECTION, not rollback — a failed branch's committed writes persist either way.
