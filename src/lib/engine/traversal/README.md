# engine/traversal/ — the walker: one DFS pass, one phase chain

`FlowchartTraverser` is the one object that walks a built chart. `executeNode` is a trampoline: it runs `executeNodeStep` (one node, through the chain below) in a flat loop and follows tail continuations — linear `next`, a loop edge, a dynamic next, a decider's branch — as `ContinuationHop`s, so chain length and loop iterations stay flat on the stack. Only true nesting recurses — fork and selector children, and a decider's branch when the decider has a `next` of its own — under a depth cap (`MAX_EXECUTE_DEPTH`, 500; `RunOptions.maxDepth`) that counts NESTING along the call path: a nested driver sits one level below the driver that ran the context its own context was created from (`FlowchartTraverser · nestingDepthOf`), so parallel siblings share one level. A subflow mount runs in a fresh traverser whose root starts at depth 1, so it sits outside that cap. Each node goes through a hard-coded chain with no handler registry — `0a` lazy-resolve · `0` classify (a subflow mount) · `0b` parallel-for-each · `1` validate · `2a` selector · `2b` decider · `3` execute · `4` dynamic · `5` children · `6` continue · `7` leaf — and a node leaves at the first phase that owns it: a mount, a parallel-for-each, a selector and a decider each return from their own phase, the last two running their stage function through their handler (still via `executeStage`) rather than phase 3. The class comment on `FlowchartTraverser` still lists the older, shorter chain. The specialists it calls live in [`../handlers/`](../handlers/README.md). It owns the *order things happen in*; it does not own what a handler does, how a stage's scope is built, or the run lifecycle (`runner/`).

**The laws.**

- *`executeStage` is the one funnel every stage function passes through* — linear, streaming, pausable, decider, selector, fork-child and subflow-internal alike — so it is also the one owner of the declarative `retry` loop: a failed non-final attempt discards its staged writes, a pause and an abort are never retried, and one `runtimeStageId` and one commit bundle cover all attempts (`test/lib/engine/retry-execution.test.ts`).
- *`runtimeStageId` is stamped before the stage runs*, in `executeNodeStep`, from a counter the subflow traversers share by reference; the whole event-correlation model rests on it.
- *A failed success-commit is a stage failure*: a write nothing can clone (a function, a foreign Proxy) fails the stage's commit after its function returned, so `handlers/commitStage.ts` fires `onError` before rethrowing (linear, fork-child, decider and selector stages).
- *A failing stage's writes still land*: the traverser commits, then fires `onError` and rethrows (`test/lib/engine/scenario/error-capturing.test.ts`) — whatever was thrown. `throw null`, `undefined`, a null-prototype object or a Proxy whose traps throw still fire `onError` (with `structuredError.raw` = the value) and `run()` rejects with that ORIGINAL value: every catch block describes the value through `errors/errorInfo.ts · thrownText`, which never throws, and the signal guards (`isPauseSignal`, `isInterruptSignal`) are total (`test/lib/engine/scenario/throw-hostile-values.test.ts`).
- *The built chart is never edited.* A stage that returns a node gets a per-traverser overlay (`DynamicNodePatch`), so every node-shape read goes through the `eff*` accessors or a dynamic return breaks (`test/lib/engine/scenario/dynamic-graph-isolation.test.ts`).
- *Tail continuations come back as hops*, and a flat decider dispatch keeps its `InvokerStamp`, or a pause loses the stage that invoked it.
- *A loop is a flat hop, even through a decider that has a `next` of its own.* Such a decider runs its branch in a nested driver — a BRANCH FRAME — so its `next` can follow; a loop edge (a hop flagged `loop`, made by `loopHop`) to a node an ENCLOSING driver already ran — and this frame did not — LEAVES the frame (each driver keeps its ran-set; the frame gets the enclosing ones through `_frameOf`): the hop is handed back to the decider, which follows it at its own level and skips its `next`, because the branch never completed. It also leaves on a jump to a node of an enclosing decider's `next` chain (`tailIds`) — the decider follows it and skips its `next`, so the tail runs once, never inside the frame and again after it. A sideways jump to a sibling branch stays in the frame, exactly as through 9.39.0. So a loop through the decider never stacks (1,000 passes run at `maxDepth: 2`), and the `next` runs once, after the pass whose branch completes (`test/lib/engine/traversal/decider-next-loop.test.ts`).
- *A selector's own `loopTo` is a loop edge*: resolved like every other (`isLoopRef` → `loopHop`: iteration guard, `onLoop`), never a hop into the bare stub. A `$break` in the selector's own function commits that stage and stops BEFORE any `next` frame or loop edge is created; no continuation runs and no `onLoop` fires (`test/lib/engine/scenario/selector-break.test.ts`).
- *Depth counts nesting, and a reached cap fails the run.* A fork or selector of any width is one level (520 children run at the default cap). When a node would run past the cap, the driver throws `TraversalDepthError` (`handlers/TraversalDepthError.ts`, message `maximum traversal depth exceeded (<cap>)`) after firing `onError` itself — no stage ran, so no stage catch would — and `ChildrenExecutor` rethrows it whatever the fan-out's error mode, so `run()` rejects; it is never a contained child result (`test/lib/engine/security/max-depth-siblings.test.ts`).

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
