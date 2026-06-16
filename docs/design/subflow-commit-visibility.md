# Design note — Subflow commit visibility (retain-per-loop, don't merge)

> Status: **PROPOSED** (engine code gated on maintainer approval). Audience: library
> maintainers + downstream localizer/recorder authors.
> Related code: [`SubflowExecutor`](../../src/lib/engine/handlers/SubflowExecutor.ts),
> [`ExecutionRuntime`](../../src/lib/runner/ExecutionRuntime.ts),
> [`getSubtreeSnapshot`](../../src/lib/runner/getSubtreeSnapshot.ts),
> [`StageContext`](../../src/lib/memory/StageContext.ts),
> [`backtrack`](../../src/lib/memory/backtrack.ts).
> Origin: 9-agent ultracode review (footprintjs-inventor + agentfootprint-inventor +
> staff-engineer lenses), 2026-06-16. Triggered by agentfootprint's grouped-agent
> per-loop localizer (`assembleTrajectory`) being blind inside `sf-llm-call`.

## The one-line rule

A subflow is a **single foldable node** in its parent's view; its commits live in the
subflow's **own** commit log, reached by drilling into the subtree. We will make that
drill-down **complete and public** — **never** by merging nested commits into the run log.

## The problem

`getSnapshot().commitLog` is the universal causal-backtracking substrate
(`findLastWriter` / `causalChain` / `commitValueAt` / `llmEdgeWeigher` and, downstream,
agentfootprint's `assembleTrajectory`). A **deep** subflow's internal commits never reach
it:

- Each subflow mount builds a fresh isolated `ExecutionRuntime` with its own
  `executionHistory` (`SubflowExecutor.ts:119`). The run-level `commitLog` is only the
  parent traverser's own `executionHistory.list()` (`ExecutionRuntime.ts`), so it carries
  only the subflow **mount** boundary commits — not the stages inside.
- The subflow's own log is stashed in `subflowResult.treeContext.history`
  (`SubflowExecutor.ts:317`), but `subflowResultsMap.set(subflowId, …)` is keyed by the
  path-prefixed subflow id (`:327`) — so a **loop** re-entering the same subflow
  **OVERWRITES** the previous iteration. Only the LAST loop survives.
- `getSubtreeSnapshot` returns `executionTree + sharedState + narrativeEntries` but
  **not** `treeContext.history` (`getSubtreeSnapshot.ts:72-78`) — so there is currently
  **no public, documented path** to a subflow's commits at all.

**Impact.** For the FLAT agent (default `reactMode: 'dynamic'`) `call-llm` is a
parent-level stage, so its commits are in the run log — backtracking works. For the
GROUPED agent (opt-in `dynamic-grouped`), the whole LLM turn runs inside `sf-llm-call`,
so its hero stage `call-llm` is invisible to every commit-log consumer, and per-loop
detail for all but the last iteration is gone. The same loop-overwrite already makes
**explainable-ui drill-down** show only the last iteration of any looping subflow — an
active bug today, independent of this proposal.

## Why the isolation exists (what we MUST respect)

Subflow **state** isolation is deliberate and load-bearing (verified in source):

- **Subflow = pure function.** Own `GlobalStore`, explicit `inputMapper` in / `outputMapper`
  out — lets the same chart mount anywhere without key collisions.
- **Parallel-fork correctness.** The separate runtime + first-touch diff base stops a
  fork branch from recording a sibling's root-key write as a phantom change
  (`StageContext.ts:270-294`).
- **Pause/resume.** Each subflow's own `SharedMemory` is snapshotted onto the
  `PauseSignal` and re-seeded on resume, skipping `inputMapper` to preserve post-input
  pre-pause writes (`SubflowExecutor.ts:225-239`).
- **The tracking dials** (`readTracking` / `writeTracking` / `commitValues`) are threaded
  across the mount one hop at a time *because* the runtime is isolated (`:142-173`).

**The honest nuance:** the isolation of *state* was intended; the *commit-log*
invisibility is an **incidental consequence** of `ExecutionRuntime` bundling
`SharedMemory + StageContext + EventLog` into one container. No doc/RFC/test affirmatively
states subflow commits must be excluded from a run-addressable trail. So we respect the
state invariant absolutely, and treat the commit-log drill-down as improvable.

## The decision: retain-per-loop + expose the door + per-scope localize. NOT merge.

### Why NOT merge (rejected, with proof)

Merging nested commits into the run log — naive (#1) or scope-aware (#2) — is **provably
unsafe** and was reproduced live by all three review lenses:

- **Bare-key scope collision.** `StageContext.withNamespace` returns the **bare** key when
  `runId === ''` (`StageContext.ts:317`), and BOTH the top root AND every subflow root run
  with `runId === ''` (`ExecutionRuntime.ts:88`, `SubflowExecutor.ts:131`). So a parent
  write of `x` and a subflow write of `x` produce **identical** `trace[].path` strings —
  isolation is provided ONLY by the separate `SharedMemory`. In a merged log,
  `findLastWriter(log, 'x')` mis-attributed a parent read to a subflow write.
- **Delta corruption.** Under `commitValues: 'delta'`, interleaved parent+subflow `append`
  verbs on a shared bare key fabricate array elements present in **neither** scope.
- **Index collision.** The `inputMapper`-seed commit records an **empty `runtimeStageId`**
  (`SubflowInputMapper.ts:93`), colliding in `causalChain`'s `idxMap` (`backtrack.ts:331`).
- **Replay hazard (scope-aware #2).** `EventLog.materialise` replays ONE log against ONE
  base; subflow commits were applied to a DIFFERENT base (inputMapper-seeded). A merged
  log is likely **non-replayable** even with path tags — silently breaking `commitValueAt`.
- **Blast radius.** Any merge corrupts per-key lineage for the **flat** agent too —
  `findLastWriter` over the run log is called across explainable-ui, agentfootprint's
  localizer, AND the trace-toolpack debugger.

Scope-aware merge (#2) is the *minimum bar* if we ever merge, but it needs a new
`CommitBundle.subflowPath` discriminator, a rewrite of all four primitives, captured
mapper key-mappings, and a solved replay hazard — too much silent-corruption surface for
a need that retain-per-loop meets **without touching the run log**.

### The fix (three coordinated, design-respecting moves)

1. **Stop the loop-overwrite (retain per-loop) — DEFAULT, no flag, ADDITIVE (non-breaking).**
   Do NOT re-key the existing `subflowResults` map (that would break the eui drill-down lookup
   — see Consumer blast radius). Instead, **add per-execution addressability** keyed by the
   globally-unique `runtimeStageId` (the parent counter is shared, so ids are unique across the
   mount), while KEEPING the existing `subflowId`→last-iteration entry for back-compat. Each
   loop iteration's complete log is then retained and reachable **in the snapshot**. This is a
   **correctness bug fix**, not a feature — it is NOT gated. (Cost is a non-issue: the retained
   per-loop history is the SAME data the flat agent keeps in its run `commitLog` ungated —
   actually *less* per loop — and delta-encoding bounds both. See cost model.)

   The coordinated consumer change: eui [`fromRuntimeSnapshot.ts:421`] switches its lookup from
   `subflowResults[node.subflowId]` to prefer `node.runtimeStageId` (per-iteration), falling
   back to `subflowId` — which simultaneously FIXES the visible drill-down bug (today every loop
   iteration renders the last iteration's internals) and consumes the new per-execution data.

   **Keep the CHECKPOINT lean.** `resume()` restores from `checkpoint.subflowStates` +
   `checkpoint.sharedState` and **never reads `subflowResults`** (verified: the only
   `subflowResults` references in `FlowChartExecutor.ts` are building the checkpoint at :993
   and building the snapshot at :1551; resume reads `subflowStates` at :742 / `sharedState`
   at :856). The checkpoint carries NO run `commitLog` at all (:986-998). So strip the inner
   `treeContext.history` from `checkpoint.subflowResults` — it is audit-trail data resume
   doesn't need, and dropping it makes the grouped checkpoint symmetric with the flat one
   (neither carries commit history). This removes the ONLY real bloat without a flag.
2. **Expose the door.** Add the nested `history` (commit log) to the `getSubtreeSnapshot`
   return shape and document it — making "isolation is intended, navigate to the subtree"
   actually true.
3. **Localize per-scope.** The localizer runs `causalChain`/`findLastWriter`/`controlDeps`/
   `llmEdgeWeigher` PER-SCOPE-LOG, or via a thin aggregator that stitches slices using the
   unique counter and the existing D1 `parentMountRuntimeStageId` edge. The four bare-key
   run-log primitives stay **completely unchanged**. No flattened cross-scope log is ever
   built.

## Consumer blast radius (verified across footPrint + agentfootprint + explainable-ui + lens)

| Consumer | How it reads `subflowResults` | Impact |
|---|---|---|
| eui `fromRuntimeSnapshot.ts:421` | `subflowResults[node.subflowId]` (by PATH) | The pivotal one: it is BOTH the source of the visible drill-down bug (every loop node shares `subflowId` → all resolve to the last, overwritten entry) AND what a naive re-key would break. Fix = prefer `node.runtimeStageId`, fall back to `subflowId`. |
| eui `subflowResultToSnapshots` (`ExplainableShell.tsx:649`) | reads the `treeContext.{globalContext,stageContexts,history}` SHAPE off the per-node `subflowResult` | Safe — shape preserved; reads the SNAPSHOT, not the checkpoint, so the checkpoint strip is invisible. |
| `getSubtreeSnapshot` / `listSubflowPaths` | path-keyed | **No consumers** in eui, lens, OR agentfootprint (grep clean). Adding `history` is purely additive; the path contract is untouched by the additive approach. |
| agentfootprint localizer / trajectory | run `commitLog` + `executionTree` (NOT `subflowResults`) | Unaffected by the keying. Gains per-loop visibility via the new per-execution access. |

**The visible bug, stated plainly:** drilling into loop 1 / loop 2 / loop 3 of a looping
subflow in the Lens renders the SAME last-iteration internals — a catchable UI defect, not
just a localizer-internal gap. The additive fix repairs it.

## Non-negotiable must-haves

- **Never** ship naive append-merge.
- **Do not touch** the run-level commitLog isolation invariant (`ExecutionRuntime` returns
  its own `executionHistory.list()`).
- **ADDITIVE, non-breaking:** keep the `subflowId`→last-iteration entry (back-compat for
  `getSubtreeSnapshot` / `listSubflowPaths` / eui fallback); ADD per-execution access keyed by
  `runtimeStageId`. Do NOT re-key the existing map.
- Retain per-loop **by default** (it is a correctness bug fix, NOT a feature — no opt-in flag).
- **Keep the checkpoint lean:** do not carry per-loop `treeContext.history` into the pause
  checkpoint (`resume()` never reads `subflowResults`). The grouped checkpoint then matches
  the flat checkpoint, which carries no commit history either.
- **Coordinated eui change** (same PR or immediately after): eui `fromRuntimeSnapshot.ts:421`
  prefers `node.runtimeStageId`, falls back to `subflowId` — fixes the visible drill-down bug.
- Localizer runs per-scope-log, never a flattened log.

## Cost model (why no flag is needed)

The worry that justified a flag was checkpoint bloat. Cross-checked against source, it
dissolves:

1. **Resume never reads `subflowResults`.** The only references in `FlowChartExecutor.ts` are
   building the checkpoint (`:993`) and building the snapshot (`:1551`); resume restores from
   `checkpoint.subflowStates` (`:742`) + `checkpoint.sharedState` (`:856`). So the per-loop
   history is NOT needed for resume — strip it from the checkpoint → zero checkpoint bloat.
2. **The snapshot retention is the same data the flat agent already keeps ungated.** A flat
   agent stores every loop's commits in its run `commitLog` (no flag). A grouped agent's
   per-loop subflow history is the SAME commits, organized per-subflow — actually *fewer*
   per loop. Gating one but not the other is unjustified.
3. **No new O(N²).** `#13b`/`#13c-B`'s `commitValues: 'delta'` already bounds growing-array
   history; per-loop subflow logs inherit it. `getSnapshot()` is on-demand, not a hot path.

Net: retain by default in the snapshot; keep the checkpoint lean. No flag, no regression.

## Test matrix (Convention 2 + 3 — tests are the only guardrail)

- **Regression:** a looping subflow retains a COMPLETE per-iteration nested log (not just
  the last) — guards the overwrite fix and the eui drill-down loss.
- **Replay:** every per-scope log still `materialise`s correctly against its OWN seeded
  base, in both `full` and `delta` modes — proves no merged-log replay path was introduced.
- **Cross-scope safety:** parent and subflow both writing/appending the SAME bare key
  produce distinct, correctly-attributed slices when queried per-scope (the exact case
  naive merge corrupts).
- **Pause/resume:** a pause INSIDE a looping subflow resumes correctly, AND the checkpoint
  stays lean (does not carry per-loop `treeContext.history`) — resume still works without it.
- **Integration (`examples/`):** grouped-agent per-loop `call-llm` backtracking works
  end-to-end via the new per-scope slices.
- All 7 test types for the new retain-per-loop primitive.

## Spec reconciliation (resolved)

The former `causalChain — subflow scenarios` unit test (`backtrack.test.ts:355-378`)
hand-built a flat log with subflow-prefixed commits interleaved and asserted a cross-subflow
chain — a shape the engine never produces. **Maintainer ruling (2026-06-16): aspirational /
stale, written with AI assistance, never a real contract.** REMOVED (the slicer's
pure-function chaining stays covered by the `flattenCausalDAG` tests; honest per-scope-log
coverage lands with the per-scope localization work). This confirms: state isolation is
intended; commit-log invisibility is incidental; fix the overwrite, don't merge.

## Deferred / future

Scope-aware merge (#2) is revisited only if a real adopter genuinely needs ONE replayable
flattened log AND the `EventLog.materialise` single-base replay hazard is solved first.

## Open before coding

- **Consumer grep.** Re-confirm (including the trace-toolpack) that no consumer calls
  `findCommit`/`findLastWriter` with a bare local stageId expecting a unique parent-scope
  match. (Verified clean for `findCommit` in the review pass; re-run before shipping.)
- **Checkpoint observability impact.** Stripping `treeContext.history` from the checkpoint:
  confirm no consumer inspects a *stored* checkpoint's `subflowResults.history` (the contract
  says checkpoints don't capture observability/recorder state, so this should be safe — verify).
- **Empty-`runId` dead path.** `StageContext.withNamespace`'s `runs/<runId>/` branch is
  effectively dead (`runId` is always `''`). Out of scope here, but noted: it's why the
  bare-key collision exists and would matter to any future merge.
