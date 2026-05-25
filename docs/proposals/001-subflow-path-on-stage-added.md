# Proposal: Subflow spec + path on the mount event (LOCKED)

**Status:** v6 · LOCKED · all 3-panel minors folded in · supersedes v1/v2/v3/v4/v5
**Affects:** `lib/builder/types.ts` (event payload), `lib/trace/walkSubflowSpec.ts` (new helper)
**Estimated change:** ~30 LOC added in footprintjs · deletes ~155 LOC of consumer workarounds (`tagSubflowMembers.ts` 123 LOC + `ProxiedBuilder` monkey-patch ~60 LOC)

---

## Revision history

- **v1** added `subflowPath?: string` to `StructureStageAddedEvent`. Rejected — violates MOUNT-ONLY contract.
- **v2** added `subflowSpec` + `subflowPath` to `StructureSubflowMountedEvent` + `walkSubflowSpec` helper. Approved with minors, then questioned over multi-builder attachment.
- **v3** introduced `withStructureRecorders([rec], () => {...})` scope. Panel found fatal ordering issue.
- **v4** added buffered emission to solve ordering. Workable but introduced module-level state + lazy-subflow complexity.
- **v5** returned to v2's core insight: mount event fires AFTER subflow is fully built, so it can carry the full spec + path. 3-panel review: all APPROVE_WITH_MINORS.
- **v6 (this version)** folds in every panel minor: reference-equality guarantee, lazy-mount runtime-timing note, walker discriminator, immutability docs, nested-subflow walker item, entry-stage marker, `@internal` spec marker, root-mount path clarification, seed-replay confirmation.

---

## What problem does this solve?

A consumer builds an app with multiple flow charts — a parent + N subflows:

```ts
const authSubflow    = flowChart('Auth',    fnA, 'auth').build();
const paymentSubflow = flowChart('Payment', fnP, 'pay' ).build();
const parent = flowChart('Router', fnR, 'router')
  .addSubFlowChartBranch('auth',    authSubflow,    'Auth')
  .addSubFlowChartBranch('payment', paymentSubflow, 'Pay')
  .build();
```

They want a SINGLE recorder attached to the parent to observe the complete structure — parent stages AND every subflow's internal stages, with subflow context (path) on each one.

**Today's options are all bad:**
1. Attach a recorder to each builder manually — easy to forget; fragile; recorder still can't tell which subflow each event belongs to (no path).
2. Attach only to the parent — only sees parent events (MOUNT-ONLY contract); subflow internals invisible.
3. Monkey-patch the `FlowChartBuilder` constructor (what `footprint-playground`'s `ProxiedBuilder` does) — works but fragile and undocumented.
4. Walk the parent's spec tree at recorder time WITHOUT library help — consumer reimplements spec-traversal; ties to internal spec shape.

## Key insight (load-bearing)

By the time `parent.build()` fires `onSubflowMounted` for each mounted subflow, **the subflow has already been built**. Its complete spec is in hand (consumer constructed it and passed it to `addSubFlowChartBranch`). The mount event has everything needed to deliver the FULL structural picture in one shot. Inner builders don't need to fire events to the parent's recorder.

## Proposed solution

### A. Extend `StructureSubflowMountedEvent`

```ts
interface StructureSubflowMountedEvent {
  // existing
  readonly mountStageId: string;
  readonly subflowId: string;
  readonly subflowName: string;

  // new
  /**
   * The mounted subflow's complete spec — the SAME OBJECT (=== reference equality)
   * that the consumer passed to `addSubFlowChartBranch`. Immutable post-build;
   * consumers MUST NOT mutate.
   *
   * @internal The FlowChartSpec shape is library-internal. Use `walkSubflowSpec`
   *           from `footprintjs/trace` for the stable public contract.
   */
  readonly subflowSpec: FlowChartSpec;

  /**
   * Local mount id of this subflow within its parent (e.g. 'auth' for a top-level
   * mount, 'auth/verify' for a nested mount whose recorder is attached to the
   * grandparent). Matches runtime `traversalContext.subflowPath` semantics —
   * NEVER prefixed with `__root__/`.
   */
  readonly subflowPath: string;
}
```

The other four Structure events are UNCHANGED. No `subflowPath` on `StructureStageAddedEvent` etc. — those fire only for the recorder's own builder, so the path concept doesn't apply.

### B. Ship a `walkSubflowSpec` helper

Export from `footprintjs/trace`:

```ts
import { walkSubflowSpec, type WalkerItem } from 'footprintjs/trace';

for (const item of walkSubflowSpec(event.subflowSpec, event.subflowPath, { recurse: true })) {
  // item.source === 'walker' always (discriminates from Structure events at runtime)
  switch (item.kind) {
    case 'subflow-start':    // entry-stage marker — yielded FIRST for each subflow
      // { kind: 'subflow-start', stageId, subflowPath, source: 'walker' }
      break;
    case 'stage':            // shape-mirrors StructureStageAddedEvent + subflowPath + source
      break;
    case 'edge':             // shape-mirrors StructureEdgeAddedEvent + subflowPath + source
      break;
    case 'loop':             // shape-mirrors StructureLoopEdgeAddedEvent + subflowPath + source
      break;
    case 'decider':          // shape-mirrors StructureDeciderCompleteEvent + subflowPath + source
      break;
    case 'subflow':          // NESTED mount — shape-mirrors StructureSubflowMountedEvent
      // { kind: 'subflow', mountStageId, subflowId, subflowName, subflowSpec, subflowPath, source: 'walker' }
      // When recurse:true, walker continues INTO this subflow after yielding the marker.
      // When recurse:false, walker yields the item and SKIPS the subflow's internals.
      break;
  }
}
```

**Walker contract guarantees:**
1. **Auto-recurse by default** (`recurse: true`). Pass `{recurse: false}` to walk only one level (subflow items yielded but their internals not traversed).
2. **Entry-stage marker first**: for each subflow (top-level and nested), walker yields `{kind: 'subflow-start', stageId, subflowPath}` BEFORE any other items from that subflow. Consumer uses this to draw the boundary edge from the mount node.
3. **Composed paths**: nested subflows get `parentPath + '/' + localId` (e.g. `'auth/verify'`). Top-level mount paths are local-only (e.g. `'auth'`, NOT `'__root__/auth'`).
4. **Shape mirroring**: `stage`/`edge`/`loop`/`decider` items have IDENTICAL payload shape to the corresponding Structure event, with `subflowPath` added and `source: 'walker'` added. Consumer can route walker items through the same handlers used for Structure events.
5. **Source discriminator**: every walker item carries `source: 'walker'` (Structure events do NOT). Lets consumers tell event vs walker apart in logs/debuggers while still sharing handler code paths.
6. **Stage-ID prefixing**: stage IDs in nested subflows are already prefixed by the spec (e.g. `'auth/verify/check'`). Walker preserves this; `subflowPath` field is redundant-but-explicit.

### C. Reference equality + immutability guarantees

**Library MUST guarantee:**
- The `subflowSpec` field on `onSubflowMounted` is the SAME OBJECT (`===`) that the consumer passed to `addSubFlowChartBranch(id, subSpec)`. No clone. No re-wrap.
- `FlowChartSpec` is structurally immutable post-`.build()`. Library does not mutate after returning from `build()`.
- Consumers MUST NOT mutate the spec. (Library MAY freeze in dev mode to enforce.)
- Action item before merge: audit `lib/builder/FlowChartBuilder.ts` paths (`addSubFlowChartBranch`, `.build()`, nested-id prefixing) to confirm no in-place mutation; add a unit test asserting `event.subflowSpec === passedInSpec`.

Why this matters: consumers memoize walker output by spec identity (`Map<FlowChartSpec, WalkedResult>`) to avoid re-walking on every recorder seed-replay. Reference equality is the cache key.

### D. Lazy subflow timing

`addLazySubFlowChartBranch(id, () => resolver())` defers subflow construction until runtime. The resolver fires during `executor.run()`; mount event fires THEN, not at parent's `.build()` time.

**Documentation requirement** (add to `StructureRecorder.d.ts`):
> Structure events for lazy mounts arrive at RUNTIME (when the lazy resolver fires), not at build time. Recorders that snapshot-at-build will miss lazy subflows. To handle lazy mounts, treat the structure graph as growable post-build OR subscribe to `onSubflowMounted` for ongoing updates.

**Test requirement** (add to footprintjs test suite):
- Integration test: parent with one eager subflow + one lazy subflow → recorder attached at parent.build() time → run executor → assert `onSubflowMounted` fires once at build (eager) and once at run (lazy), both with `subflowSpec` populated correctly.

### E. Seed-replay semantics

When `attachStructureRecorder(rec)` is called LATE (after `.build()` has already fired structure events), the library replays buffered events to the new recorder. v6 confirms:
- Replayed `onSubflowMounted` events MUST include `subflowSpec` and `subflowPath` populated correctly (not stripped during replay).
- Test requirement: late-attach test asserts seed-replay carries v6 fields intact.

## Why this is the right design (recap from v5 + panel confirmations)

- **MOUNT-ONLY preserved**: no new dispatch paths, no inner-builder cross-talk. Mount event already fires on parent's recorder; v6 just enriches its payload with a spec the consumer themselves supplied.
- **Symmetric with runtime channels**: runtime events already carry `traversalContext.subflowPath`. After v6, build-time gets `subflowPath` too. Library-wide rule becomes "if your event crosses a subflow boundary, you get `subflowPath`."
- **Walker is the stable public contract**: `FlowChartSpec` marked `@internal`, walker output is the API. Library can evolve internal spec shape as long as walker output stays stable — same insulation `parseRuntimeStageId` gives over `runtimeStageId` format.
- **Single consumer code path**: walker items mirror event shapes → same handlers handle both. `source: 'walker'` discriminator preserved for debuggability.

## What this DOESN'T need (explicitly scoped out)

- ❌ `withStructureRecorders` scope helper (v3/v4 idea)
- ❌ Buffered emission inside scope
- ❌ Module-level state stack
- ❌ `subflowPath` on the other 4 Structure events
- ❌ `builderId` correlation field
- ❌ Auto-attach across multiple builders

## Downstream impact

`footprint-explainable-ui`'s `traceStructureRecorder` becomes:

```ts
onSubflowMounted(event) {
  upsertNode({ id: event.mountStageId, isSubflow: true, subflowId: event.subflowId });
  for (const item of walkSubflowSpec(event.subflowSpec, event.subflowPath)) {
    switch (item.kind) {
      case 'subflow-start':
        // (optional) draw boundary edge mount → entry stage
        break;
      case 'stage':
        upsertNode({ id: item.stageId, subflowOf: item.subflowPath, ... });
        break;
      case 'edge':
      case 'loop':
        upsertEdge(item);
        break;
      case 'subflow':  // nested mount marker
        upsertNode({ id: item.mountStageId, isSubflow: true, subflowId: item.subflowId });
        // walker auto-recurses; nested internals arrive in subsequent iterations
        break;
    }
  }
}
```

- `tagSubflowMembers.ts` (123 LOC) deletes (connected-component algorithm no longer needed).
- `ProxiedBuilder` (~60 LOC) deletes (parent recorder is sufficient).

## Migration / compatibility

- `subflowSpec` + `subflowPath` are new fields on an existing event. Old consumers ignore them; new consumers feature-detect via `'subflowSpec' in event`.
- `walkSubflowSpec` is a new export under `footprintjs/trace`. Also feature-detectable via `typeof walkSubflowSpec === 'function'`.
- Old footprintjs versions don't emit v6 fields → consumer falls back to its existing heuristic (`tagSubflowMembers`) when fields are absent. One release supports both during rollout; consumer deletes fallback in next minor once peerDep bumps to footprintjs ≥X.Y.
- MOUNT-ONLY contract is unchanged. Recorder attached to parent receives only parent's events. v6 just enriches the mount event payload.

## Required tests before merge

1. **Unit**: `walkSubflowSpec` yields items in documented order (subflow-start first, then stages/edges/loops/deciders, nested subflows yielded as `subflow` marker then recursed).
2. **Unit**: walker `{recurse: false}` skips nested internals.
3. **Unit**: walker item shapes match Structure event payload shapes byte-for-byte (modulo `subflowPath` + `source` additions).
4. **Property**: walking a deeply-nested spec yields the same `(stageId, subflowPath)` pairs that runtime `runtimeStageId` parsing produces for the same chart (anchors build-time/runtime path contract).
5. **Integration**: parent + eager subflow + lazy subflow → recorder sees both `onSubflowMounted` events with `subflowSpec` populated (eager at build, lazy at run).
6. **Integration**: `event.subflowSpec === passedInSpec` (reference equality).
7. **Integration**: late `attachStructureRecorder` seed-replay carries `subflowSpec` + `subflowPath` intact.

## Naming (LOCKED)

- Field: `subflowSpec` (matches existing `subflowId`/`subflowName` clustering on the event)
- Field: `subflowPath` (matches runtime `traversalContext.subflowPath`)
- Helper: `walkSubflowSpec` (verb-noun consistent with `parseRuntimeStageId`/`findCommit` in `footprintjs/trace`)
- Walker discriminator: `source: 'walker'` on every item
- Walker entry marker kind: `subflow-start`
- Walker option: `{ recurse: boolean }` (default `true`)
