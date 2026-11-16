---
paths:
  - "src/lib/engine/traversal/**"
  - "src/lib/engine/handlers/**"
---

# Walkthrough — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-065"></a>

## End-to-end trace (seed → decider → loop branch → finish)

<a id="cl-066"></a>

build: flowChart() → FlowChartBuilder.start → addDeciderFunction → branch {loopTo} plants stub `next={id,isLoopRef:true}` (`FlowChartBuilder · _applyBranchLoop`) → build() → makeRunnable.
run: executor.run (FlowChartExecutor.ts): re-entrancy guard → fresh runId → createTraverser (scope factory composed by `runner/attach.ts · RunObservers · composeScopeFactory`: TypedScope + recorders + redaction) → new ExecutionRuntime (SharedMemory+EventLog+root StageContext) → traverser.execute fires onRunStart → trampoline executeNode (flat hops, recursion only for forks/subflows/decider-with-next, depth cap 500 counts NESTING per call path — `FlowchartTraverser · nestingDepthOf`, siblings share a level; a reached cap fires onError and rejects run() with `TraversalDepthError`, ChildrenExecutor rethrows it in either mode, 9.40.0).
per stage: executeNodeStep stamps runtimeStageId → StageRunner.run: scopeFactory → onStageStart → stage fn (writes stage into TransactionBuffer via StageContext.setObject; onWrite fires live) → onStageEnd → traverser calls context.commit() → onCommit → onStageExecuted (narrative flushes buffered ops here).
decider: DeciderHandler.prepareDispatch — runs stage, **commits BEFORE branch resolution**, matches branchId, fires onDecision(+evidence) → onStageExecuted('decider') → flat hop with InvokerStamp.
loop: Phase 6 sees isLoopRef → ContinuationResolver.resolveTarget: id-map lookup, iteration guard (max 1000), onLoop → hop; zero stack, state carries forward (never rewound). A decider WITH its own next runs its branch as a BRANCH FRAME (9.40.0): a `loop`-flagged hop leaves the frame only when an ENCLOSING driver already ran the target — the decider follows it flat and skips its next, which runs once after the non-looping pass; any other jump stays in the frame. A selector's own loopTo resolves the same way and fires onLoop.
end: onRunEnd (throw → onRunFailed; pause → neither) → deferred terminalFlush → getSnapshot() = {sharedState (LIVE view; dev-mode frozen clone), initialState (the fold base), commitLog (detached+frozen; a bundle or base holding what freezing cannot seal — a Date, Map, buffer … — is served as a copy of its open paths, `runner/snapshot.ts · servedSnapshot` → `foottrace · serveRecord`, 9.44.2), executionTree, subflowResults (dual-keyed; `globalContext` = the subflow's LIVE heap, or under `redact: true` its own nested mirror — 9.20.0, `servedSubflowResults`), recorders}.
