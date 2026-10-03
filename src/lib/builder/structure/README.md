# builder/structure/ — watch a chart being built

The build-time observer channel: `StructureRecorder` (six optional hooks — `onStageAdded`, `onStageTagged`, `onEdgeAdded`, `onLoopEdgeAdded`, `onDeciderComplete`, `onSubflowMounted` — and their event types) and `StructureRecorderDispatcher`, which fans each event out to the attached recorders. It is the twin of `FlowRecorder`, which watches a *run*; it does not own the spec, the DSL (`builder/FlowChartBuilder.ts` does) or any runtime event.

**The laws.**

- *Static shape only.* Events carry stage ids and structure, never a `runtimeStageId`, iteration or scope value, so a docs site drawing a chart's topology cannot see run data.
- *Endpoints before edges.* Every `onStageAdded` for A and B precedes `onEdgeAdded({ from: A, to: B })`; `onDeciderComplete` fires at the sub-builder's `.end()`, after every branch is announced; a name added through `.tag()` after the stage went out arrives as its own `onStageTagged`. `onSubflowMounted` is mount-only — a parent recorder gets no replay of the subflow's internal structure.
- *A recorder cannot break a build.* A throwing hook is caught, dev-warned and kept on `builder.getStructureBuildErrors()` (soft-capped at about 100 entries), and the other recorders still fire — except that recording the error reads `e.message` and `String(err)` outside any `try`, so a hook that throws a value that cannot be stringified (a null-prototype object, a getter that throws) makes the build throw.
- *Specs are `readonly` by contract, not frozen* — the builder still wires `.next` after `onStageAdded` — so mutating one is undefined behaviour; attach only recorders you trust.

Pinned by `test/lib/builder/structure/` (`StructureRecorder`, `StructureRecorderDispatcher`, `-wiring`, `-optionsBag`). A new hook is an interface member, a `fire*` method on the dispatcher and the builder's `_fire*` helper — it has no entry in the runtime hook registry (`recorder/hooks.ts · HOOKS`), the dispatcher fires each hook by name.

```typescript
import { flowChart, type StructureRecorder } from 'footprintjs';

const edges: string[] = [];
const topology: StructureRecorder = {
  id: 'topology',
  onEdgeAdded: (e) => edges.push(`${e.from} -> ${e.to}`),
};

flowChart('Seed', () => {}, 'seed', { structureRecorders: [topology] }) // attached before the seed event fires
  .addFunction('Work', () => {}, 'work')
  .build();

console.log(edges); // ['seed -> work']
```

Registering after `.build()` is refused — the chart is sealed. Layer L7 (`scripts/layering.config.cjs`): imports `builder/types` as types only and `devMode.ts` (L0). See also [`../README.md`](../README.md) and the run-time twin in [`../../engine/narrative/README.md`](../../engine/narrative/README.md).
