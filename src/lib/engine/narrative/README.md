# engine/narrative/ — the control-flow channel: events, fan-out and the story

The whole `FlowRecorder` channel, not just text: `FlowRecorder` and its event types (`types.ts`, with the `TraversalContext` stamped on every event), `IControlFlowNarrative` (what the handlers call), `FlowRecorderDispatcher` (fan-out to the attached recorders), `NullControlFlowNarrativeGenerator` (the zero-cost disabled path), `NarrativeFlowRecorder` (the default plain-English sentences) and `CombinedNarrativeRecorder` with `narrativeTypes.ts` (the story that merges flow events with data reads and writes). The loop-compression strategies are in [`recorders/`](./recorders/README.md). It owns what an event looks like and how it reaches every recorder; *who fires it* is `engine/handlers/` and the traverser.

**The laws.**

- *One context on nearly every event.* `TraversalContext` carries `runId`, `runtimeStageId`, `parentRuntimeStageId`, `subflowPath` and `loopIteration`, and scope events carry the same `runtimeStageId` — which is how `CombinedNarrativeRecorder` buffers a stage's reads and writes (they fire *during* the stage) and flushes them when that stage's flow event arrives. It is optional on the event types, and three emitters leave it out: `onSubflowRegistered`, an `onLoop` fired for a decider's own `loopTo` or a dynamic next, and the `onPause` re-raised for a waiting parallel sibling on resume.
- *`onStageExecuted` is uniform.* It fires for every stage kind, after the specialized event (`onDecision`, `onFork`, `onSelected`, `onSubflowEntry`), carrying `stageType` — which is why `NarrativeFlowRecorder` narrates only linear stages from there and leaves the rest to their own events (`test/lib/engine/unit/onStageExecuted-uniform.test.ts`). Some shapes fire it more than once on one stage: a fork parent that has its own stage function (`'linear'` after the function, `'fork'` after `onFork`, so `NarrativeFlowRecorder` narrates that parent as a linear stage as well); a selector that picks a branch (`'selector'`, then `'fork'` for the internal `selector-temp` node it fans out through, which adds a "Forking into N parallel paths" line); and a stage that returns `{ children, nextNodeSelector }` (three times: `'linear'`, `'selector'`, `'fork'`).
- *A recorder hook cannot abort traversal — with two exceptions.* `FlowRecorderDispatcher` wraps every recorder hook call in a try/catch (dev-warned), calls each attached recorder once per event, and with none attached each method is an early return (`test/lib/engine/unit/FlowRecorderDispatcher.test.ts` pins the isolation and that calls with no recorder attached are harmless no-ops, `test/lib/engine/property/flow-recorder-invariants.test.ts` the once-per-event fan-out). The exception is dev mode: the catch interpolates the thrown value, so one that cannot be stringified (a null-prototype object) escapes and aborts that path — `run()` rejects, unless the path is a fork child, whose result records the error instead; and `onResume` never goes through the dispatcher — `FlowChartExecutor · resume` calls it directly and unguarded, so a throwing `onResume` rejects `resume()` before any stage runs.
- *A new hook is a sync rule*: `FlowRecorder`, `IControlFlowNarrative`, the dispatcher, the Null generator (its interface is required), `FLOW_RECORDER_EVENT_METHODS` in `recorder/CombinedRecorder.ts` — miss that one and deferred recorders silently never see it — the default sentence, the combined narrative and its formatter, and `CompositeRecorder`. A retry is the one flow event that fires during a stage, so the narrative buffers it (`bufferOp`) rather than print it above its own stage header.

```typescript
import { flowChart, narrative } from 'footprintjs';

const trace = narrative(); // a CombinedNarrativeRecorder: flow events and data in one story
await flowChart<{ n: number }>('Count', (scope) => { scope.n = 1; }, 'count')
  .addFunction('Double', (scope) => { scope.n *= 2; }, 'double')
  .build()
  .recorder(trace)
  .run();

console.log(trace.getEntries().map((e) => e.text).join('\n'));
// Stage 1: The process began with Count.
// Step 1: Write n = 1
// Stage 2: Next, it moved on to Double.
// Step 1: Read n = 1
// Step 2: Write n = 2
```

Layer L5 (`scripts/layering.config.cjs`) — deliberately *below* the rest of `engine/` (L6), so `recorder/` and `runner/` can use it: it imports `capture/summarize`, `decide/types`, `devMode`, `engine/errors` (L1) and `recorder/` (stores and `CombinedRecorder`), never the traverser. See also [`../README.md`](../README.md).
