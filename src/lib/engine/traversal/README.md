# engine/traversal/ — the walker: one DFS pass, one phase chain

`FlowchartTraverser` is the one object that walks a built chart. `executeNode` is a trampoline: it runs `executeNodeStep` (one node, every phase) in a flat loop and follows tail continuations — linear `next`, a loop edge, a dynamic next, a decider's branch — as `ContinuationHop`s, so chain length and loop iterations never grow the stack. Only true nesting (fork children, a branch with a continuation of its own, a subflow mount) recurses, under a depth cap (`MAX_EXECUTE_DEPTH`, 500). Each node passes through a hard-coded chain — classify, parallel-for-each, validate, execute, dynamic, children, continue, leaf — with no handler registry; the specialists it calls live in [`../handlers/`](../handlers/README.md). It owns the *order things happen in*; it does not own what a handler does, how a stage's scope is built, or the run lifecycle (`runner/`).

**The laws.**

- *`executeStage` is the one funnel every stage function passes through* — linear, streaming, pausable, decider, selector, fork-child and subflow-internal alike — so it is also the one owner of the declarative `retry` loop: a failed non-final attempt discards its staged writes, a pause and an abort are never retried, and one `runtimeStageId` and one commit bundle cover all attempts (`test/lib/engine/retry-execution.test.ts`).
- *`runtimeStageId` is stamped before the stage runs*, in `executeNodeStep`, from a counter the subflow traversers share by reference; the whole event-correlation model rests on it.
- *A failing stage's writes still land*: the traverser commits, then fires `onError` and rethrows (`test/lib/engine/scenario/error-capturing.test.ts`).
- *The built chart is never edited.* A stage that returns a node gets a per-traverser overlay (`DynamicNodePatch`), so every node-shape read goes through the `eff*` accessors or a dynamic return breaks (`test/lib/engine/scenario/dynamic-graph-isolation.test.ts`).
- *Tail continuations come back as hops*, and a flat decider dispatch keeps its `InvokerStamp`, or a pause loses the stage that invoked it.

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
