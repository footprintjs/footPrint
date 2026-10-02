# engine/narrative/recorders/ — how much of a loop the narrative says, and a subflow manifest

Seven `FlowRecorder`s that decide how much of a *loop* the story tells, plus `ManifestFlowRecorder`, which builds a tree of the subflows a run entered. The seven extend `NarrativeFlowRecorder` (`../`) and override `onLoop`; the manifest implements `FlowRecorder` directly. They own the loop-compression policy; they do not own the event channel (`../`) or when a loop runs (`engine/handlers/ContinuationResolver`).

| Recorder | Tells of a loop |
|---|---|
| `AdaptiveNarrativeFlowRecorder(threshold = 5, sampleRate = 10)` | every pass up to the threshold, then every Nth |
| `MilestoneNarrativeFlowRecorder(interval = 10)` | the first pass and every Nth |
| `ProgressiveNarrativeFlowRecorder(base = 2)` | passes 1, 2, 4, 8, 16, … |
| `WindowedNarrativeFlowRecorder(head = 3, tail = 2)` | the first `head` and last `tail` passes; the middle is counted, not told |
| `RLENarrativeFlowRecorder()` · `SilentNarrativeFlowRecorder()` | one "looped N times through X" line per run of passes · one closing summary per target |
| `SeparateNarrativeFlowRecorder()` | nothing in the story; every pass sits behind `getLoopSentences()` |
| `ManifestFlowRecorder()` | no sentences — `getManifest()` is the tree of subflows actually entered, `getSpec(id)` a spec on demand |

**The laws.**

- *A strategy changes only the loop sentences.* Every other event keeps the base class's sentence, so swapping strategies never rewrites the rest of the story.
- *State resets in `clear()`*, so nothing leaks from one run into the next, and the counting strategies account for every pass — suppressed plus emitted equals total (`test/lib/engine/property/flow-recorder-invariants.test.ts`).
- *Where the line lands differs.* Adaptive, Milestone and Progressive speak in place, while RLE, Silent and Windowed aggregate and render their loop lines when `getSentences()` is read, after the rest.
- *The manifest only lists subflows that were entered*, hands out a copy, and a throwing manifest cannot break the dispatcher (`test/lib/engine/security/manifest-isolation.test.ts`, `test/lib/engine/property/manifest-invariants.test.ts`).

```typescript
import { decide, flowChart, FlowChartExecutor, WindowedNarrativeFlowRecorder } from 'footprintjs';

const chart = flowChart<{ tries: number }>('Start', (scope) => { scope.tries = 0; }, 'start')
  .addFunction('Work', (scope) => { scope.tries += 1; }, 'work')
  .addDeciderFunction('Check', (scope) => decide(scope, [{ when: { tries: { lt: 40 } }, then: 'again' }], 'done'), 'check')
    .addFunctionBranch('again', 'Again', () => {}, undefined, { loopTo: 'work' })
    .addFunctionBranch('done', 'Finish', () => {})
    .end()
  .build();

const windowed = new WindowedNarrativeFlowRecorder(2, 1); // first 2 passes, last 1
const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(windowed);
await executor.run();

console.log(windowed.getSentences().filter((s) => s.startsWith('On pass') || s.startsWith('...')));
// ['On pass 1 through Work.', 'On pass 2 through Work.', '... (36 iterations omitted)', 'On pass 39 through Work.']
```

Layer L5 (`scripts/layering.config.cjs`): imports `../NarrativeFlowRecorder` (value) and `../types` (type) only. Each is its own file so only what you import ships; all are on `footprintjs`, and `adaptive()`, `milestone()`, `windowed()` and `manifest()` are the `footprintjs/recorders` factories. See also [`../README.md`](../README.md).
