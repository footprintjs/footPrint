# Proposal: Fire `onStageExecuted` uniformly for ALL stages (LOCKED v2)

**Status:** v2 · LOCKED · all 3-panel minors folded in · supersedes v1
**Affects:**
- `src/lib/engine/handlers/DeciderHandler.ts`
- `src/lib/engine/handlers/ChildrenExecutor.ts`
- `src/lib/engine/handlers/SelectorHandler.ts`
- `src/lib/engine/traversal/FlowchartTraverser.ts` (subflow mount fire site + linear stage shape change)
- `src/lib/engine/narrative/types.ts` (`FlowStageEvent.stageType`)
- `src/lib/engine/narrative/CombinedNarrativeRecorder.ts` (REFACTOR — stop double-duty in `onDecision`/`onFork`/`onSelected`)
- `src/lib/engine/narrative/NarrativeFlowRecorder.ts` (gate text on `stageType !== 'linear'`)

**Estimated change:** ~25 LOC added + ~40 LOC refactored in footprintjs · deletes ~38 LOC of consumer duplicate-handler code · fixes one latent NodeView visited bug · eliminates the bug class

---

## Revision history

- **v1** proposed firing `onStageExecuted` after `onDecision`/`onFork`/`onSelected`. 3-panel review: all APPROVE_WITH_MINORS, strong convergence on 4 required additions:
  1. Bundle `stageType` discriminator (don't defer Open Q #4)
  2. Include subflow-mount in scope (don't defer Open Q #1)
  3. Refactor `CombinedNarrativeRecorder` (Panel 1 finding: `onDecision` currently does double-duty — emits stage header + flushes buffered ops BECAUSE `onStageExecuted` doesn't fire for deciders today; after proposal, both fire → duplicate output)
  4. Update `NarrativeFlowRecorder.onStageExecuted` text — current "Next, it moved on to X" is meaningless for fork parents
- **v2 (this version)** folds in all four. Bundles `stageType`, includes subflow-mount, refactors `CombinedNarrativeRecorder`, gates `NarrativeFlowRecorder` text. Single coherent PR.

---

## What problem does this solve?

A consumer asks: **"Did this stage execute?"** They wire `onStageExecuted`, expecting it once per stage. For linear stages it fires. For decider/fork/selector/subflow-mount it **doesn't** — the engine fires only the specialized event and skips `onStageExecuted` entirely. Consumers tracking visited-state silently miss control-flow nodes.

### Real downstream bug

`footprint-explainable-ui`'s runtime overlay missed marking LoanDecision as visited. Investigation cost: hours. Workaround LOC (still in tree): 38 LOC of duplicate handlers in `createTraceRuntimeOverlay.ts:65-239`. Confirmed by consumer Panel 2: the same latent bug exists in NodeView (only listens to `onStageExecuted`; silently misses every decider).

### Fire sites (confirmed in source)

- `FlowchartTraverser.ts:719` — `onStageExecuted` for linear stages (after `executeStage()` returns)
- `DeciderHandler.ts:102` — `onDecision` after decider returns branch id, BEFORE chosen child executes. No subsequent `onStageExecuted`.
- `ChildrenExecutor.ts:40` — `onFork` BEFORE children execute. No subsequent `onStageExecuted` for parent.
- `SelectorHandler.ts:87, 123` — `onSelected` after selector returns. No subsequent `onStageExecuted`.
- Subflow mount nodes — fire `onSubflowEntry`/`Exit`. NO `onStageExecuted`. Same bug class (Panel 2 confirmed visited-state misses subflow mounts).

## Proposed solution

### A. Fire `onStageExecuted` uniformly for every stage

After the specialized event for each stage kind:

**Decider** (DeciderHandler.ts:102):
```ts
this.deps.narrativeGenerator.onDecision(node.name, chosen.name, ..., decisionEvidence);
this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'decider');  // ← NEW
```

**Fork** (ChildrenExecutor.ts:40):
```ts
this.deps.narrativeGenerator.onFork(node.name, childDisplayNames, traversalContext);
this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'fork');  // ← NEW
```

**Selector** (SelectorHandler.ts:87 and 123):
```ts
this.deps.narrativeGenerator.onSelected(node.name, selectedDisplayNames, ..., selectionEvidence);
this.deps.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'selector');  // ← NEW
```

**Subflow mount** (after `onSubflowEntry` fires for the mount node):
```ts
this.narrativeGenerator.onSubflowEntry(node.name, ..., traversalContext);
this.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'subflow-mount');  // ← NEW
```
Fire on ENTRY (not exit) — matches Panel 2 preference: "entry = this mount ran." The mount's actual work is mounting; children execute after.

**Linear stage** (FlowchartTraverser.ts:719) — UNCHANGED in ordering, gains `stageType`:
```ts
this.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'linear');
```

### B. Bundle `stageType` discriminator on `FlowStageEvent`

```ts
interface FlowStageEvent {
  // existing
  readonly stageName: string;
  readonly description?: string;
  readonly traversalContext?: TraversalContext;

  // NEW
  readonly stageType: 'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount';
}
```

Update `FlowRecorderDispatcher.onStageExecuted` signature + `NarrativeGenerator.onStageExecuted` signature to thread the new arg through.

Consumers can:
- Filter to linear-only: `if (event.stageType === 'linear') { ... }`
- Route by kind without a side-table lookup into the chart spec
- Use the universal "stage ran" signal for visited tracking

### C. Refactor `CombinedNarrativeRecorder` (REQUIRED — Panel 1 finding)

Today `CombinedNarrativeRecorder.onDecision`/`onFork`/`onSelected` do **double-duty**:
1. Emit the stage header for the narrative line ("LoanDecision evaluated...")
2. Call `flushOps` to release buffered scope events for the stage

The double-duty exists ONLY because `onStageExecuted` doesn't fire for these stage kinds today. After v2:
- `onStageExecuted` fires for every stage kind → it becomes the single flush trigger
- `onDecision`/`onFork`/`onSelected` keep their specialized payload work (recording decision evidence, fork children, etc.) but STOP emitting the stage header and STOP calling `flushOps`

Net behavior: each stage gets exactly ONE narrative header line (from `onStageExecuted`) plus its specialized event payload (from the specialized handler). No duplicates.

### D. Refactor `NarrativeFlowRecorder.onStageExecuted` text

Today reads "Next, it moved on to X" — meaningless for a fork parent or decider. Gate the text on `stageType`:

```ts
onStageExecuted(event) {
  switch (event.stageType) {
    case 'linear':         return this.write(`Next, it moved on to ${event.stageName}.`);
    case 'decider':        return; // onDecision provides the line
    case 'fork':           return; // onFork provides the line
    case 'selector':       return; // onSelected provides the line
    case 'subflow-mount':  return; // onSubflowEntry provides the line
  }
}
```

Net narrative output: identical to today for narrative-only consumers (no duplicate or noisy lines). Consumers using OTHER FlowRecorders (e.g., explainable-ui's overlay) gain uniform visited tracking.

## Pause / error edge cases

**Pause** — if the stage throws PauseSignal BEFORE its specialized event fires, no `onStageExecuted` (matches linear). If the chosen child or fork branch pauses AFTER the parent's `onStageExecuted` already fired, that's fine — the parent did complete its main work; the pause is in the child. Document.

**Error** — if the stage throws, `onError` fires and no `onStageExecuted` (matches linear). Same convention for all stage kinds.

## Breaking-change analysis

Library is currently at v5.0.0 (per recent CHANGELOG). v2 of this proposal warrants **v6.0.0** for the following user-visible changes:
- New events fire for decider/fork/selector/subflow-mount in any consumer using `onStageExecuted`
- `CombinedNarrativeRecorder` produces SAME output, but the internal call graph changed (test snapshots may move)
- `FlowStageEvent` gains required `stageType` field — TypeScript will surface this for any consumer constructing events manually (rare; mostly test fixtures)
- `NarrativeGenerator` interface gains a required `stageType` arg on `onStageExecuted` — affects custom `NarrativeFormatter` implementations

CHANGELOG migration note:
```
- onStageExecuted now fires for ALL stage kinds, not just linear stages.
  - Consumers using it for "visited" tracking now work for decider/fork/selector/subflow-mount uniformly.
  - Consumers using it as a linear-only signal: filter via `event.stageType === 'linear'`.
- FlowStageEvent gains required `stageType` field.
- CombinedNarrativeRecorder narrative output unchanged; internal flush ordering refactored.
```

## Backward-compat audit (per Panel 1 finding)

- Test suite: ~30 `onStageExecuted` references; most pass synthetic events directly (need to add `stageType` to fixtures); `CombinedRecorder.test.ts:195` and `ChildrenExecutor.test.ts` exercise real dispatch (expectations updated).
- No `assertOnlyLinear` patterns found anywhere.
- Downstream `footprint-explainable-ui`: requester; deletes 38 LOC.
- Downstream `agentfootprint`: builds on `TopologyRecorder`/`InOutRecorder`; neither relies on `onStageExecuted` count semantics. Safe.

## What this DOESN'T do (deliberately)

- ❌ Introduce a new `onStageVisited` event (Panel 3 confirmed: footprintjs has no skip semantics → "visited" and "executed" collapse; parallel event would entrench the asymmetry)
- ❌ Change `onDecision`/`onFork`/`onSelected` payloads or ordering relative to the new `onStageExecuted`
- ❌ Change linear-stage semantics (other than adding `stageType: 'linear'`)
- ❌ Change `runtimeStageId` computation
- ❌ Fire `onStageExecuted` on error or pre-specialized-event pause (matches linear convention)

## Required tests before merge

1. **Unit (engine)**: chart with one linear stage → `onStageExecuted` fires once with `stageType: 'linear'`.
2. **Unit (engine)**: chart with one decider → `onDecision` then `onStageExecuted` with `stageType: 'decider'`, in that order.
3. **Unit (engine)**: chart with one fork → `onFork` then `onStageExecuted` with `stageType: 'fork'` for parent, then children's `onStageExecuted` events.
4. **Unit (engine)**: chart with one selector → `onSelected` then `onStageExecuted` with `stageType: 'selector'`.
5. **Unit (engine)**: chart with one subflow mount → `onSubflowEntry` then `onStageExecuted` with `stageType: 'subflow-mount'`.
6. **Property (engine)**: for any chart, count of `onStageExecuted` events equals count of stages traversed (linear + decider + fork + selector + subflow-mount), excluding errored stages and pre-specialized-event pauses.
7. **Integration (CombinedNarrativeRecorder)**: narrative output for a chart with all 5 stage kinds is IDENTICAL byte-for-byte to v5 output (no duplicate headers, no missing flushes).
8. **Integration (downstream simulation)**: a consumer using ONLY `onStageExecuted` correctly tracks visited for every stage kind including subflow mounts.
9. **Backward-compat**: existing test suite passes with snapshot updates limited to the documented narrative-internal changes.

## Naming (LOCKED)

- Event: `onStageExecuted` (UNCHANGED)
- New field: `event.stageType: 'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'`
- No new event names
