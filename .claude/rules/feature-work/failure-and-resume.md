---
paths:
  - "src/lib/pause/**"
  - "src/lib/errors/**"
  - "src/lib/runner/resume.ts"
  - "src/lib/engine/handlers/ResumeEntry.ts"
  - "test/lib/pause/**"
---

# Failure and resume — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-067"></a>

## Backtracking

<a id="cl-068"></a>

**Native terminal failure (#109):** `errors/terminalFailure.ts` is an L0 leaf owning `TerminalFailureContext` and
the private `NativeFailureState`. `StageContext` holds one slot; successors and exclusive decider branches share
it, parallel children and subflows isolate it. A private per-frame identity is stamped before any recorder event;
failure capture never reads the mutable event traversal context. Native attempts provide the exact final category through an internal
callback whose private category is fixed before serving/observers; ordinary stage-error paths classify before
commit observers. `commitStageWrites` captures the exact escaping commit error even during error/pause handling,
without changing that path's existing diagnostics or events. Only the explicitly selected
escaping child/subflow rejection transfers ownership. `onRunFailed.failure` and `executor.getFailureContext()` serve
a frozen category plus optional native run/runtime-stage identity, never payload or raw exceptions. Unknown setup,
cancellation, retention, checkpoint or sink failures borrow no stage. Each leg resets after the re-entrancy guard;
settlement seals the slot and releases private raw identity. No record/history traversal or stored schema change.

<a id="cl-069"></a>

Seven mechanisms, no state rollback anywhere: **M1** TransactionBuffer staging + net-change commit — commit-on-error by design, explicitly NOT rollback (foottrace's `TransactionBuffer`; error path commits then rethrows). **M2** Pause/Resume checkpointing — the only resume-from-prior-point; TWO raise shapes, ONE checkpoint: `addPausableFunction` (resume runs `resumeFn`) and `interrupt(scope, payload)` (resume RE-RUNS THE STAGE FUNCTION FROM ITS TOP — stages are atomic; the answer returns out of the `interrupt()` call via a WeakMap keyed by the scope), discriminated by `checkpoint.pausedBy`; checkpoint is one detached structuredClone; resume rebuilds the cursor from pausedStageId+subflowPath and re-enters ONCE (9.28.0, `ResumeEntry`): the paused stage's stand-in (its own node, fn swapped — so a dispatcher that interrupted still dispatches) is only where the resumed traversal STARTS — never in a node map — and each subflow on the path takes its capture + entry point on its FIRST entry (a 2+-deep pause re-enters each outer subflow AT the next mount; no pre-mount stage re-runs); every level's entry carries its DISPATCHER's continuation, read from the chart (a branch/fork-child mount hands back to its parent's `next`/join at the parent's level); parallel siblings that paused together wait in `checkpoint.pendingPauses` and are asked in turn, the join after the last; the rest of the run walks the REAL chart (a loop back to the paused stage reaches it and it pauses again; later entries run the inputMapper). Not rebuilt (pinned in test/lib/pause/resume-known-limitations.test.ts): lazy-subflow / parallelForEach-branch pauses (refused), a parallel-branch STAGE's namespace on resume, fan-out error containment for the resumed child. **M3** commit-log replay (EventLog.materialise, commitValueAt — required under delta mode). **M4** loopTo re-entry — forward execution over accumulated state, bounded by maxIterations + dynamicNextHops. **M5** causalChain backward slicing (read-only analysis; honesty flags for untracked reads; `edgeAttribution: 'per-write'` refines edges via `TraceEntry.readKeys` when the writeProvenance dial recorded them — worklist, subset-of-ceiling safe). **M6 (query layer)** foottrace's slice/ — variable-first triage: sliceForKey + append-fold element provenance + the ONLY safe serializations (sliceToJSON/formatSlice — never JSON.stringify a slice root). **M7 (read-time cursor)** foottrace's time-travel/ — `timeTravel(snapshot)` walks stops over the finished log with `stateAt()` folding M3's replay at each one (base = `RuntimeSnapshot.initialState`, which now travels with the log); it is a READER, never a second live cursor, and `drill(mount)` opens a separate cursor over a subflow's own isolated log. 9.18.0: `timeTravel([paused, resumed])` chains a cross-executor M2 resume into ONE axis — the resumed leg's `initialState` (= the state at the pause) restarts the fold, commit indices stay run-local (`Stop.sourceIdx` names the leg), and the chain is refused unless the never-reset execution counter is monotonic across legs. Deep dive + step tables: [.claude/rules/backtracking.md](../../../.claude/rules/backtracking.md).
