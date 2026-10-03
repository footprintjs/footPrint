# engine/traversal/ — the walker: one DFS pass, one phase chain

`FlowchartTraverser` is the one object that walks a built chart. `executeNode` is a trampoline: it runs `executeNodeStep` (one node, through the chain below) in a flat loop and follows tail continuations — linear `next`, a loop edge, a dynamic next, a decider's branch — as `ContinuationHop`s, so chain length and loop iterations stay flat on the stack (with one exception, in the known gaps below). Only true nesting recurses — fork and selector children, and a decider's branch when the decider has a `next` of its own — under a depth cap (`MAX_EXECUTE_DEPTH`, 500; `RunOptions.maxDepth`) that counts the in-flight `executeNode` calls of one traverser (see the known gaps below). A subflow mount runs in a fresh traverser whose count starts at 0, so it sits outside that cap. Each node goes through a hard-coded chain with no handler registry — `0a` lazy-resolve · `0` classify (a subflow mount) · `0b` parallel-for-each · `1` validate · `2a` selector · `2b` decider · `3` execute · `4` dynamic · `5` children · `6` continue · `7` leaf — and a node leaves at the first phase that owns it: a mount, a parallel-for-each, a selector and a decider each return from their own phase, the last two running their stage function through their handler (still via `executeStage`) rather than phase 3. The class comment on `FlowchartTraverser` still lists the older, shorter chain. The specialists it calls live in [`../handlers/`](../handlers/README.md). It owns the *order things happen in*; it does not own what a handler does, how a stage's scope is built, or the run lifecycle (`runner/`).

**The laws.**

- *`executeStage` is the one funnel every stage function passes through* — linear, streaming, pausable, decider, selector, fork-child and subflow-internal alike — so it is also the one owner of the declarative `retry` loop: a failed non-final attempt discards its staged writes, a pause and an abort are never retried, and one `runtimeStageId` and one commit bundle cover all attempts (`test/lib/engine/retry-execution.test.ts`).
- *`runtimeStageId` is stamped before the stage runs*, in `executeNodeStep`, from a counter the subflow traversers share by reference; the whole event-correlation model rests on it.
- *A failing stage's writes still land*: the traverser commits, then fires `onError` and rethrows (`test/lib/engine/scenario/error-capturing.test.ts`) — unless the thrown value cannot be stringified (`throw null`, a null-prototype object): the write still lands, but `error.toString()` throws first, `onError` is skipped and `run()` rejects with that TypeError instead.
- *The built chart is never edited.* A stage that returns a node gets a per-traverser overlay (`DynamicNodePatch`), so every node-shape read goes through the `eff*` accessors or a dynamic return breaks (`test/lib/engine/scenario/dynamic-graph-isolation.test.ts`).
- *Tail continuations come back as hops*, and a flat decider dispatch keeps its `InvokerStamp`, or a pause loses the stage that invoked it.
- *Known gap — a looping decider that has a continuation of its own is not flat.* Such a decider runs its branch through a nested `executeNode` so its `next` can follow, so a branch that `loopTo`s back through it nests one level per pass — a loop of 500 passes hits the depth cap (`maximum traversal depth exceeded`; 499 ran) — and the `next` runs once per pass on the way out (a 5-pass loop ran it 5 times). Without that `next` the same loop is flat (`test/lib/engine/traversal/trampoline.test.ts` pins that shape).
- *Known gap — the depth cap counts parallel siblings.* `_executeDepth` counts every in-flight `executeNode` call of one traverser, so a top-level fork or selector with 500 or more children runs 499 (fewer when nested) and fails the rest with `maximum traversal depth exceeded` — captured in the result bundle, with no `onError`, while `run()` resolves; with `failFast`, `run()` rejects with that error instead. `RunOptions.maxDepth` lifts the limit.
- *Known gap — a selector's own `loopTo`.* A selector whose continuation is a `loopTo` hops into the bare loop-ref stub: the target runs once more with no `onLoop`, and the run ends.

```typescript
import { flowChart, FlowChartExecutor, type CombinedRecorder } from 'footprintjs';

const order: string[] = [];
const probe: CombinedRecorder = {
  id: 'probe',
  onStageStart: (e) => order.push(`start ${e.stageName}`),
  onWrite: (e) => order.push(`write ${e.key}`),
  onStageEnd: () => order.push('end'),
  onCommit: () => order.push('commit'),
  onStageExecuted: (e) => order.push(`executed ${e.stageName}`),
};

const executor = new FlowChartExecutor(flowChart<{ n: number }>('Count', (scope) => { scope.n = 1; }, 'count').build());
executor.attachCombinedRecorder(probe);
await executor.run();
console.log(order); // ['start Count', 'write n', 'end', 'commit', 'executed Count'] — the walker's order for one stage
```

Layer L6 (`scripts/layering.config.cjs`): the `engine/**` layer — it composes `handlers/`, `graph/`, `errors/`, `narrative/` and the `runtimeStageId` leaf, reads `memory/StageContext` as a type, and only `runner/` and the engine barrel import it. See also [`../README.md`](../README.md).
