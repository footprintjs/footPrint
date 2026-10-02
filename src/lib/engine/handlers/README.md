# engine/handlers/ — the specialists the traverser hands each node shape to

One class per concern, each built from the traverser's `HandlerDeps` (`../types.ts`). They own what happens *at* a fork, a decider, a loop edge, a subflow mount or a resume entry; the walk itself — the phase chain, the trampoline, `executeStage` and its retry loop — stays in `../traversal/FlowchartTraverser.ts`.

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
- *Two doors per dispatcher.* `DeciderHandler.prepareDispatch` (runs the decider stage) and `ContinuationResolver.resolveTarget` (a loop edge or dynamic next) each resolve their target **without executing it**, so the trampoline takes a branch or a loop edge as a flat hop and a loop-heavy chart never grows the stack (`test/lib/engine/traversal/trampoline.test.ts`); `handleScopeBased` and `resolve` execute it for direct callers.
- *A decider commits before it resolves its branch*, so its writes are in the log when `onDecision` fires.
- *A resume re-enters once.* `ResumeEntry`'s stand-in is only where the resumed traversal starts, never a node an id resolves to (`test/lib/pause/resume-real-chart.property.test.ts`).
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
