# engine/handlers/ — the specialists the traverser hands each node shape to

One class per concern, built by the traverser's constructor from `HandlerDeps` (`../types.ts`) — `StageRunner`, `NodeResolver`, `ChildrenExecutor`, `SelectorHandler`, `DeciderHandler`, `ContinuationResolver`, `ParallelForEachHandler`, `SubflowExecutor` — beside four helpers that are not built from it (`RuntimeStructureManager`, `ResumeEntry`, and the functions in `SubflowInputMapper` and `servedSubflowResults`). They own what happens *at* a fork, a decider, a loop edge, a subflow mount or a resume entry; the walk itself — the phase chain, the trampoline, `executeStage` and its retry loop — stays in `../traversal/FlowchartTraverser.ts`.

| File | Owns |
|---|---|
| `StageRunner` | running one stage function: scope from the factory, the protection proxy, streaming callbacks |
| `NodeResolver` | DFS lookup by id (loop targets) and subflow-reference resolution |
| `ChildrenExecutor`, `SelectorHandler`, `DeciderHandler` | parallel fan-out (`allSettled`, or fail-fast) · filtered multi-choice fan-out · single-choice branching |
| `ParallelForEachHandler` | dynamic fan-out: one generated subflow branch per item, `<stageId>~<index>` |
| `ContinuationResolver` | back-edges and dynamic `next`: iteration counting (`DEFAULT_MAX_ITERATIONS`), `onLoop` |
| `SubflowExecutor`, `SubflowInputMapper` | the isolation boundary: a fresh `ExecutionRuntime`, `inputMapper` seeds, `outputMapper` merges back; `servedSubflowResults` picks the state a result serves under `getSnapshot({ redact: true })` |
| `ResumeEntry`, `RuntimeStructureManager` | a resume's one-shot re-entry · the run's structure, and `computeNodeType`, the one flag → node-type mapping |

**The laws.**

- *Handlers never import the traverser.* They take its entry points as callbacks (`ExecuteNodeFn`, `RunStageFn` in `types.ts`), which is what lets the traverser import them.
- *Two doors per dispatcher.* `DeciderHandler.prepareDispatch` (runs the decider stage) and `ContinuationResolver.resolveTarget` (a loop edge or dynamic next) each resolve their target **without executing it**, so the trampoline takes a branch or a loop edge as a flat hop, and a loop whose decider has no continuation of its own stays flat on the stack (`test/lib/engine/traversal/trampoline.test.ts`); a decider that does have a `next` nests instead — see the known gap in [`../traversal/`](../traversal/README.md). `handleScopeBased` and `resolve` execute it for direct callers.
- *A decider commits before it resolves its branch*, so its writes are in the log when `onDecision` fires.
- *A mount records its own acts (R13).* The `outputMapper` merge-back is staged and committed on the MOUNT's frame — for a branch or fork-child mount at its parent's address (`StageContext · useAddressOf`), so the values land where they always did — and the subflow's seed (`history[0]`) is stamped with the mount's `stage` / `stageId` / `runtimeStageId`. So `findLastWriter` names the mount, `causalChain` reaches the mount's commit, and `timeTravel` folds the merge-back into the mount's stop. Through 9.33.0 the merge-back carried the stage before the mount (or the decider) and the seed carried `''` (`test/lib/slice/nested-rows.test.ts`).
- *A resume re-enters once.* `ResumeEntry`'s stand-in is only where the resumed traversal starts, never a node an id resolves to (`test/lib/pause/resume-real-chart.property.test.ts`).
- *A reached depth cap is never a contained child result*: `ChildrenExecutor` rethrows a child's `TraversalDepthError` (the child never ran) whatever the fan-out's error mode — after every sibling settles — so `run()` rejects instead of resolving with dropped work; every other child error stays in the result bundle as before.
- *Known gap:* `ChildrenExecutor` can break a fork's parent when every child broke, but every call site passes no parent flag, so a fork's break does not propagate in a real run.

```typescript
import { decide, flowChart, type FlowRecorder } from 'footprintjs';

const seen: string[] = [];
const watcher: FlowRecorder = { id: 'watcher', onDecision: (e) => seen.push(`${e.decider} chose ${e.chosen}`) };

await flowChart<{ score: number }>('Score', (scope) => { scope.score = 720; }, 'score')
  .addDeciderFunction('Route', (scope) => decide(scope, [{ when: { score: { gt: 700 } }, then: 'approve' }], 'review'), 'route')
    .addFunctionBranch('approve', 'Approve', () => {})
    .addFunctionBranch('review', 'Review', () => {})
    .end()
  .build()
  .recorder(watcher)
  .run();

console.log(seen); // ['Route chose Approve'] — DeciderHandler's event, observed from outside
```

Layer L6 (`scripts/layering.config.cjs`): the `engine/**` layer — it may import `memory/`, `scope/`, `reactive/`, `decide/`, `pause/` and `engine/narrative/` (all lower), and the traverser and `runner/` import it. See also [`../README.md`](../README.md).
