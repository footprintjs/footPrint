# footprintjs v5.x → v6.0 Migration Guide

v6.0 removes the extractor pattern entirely. The replacement —
`StructureRecorder` (build phase) plus the already-shipping `FlowRecorder`
(runtime phase) — was introduced under L7 and ships as the canonical
build-time observation API.

This is a hard break: there is **no** deprecation period and **no**
compatibility shim. The extractor types and methods listed below are
removed in v6.0.0.

---

## What changed at a glance

| v5.x                                               | v6.0                                                     |
|----------------------------------------------------|----------------------------------------------------------|
| `BuildTimeExtractor` (function type)               | `StructureRecorder` (event-pluggable observer interface) |
| `TraversalExtractor` (function type)               | `FlowRecorder.onStageExecuted` (already shipping)        |
| `ChartExtractor` (unified attempt)                 | Two interfaces: `StructureRecorder` + `FlowRecorder`     |
| `FlowChartOptions.extractor` field                 | `FlowChartOptions.structureRecorders: StructureRecorder[]` |
| `flowChart(name, fn, id, extractor?, description?)`| `flowChart(name, fn, id, options?)`                      |
| `addBuildTimeExtractor(fn)`                        | `flowChart(..., { structureRecorders: [rec] })` OR `.attachStructureRecorder(rec)` |
| `addTraversalExtractor(fn)`                        | `executor.attachFlowRecorder(rec)` with `onStageExecuted` |
| `builder.getBuildTimeExtractorErrors()`            | `builder.getStructureBuildErrors()`                      |
| `executor.getExtractorErrors()`                    | `builder.getStructureBuildErrors()` (build phase) + per-recorder accumulation (runtime phase) |
| `executor.getExtractedResults()`                   | Recorder owns its accumulator — read it directly         |
| `FlowChartExecutorOptions.enrichSnapshots`         | Removed — was extractor-only                             |

---

## Recipe 1 — `BuildTimeExtractor` as a side-effect collector

This is the agentfootprint v3.x pattern: an extractor that pushed per-node
data into a side bag, ignoring the return value.

**v5.x:**
```ts
import type { BuildTimeExtractor, FlowChartSpec } from 'footprintjs';

const myNodes: { id: string; label: string }[] = [];
const extractor: BuildTimeExtractor = (spec) => {
  myNodes.push({ id: spec.id, label: spec.name });
  return spec; // identity — extractor was being used as observer
};

const chart = flowChart('seed', fn, 'seed', extractor, 'description')
  .addFunction('a', fnA, 'a')
  .build();
```

**v6.0:**
```ts
import type { StructureRecorder } from 'footprintjs';

const myNodes: { id: string; label: string }[] = [];
const rec: StructureRecorder = {
  id: 'my-nodes',
  onStageAdded: (e) => myNodes.push({ id: e.stageId, label: e.name }),
};

const chart = flowChart('seed', fn, 'seed', {
  structureRecorders: [rec],
  description: 'description',
})
  .addFunction('a', fnA, 'a')
  .build();
```

---

## Recipe 2 — `BuildTimeExtractor` that DID transform spec return values

The legacy extractor could mutate the returned spec (e.g., attach UI metadata).
In v6.0 the spec is no longer extractor-mutable. Push your derived data into
your own accumulator and key it by `event.stageId` — your downstream consumer
joins on the id.

**v5.x:**
```ts
const decoratedExtractor: BuildTimeExtractor = (spec) => ({
  ...spec,
  uiMeta: deriveUiMeta(spec), // extractor decorated the spec
});
```

**v6.0:**
```ts
const uiMeta = new Map<string, ReturnType<typeof deriveUiMeta>>();
const rec: StructureRecorder = {
  id: 'ui-meta-builder',
  onStageAdded: (e) => uiMeta.set(e.stageId, deriveUiMeta(e.spec)),
};
// Downstream: lookup by stageId. Spec is unchanged.
```

If you really need a *transformed* spec tree at build time (rare), build your
own tree from the events — it's the same data without the shared-mutation
pitfalls.

---

## Recipe 3 — `TraversalExtractor` (runtime per-stage data)

Use `FlowRecorder.onStageExecuted`. The runtime side already had this — most
v5.x consumers either used `addTraversalExtractor` OR a `FlowRecorder`; v6.0
collapses to just `FlowRecorder`.

**v5.x:**
```ts
const runtimeExtractor: TraversalExtractor = (snapshot) => {
  return {
    stage: snapshot.node.name,
    duration: snapshot.endTime - snapshot.startTime,
  };
};

const chart = flowChart(...)
  .addTraversalExtractor(runtimeExtractor)
  .build();

const ex = new FlowChartExecutor(chart);
await ex.run();
const results = ex.getExtractedResults(); // Map<stageId, { stage, duration }>
```

**v6.0:**
```ts
import type { FlowRecorder } from 'footprintjs';

const results = new Map<string, { stage: string; duration: number }>();
const rec: FlowRecorder = {
  id: 'per-stage-timing',
  onStageExecuted: (e) => {
    results.set(e.traversalContext.runtimeStageId, {
      stage: e.stageName,
      duration: e.endTime - e.startTime,
    });
  },
};

const chart = flowChart(...).build();
const ex = new FlowChartExecutor(chart);
ex.attachFlowRecorder(rec);
await ex.run();
// `results` is owned by your code — no executor accessor needed.
```

---

## Recipe 4 — Error inspection

**v5.x:**
```ts
const errs = builder.getBuildTimeExtractorErrors();
// or
const errs = executor.getExtractorErrors();
```

**v6.0:**
```ts
// Capture the builder reference so you can inspect errors AFTER .build():
const builder = flowChart('seed', fn, 'seed', {
  structureRecorders: [rec],
});
const chart = builder.build();
const errs = builder.getStructureBuildErrors();
// Errors include: { recorderId, method, message, error }
```

For runtime recorder errors, attach `FlowRecorder.onError` (or use the
per-recorder error accumulator pattern documented per recorder).

---

## Less-obvious removals

- **`enrichSnapshots` option** on `FlowChartExecutor` is removed. It was only
  consumed by `ExtractorRunner` (now deleted). If you were relying on it,
  the behavior was already a no-op for everything else; pure dead code.
- **`getExtractedResults()`** on the executor is removed. Each recorder owns
  its own data — read your recorder's accumulator directly.
- **`StageSnapshot` shape** (from `engine/types`) still ships for the
  per-stage execution tree, but the extractor-specific extension surface is
  gone.

---

---

## Post-v6.0 follow-ups (current `[Unreleased]`)

Three further proposals shipped after v6.0 — listed here because they
affect consumers writing code TODAY. See CHANGELOG `[Unreleased]` for
the full diff.

### Recipe 5 — `onStageExecuted` is now uniform (proposal #003)

Before this release, the engine fired `onStageExecuted` only for LINEAR
stages. Decider / fork / selector / subflow-mount stages fired only
their specialized event. Consumers using `onStageExecuted` to track
"did this stage run?" silently MISSED control-flow stages.

After this release, `onStageExecuted` fires uniformly for every stage
kind, AFTER the specialized event:

```ts
// Before: had to listen to both
const rec: FlowRecorder = {
  id: 'visited',
  onStageExecuted(e) { visited.add(e.stageName); },     // linear only!
  onDecision(e)      { visited.add(e.decider); },        // workaround
  onFork(e)          { visited.add(e.parentStage); },    // workaround
  onSelected(e)      { visited.add(e.parentStage); },    // workaround
  onSubflowEntry(e)  { visited.add(e.name); },            // workaround
};

// After: just one handler
const rec: FlowRecorder = {
  id: 'visited',
  onStageExecuted(e) { visited.add(e.stageName); },      // fires for ALL kinds
};
```

**If you were a LINEAR-ONLY consumer** (rare, e.g. counting "user
function invocations" excluding control-flow nodes), filter by
`stageType`:

```ts
const rec: FlowRecorder = {
  id: 'linear-only',
  onStageExecuted(e) {
    if (e.stageType && e.stageType !== 'linear') return;
    // ... linear-only logic
  },
};
```

The `stageType` discriminator is one of
`'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'`.

### Recipe 6 — Walk a mounted subflow's spec (proposal #001)

If you previously needed inner subflow structure from a PARENT
recorder (the common case: visualization libraries showing the full
chart tree), you had to either attach a recorder to every inner
builder OR run a connected-component algorithm over already-added
nodes to figure out membership. Both are workarounds; both can break.

The mount event now delivers the subflow's complete spec + path:

```ts
import { walkSubflowSpec } from 'footprintjs/trace';

const rec: StructureRecorder = {
  id: 'visualizer',
  onSubflowMounted(e) {
    if (!e.subflowSpec) return; // lazy mount — no spec yet
    for (const item of walkSubflowSpec(e.subflowSpec, e.subflowPath)) {
      switch (item.kind) {
        case 'subflow-start': /* entry stage marker */ break;
        case 'stage':         addNode(item.stageId, item.subflowPath); break;
        case 'edge':          addEdge(item.from, item.to, item.edgeKind); break;
        case 'loop':          addLoopEdge(item.from, item.to); break;
        case 'subflow':       /* nested mount — walker auto-recurses */ break;
      }
    }
  },
};
```

`event.subflowSpec` is reference-equal to the subflow's
`buildTimeStructure` (no clone); the walker yields items mirroring
Structure event payload shapes with `subflowPath` already set. Nested
subflows auto-recurse with composed paths (`'outer/inner'`).

### Recipe 7 — Decompose a prefixed stage id (proposal #002)

`parseRuntimeStageId('sf-tools/x#5').stageId` returns the LOCAL form
`'x'` — NOT the same as `spec.id` / `CommitBundle.stageId`, which carry
the FULL prefixed form `'sf-tools/x'`. To decompose a bare prefixed
id without the `#N` suffix, use `splitStageId`:

```ts
import { splitStageId } from 'footprintjs/trace';

splitStageId('sf-tools/x');
// → { localStageId: 'x', subflowPath: 'sf-tools' }
```

Use cases:
- Render LOCAL stage names in UI badges while keeping FULL ids as map keys
- Compare a `CommitBundle.stageId` against a `parseRuntimeStageId(...).stageId`
- Group commits by subflow membership for analytics

---

## Checklist

1. ☐ Replace every `BuildTimeExtractor` usage with a `StructureRecorder`
   (Recipe 1 or 2).
2. ☐ Replace every `TraversalExtractor` usage with a `FlowRecorder`
   (Recipe 3).
3. ☐ Rename `flowChart('x', fn, 'x', extractor, 'desc')` to
   `flowChart('x', fn, 'x', { structureRecorders: [rec], description: 'desc' })`.
4. ☐ Rename `builder.getBuildTimeExtractorErrors()` →
   `builder.getStructureBuildErrors()`.
5. ☐ Remove any `executor.getExtractorErrors()` / `getExtractedResults()` call
   — own the accumulator in your recorder.
6. ☐ Remove any `enrichSnapshots: true` from
   `FlowChartExecutorOptions`.
7. ☐ If you used `onDecision`/`onFork`/`onSelected`/`onSubflowEntry` to
   track "visited" state, simplify to a single `onStageExecuted` handler
   (Recipe 5). If you used `onStageExecuted` as a linear-only signal,
   add a `stageType` filter.
8. ☐ If you used a connected-component / inner-builder-attach workaround
   to materialize subflow structure from a parent recorder, replace it
   with `walkSubflowSpec` over `event.subflowSpec` (Recipe 6).
9. ☐ Bump your `footprintjs` dep to `^6.0.0`.

If you hit a v5.x pattern not covered here, open an issue with the snippet —
we'll add it to this guide.
