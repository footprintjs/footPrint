# engine/

The graph traversal engine. Walks a tree of stages, executes each one, and captures the full execution context — what ran, what branched, what looped, what data flowed between stages — so that any consumer can reconstruct the complete causal chain.

Depends on `memory/` (state management) and `scope/` (state access).

---

## Why This Exists

FootPrint flowcharts are directed graphs: stages connected by next pointers, children, deciders, selectors, and subflow references. The builder constructs these graphs. Something needs to *walk* them.

But walking isn't enough. If you just execute stages in order, you get the final result — but you lose *how* you got there. Which branch did the decider take? Which children ran in parallel? How many times did the loop iterate? What did the decider see when it chose to reject?

The engine answers all of this by capturing execution context *during* traversal, not after. Every stage execution, every branch decision, every fork dispatch, every loop iteration is recorded as it happens. The result is two complementary narratives:

1. **Data narrative** (from `memory/`) — *"wrote userName = 'Alice', set riskScore = 0.87"*
2. **Flow narrative** (from this module) — *"chose Reject because riskScore > 0.5, looped back to retry (attempt 3 of 5)"*

Together they produce the full causal explanation. When a user asks *"Why was my loan rejected?"*, the engine's trace already contains the answer — which stages ran, what data each stage saw, which branch was taken and why. No log parsing. No reconstruction. The story writes itself during execution.

---

## The Three Primitives

Each one exists to serve the main goal: **traverse the execution graph while capturing every decision, branch, and data flow as a connected, replayable trace.**

---

### 1. FlowchartTraverser — "The Walker"

The core algorithm. Recursive pre-order DFS that processes each node through 7 phases.

**Why it connects to the main goal:** The traverser doesn't just execute stages — it *observes* execution. At every phase, it records what's happening: the narrative generator captures flow decisions and the runtime structure manager tracks the execution shape. The traverser is the single place where all of these observations converge, because it's the only thing that sees the full execution order.

**Why pre-order DFS?** Because execution order matches traversal order. When you visit a node, you execute it *before* visiting its children — that's pre-order. The stage runs, commits its data, and then the traverser dispatches children or follows the next pointer. This means the trace is naturally chronological — you don't need to sort or reorder events after the fact.

**Why 7 phases?** Each phase is a distinct concern with a clear invariant:

| Phase | Name | What it does | What it captures |
|-------|------|--------------|-----------------|
| 0 | CLASSIFY | Detect subflow references, delegate to SubflowExecutor | "Entering the LLM Core subflow" |
| 0b | PARALLEL-FOR-EACH | Dynamic fan-out: resolve items, generate one branch subflow per item, commit the ordered results | "Reviewed 3 chunks in parallel" |
| 1 | VALIDATE | Check node invariants (decider has children? selector has children?) | Fail-fast errors before wasted work |
| 2 | EXECUTE | Run stage function, commit patch, check break | "The process began with Validate Input" |
| 3 | DYNAMIC | Detect StageNode returns, auto-register subflows | Dynamic graph extension (stages that produce new stages) |
| 4 | CHILDREN | Dispatch fork (parallel), selector (filtered), decider (conditional) | "3 paths executed in parallel: email, sms, push" |
| 5 | CONTINUE | Resolve dynamic next / linear next, handle iteration | "On pass 3 through Retry" |
| 6 | LEAF | No continuation — return output | Terminal node, trace complete for this branch |

Each phase is independently testable. Adding a new cross-cutting concern (say, timing) means adding observation calls to the right phase, not editing a 450-line method.

**Why is PARALLEL-FOR-EACH numbered 0b?** Because it must run BEFORE VALIDATE. A `addParallelForEach` node legitimately has no stage function, no static children and no decider — its branches do not exist until `items()` runs against live scope — so VALIDATE's "must define fn OR children" check would reject a perfectly valid chart. Like the decider and selector phases, it owns its own commit (the ordered results array). Each branch executes as a generated SUBFLOW at path segment `<stageId>~<index>` (see `branchSegment.ts`), which is why every trace query reads branch commits with no changes at all. Design: `docs/design/execution-control.md`.

```typescript
const traverser = new FlowchartTraverser({
  root,              // StageNode tree (from builder)
  stageMap,          // Map<name, fn> (from builder)
  scopeFactory,      // creates scope per stage (from scope/)
  executionRuntime,   // execution session (shared memory + history)
  scopeProtectionMode: 'warn',
  logger,
  narrative,         // ControlFlowNarrativeGenerator (optional)
});

const result = await traverser.execute();
// result = final stage's return value
// narrative.getSentences() = ["The process began with...", "A decision was made...", ...]
```

**Key design decision:** TraverserOptions object instead of 15 positional constructor params. The old Pipeline constructor took 15 args — impossible to read, impossible to extend. The options object makes each parameter self-documenting and lets you add new options without breaking existing callers.

---

### 2. Handlers — "The Specialists"

Focused modules, each owning one aspect of execution. The traverser delegates to them — it never does the work itself.

**Why they connect to the main goal:** Each handler captures domain-specific trace information that the traverser can't know about. The DeciderHandler records *which* branch was chosen and *why*. The ContinuationResolver records *which* iteration this is. The SubflowExecutor records entry/exit boundaries. If all of this lived in the traverser, it would be a monolith again — and worse, you couldn't test branch tracing without also testing loop tracing and subflow tracing.

| Handler | What it owns | What it captures |
|---------|-------------|-----------------|
| **StageRunner** | Execute a single stage function, manage patch lifecycle | Stage execution + commit |
| **NodeResolver** | Find nodes by ID, resolve `$ref` subflow references | Graph navigation |
| **ChildrenExecutor** | Parallel `Promise.allSettled` fan-out | Which children ran, which succeeded/failed |
| **DeciderHandler** | Single-choice conditional branching | "Decided: chose 'reject'" |
| **SelectorHandler** | Multi-choice filtered fan-out | "Selected 2 of 4: email, sms" |
| **ContinuationResolver** | Back-edge resolution + iteration counting | "Iteration 3 of max 1000" |
| **SubflowExecutor** | Isolated recursive execution with scoped runtime | "Entering/exiting subflow" |
| **ResumeEntry** | A resume's ONE-SHOT re-entry: where the resumed run starts, what each subflow on the pause path takes on its first entry, which dispatcher continuation runs after it, which waiting sibling pause is raised next | Nothing of its own — a PLAN, read before the run starts (`onResume` comes from the executor; a waiting sibling's pause is announced by the traverser's `onPause`) |
| **SubflowInputMapper** | Pure functions for subflow data contracts | Input/output mapping between parent and child |
| **RuntimeStructureManager** | Mutable structure tracking | Execution shape for visualization |

**Key design decision:** Handlers receive `HandlerDeps` (a dependency injection bag), not a reference to the traverser. This means handlers can be tested by constructing a minimal deps object with mocks — you don't need to instantiate a full traverser to test branch logic.

---

### 3. FlowRecorder System — "The Observers"

Pluggable observers for control flow events. Mirrors the scope-level `ScopeRecorder` pattern at the engine layer.

**Why it connects to the main goal:** Every control flow decision — which branch was taken, how many times the loop ran, which subflow was entered — is a fact that consumers need. But different consumers need different views of those facts. An LLM needs a concise narrative. A dashboard needs metrics. An audit system needs every event. The FlowRecorder system lets all of them observe the same traversal without interfering with each other or with execution.

**Architecture:**

```
FlowRecorderDispatcher (implements IControlFlowNarrative)
     │
     ├── NarrativeFlowRecorder (default — produces plain-English sentences)
     ├── WindowedNarrativeFlowRecorder (first N + last M, skip middle)
     ├── SilentNarrativeFlowRecorder (summary only)
     ├── AdaptiveNarrativeFlowRecorder (full detail → sampling)
     ├── Custom FlowRecorder (metrics, audit, telemetry, ...)
     └── ...any number of observers
```

The `FlowRecorderDispatcher` implements `IControlFlowNarrative`, so it drops into the traverser's `HandlerDeps` without changing any handler code. Each hook call fans out to all attached recorders with try/catch isolation — a failing recorder never breaks execution.

**Two narrative systems, complementary:**

```
scope/ScopeRecorder (data events)         = DATA observation  → "wrote userName = 'Alice'"
engine/FlowRecorder (flow events)    = FLOW observation  → "chose Reject because riskScore > 0.5"
CombinedNarrativeRecorder            = MERGE both        → the full story (inline during traversal)
```

**Quick start:**

```typescript
import { flowChart, FlowChartExecutor, type FlowRecorder } from 'footprintjs';

const chart = flowChart<{ count: number }>('Seed', (s) => { s.count = 0; }, 'seed')
  .addFunction('Tick', (s) => { s.count += 1; }, 'tick')
  .addDeciderFunction('Check', (s) => s.count < 2 ? 'again' : 'done', 'check')
  .addFunctionBranch('again', 'Again', () => {})
  .loopTo('tick')
  .addFunctionBranch('done', 'Done', () => {})
  .end()
  .build();

// Default narrative (auto-attached when narrative enabled)
const executor = new FlowChartExecutor(chart);
executor.enableNarrative();

// Custom FlowRecorder — attach before running so it observes the events.
const loops: Array<{ target: string; iteration: number }> = [];
const decisions: Array<{ decider: string; chosen: string }> = [];
const metricsRecorder: FlowRecorder = {
  id: 'metrics',
  onLoop: (event) => { loops.push({ target: event.target, iteration: event.iteration }); },
  onDecision: (event) => { decisions.push({ decider: event.decider, chosen: event.chosen }); },
};
executor.attachFlowRecorder(metricsRecorder);
await executor.run();
executor.getNarrativeEntries().map((e) => e.text); // plain-English sentences
```

**Built-in strategies for loop compression:**

| Strategy | Best for | Output shape |
|---|---|---|
| `NarrativeFlowRecorder` | Default — full detail | Every iteration, every event |
| `WindowedNarrativeFlowRecorder(3, 2)` | Moderate loops (10–200) | First 3 + last 2, skip middle |
| `SilentNarrativeFlowRecorder` | Iteration details irrelevant | "Looped 50 times through X." |
| `AdaptiveNarrativeFlowRecorder(5, 10)` | Unknown loop counts | Full for 5, then every 10th |
| `ProgressiveNarrativeFlowRecorder(2)` | Convergence loops | Powers of 2: 1, 2, 4, 8, 16... |
| `MilestoneNarrativeFlowRecorder(10)` | Progress markers | Every 10th iteration |
| `RLENarrativeFlowRecorder` | Simple retry loops | "Looped 50 times (passes 1–50)." |
| `SeparateNarrativeFlowRecorder` | UIs with collapsible sections | Clean main + full loop in separate channel |

All strategies are tree-shakeable — consumers import only what they use.

**FlowRecorder interface:**

```typescript
interface FlowRecorder {
  readonly id: string;
  onStageExecuted?(event: FlowStageEvent): void;
  onNext?(event: FlowNextEvent): void;
  onDecision?(event: FlowDecisionEvent): void;
  onFork?(event: FlowForkEvent): void;
  onSelected?(event: FlowSelectedEvent): void;
  onSubflowEntry?(event: FlowSubflowEvent): void;
  onSubflowExit?(event: FlowSubflowEvent): void;
  onLoop?(event: FlowLoopEvent): void;
  onBreak?(event: FlowBreakEvent): void;
  onError?(event: FlowErrorEvent): void;
  onStageRetry?(event: FlowStageRetryEvent): void;
}
```

All hooks are optional — implement only what you need. The `id` field supports attach/detach by identity.

**Key design decisions:**
- **Mirrors scope ScopeRecorder** — if you know ScopeRecorder, you know FlowRecorder
- **Dispatcher = Null Object** — when no recorders attached, fast-path returns immediately (~0 cost)
- **Error isolation** — try/catch per recorder per hook, errors swallowed, never breaks execution
- **Non-breaking additive** — default behavior preserved; NarrativeFlowRecorder auto-attached when narrative enabled

---

## How They Work Together

The full flow for traversing one node:

```
1. FlowchartTraverser.executeNode(node, context)

2. Phase 0: CLASSIFY
   → Is this a subflow reference ($ref)?
   → Yes: SubflowExecutor handles it (isolated recursive traversal)
   → No: continue

3. Phase 1: VALIDATE
   → Decider without children? Throw.
   → Selector without children? Throw.
   → No fn, no children, no decider? Throw.

4. Phase 2: EXECUTE
   → StageRunner creates scope, runs stage function
   → Stage writes through scope → TransactionBuffer → commit to SharedMemory
   → narrative.onStageExecuted('Validate Input')
   → Break flag set? STOP. Return output.

5. Phase 3: DYNAMIC
   → Did stage return a StageNode? (dynamic graph extension)
   → Yes: auto-register as subflow, update runtime structure
   → No: continue

6. Phase 4: CHILDREN
   → Fork: ChildrenExecutor runs all children via Promise.allSettled
   → Decider: DeciderHandler calls decider fn, picks one child
   → Selector: SelectorHandler calls selector fn, picks N children
   → narrative.onFork / onDecision / onSelected

7. Phase 5: CONTINUE
   → Has dynamic next (stage returned a continuation)? Follow it.
   → Has static next (node.next)? Follow it.
   → ContinuationResolver tracks iteration count (back-edge detection)
   → narrative.onNext / onLoop

8. Phase 6: LEAF
   → No children, no next → return stage output
   → This branch's trace is complete
```

For subflow execution:

```
Parent traverser hits a subflow reference
     |
     SubflowInputMapper.extractParentScopeValues()
     → maps parent scope values into subflow's initial state
     |
     SubflowExecutor creates isolated:
     → new ExecutionRuntime (own SharedMemory, own EventLog)
     → new FlowchartTraverser (own traversal, own narrative)
     |
     Subflow executes independently (full recursive traversal)
     |
     SubflowInputMapper.applyOutputMapping()
     → maps subflow results back into parent scope
     |
     Parent traverser continues with next node
```

### Resume re-entry — one-shot (M2)

`FlowChartExecutor.resume()` has to get back to a stage in the middle of the
chart. It builds a **stand-in** for the paused stage — the stage's OWN node
(id, name, tags, and its shape: a decider's or selector's branches, a fork
parent's children, its `next`) with its function swapped for the resume half
(or, for an `interrupt()` pause, for the stage's own function with the answer
deposited) — and plans the way down with `ResumeEntry.plan`
(`handlers/ResumeEntry.ts`).

**The law: the resume's synthetic structure is used EXACTLY ONCE.** The stand-in
is where the resumed traversal STARTS (`TraverserOptions.entry`) — it is never
in the node map or the subflow dictionary, so no id can resolve to it. Each
subflow on the pause path takes its hop — its captured pre-pause state (seeding
the nested runtime in place of the inputMapper's values; the mapper still runs,
for the stages' read-only args) and its entry point (the next mount on the
path, or the stand-in at the leaf) — on its FIRST entry, and never again. The
traverser's `root` stays the real chart, so after the re-entry every loop
target, every later subflow entry and every re-visit of the paused stage
resolves exactly as on a run.

**One rule at every level — what runs after the entry.** On the run, whatever
DISPATCHED the paused stage (or the mount of the next subflow on the path) ran
its own continuation once that child's chain ended: a decider's `next`, a
selector's `next`, a fork's join. A resume enters AT the child, so the entry
is the child with that continuation attached where its chain ends —
`{ ...child, next: dispatcher.next }`, never registered anywhere. It is read
from the CHART (`ResumeEntry.plan` indexes each level's graph: node →
enclosing dispatcher), not from the checkpoint, so it lands at the level it
belongs to — a top-level decider's `next` runs at the top level after the
subflow's outputMapper, not inside the subflow — and no checkpoint field
can redirect a run (the legacy `continuationStageId`, which a checkpoint
written before 9.39.0 may carry, is dropped by the upcaster in
`pause/record.ts`).

```typescript
// Sequence(Conditional(agent)): the agent asks a person, deep inside.
const conditional = flowChart('Initialize', init, 'seed')
  .addDeciderFunction('Route', route, 'route')
  .addSubFlowChartBranch('agent-a', agentA, 'AgentA', { outputMapper: toResult })
  .addSubFlowChartBranch('agent-b', agentB, 'AgentB', { outputMapper: toResult })
  .end()
  .addFunction('Finalize', finalize, 'finalize') // Route's continuation
  .build();
const chart = flowChart('Start', start, 'start')
  .addSubFlowChartNext('step-1', conditional, 'Step1', { outputMapper: toStepFinal })
  .addFunction('Done', done, 'done')
  .build();

// Paused at step-1/agent-a/tool. resume(checkpoint, answer) plans:
//   top:     the step-1 mount (on the spine — nothing to attach)
//   step-1:  { ...mount of agent-a, next: Finalize }   ← Route's continuation
//   agent-a: the stand-in for 'tool' (its own next: Reply)
// so after the answer: tool → Reply → (agent-a's outputMapper) → Finalize →
// (step-1's outputMapper) → Done. Initialize and Route do not run again.
```

**Parallel siblings that paused too.** When two children of one fork (or two
selected branches) pause in the same pass, only one question can be asked:
`ChildrenExecutor` raises the first (child order) and queues the others on it
(`PauseSignal.pendingPauses` → `FlowchartCheckpoint.pendingPauses`: stage,
path, own captures, question). At that fan-out's level the resume's entry is
the child's own chain only — no join — and once it ends the traverser raises
the next sibling's pause again as it was (`raiseQueuedPause`: nothing of the
sibling re-runs; `onPause` fires for it); a pause raised from inside the chain
carries every waiting sibling instead (`queueBehind`). The join runs when the
LAST sibling is resumed. A fail-fast fork waits for its siblings before it
pauses (a pause is not an error), so none is raced past.

```typescript
// Pre → [c1, c2] → Join, both children ask.
await executor.run();          // paused: c1's question; pendingPauses: [c2's]
await executor.resume(cp1, a1); // c1 finishes → paused again: c2's question
await executor.resume(cp2, a2); // c2 finishes → Join runs, once
```

Full runs: `examples/runtime-features/pause-resume/09-ask-again-in-a-loop.ts`,
`examples/runtime-features/pause-resume/10-two-questions-at-once.ts`.

What that guarantees (pinned in `test/lib/pause/resume-*.test.ts`, and by the
fast-check property in `resume-real-chart.property.test.ts`: a run paused and
resumed at every pause equals the same chart run with every answer up front,
for every placement of every subflow on the path):

| After a resume… | …resolves to |
|---|---|
| a loop back to the paused stage | the REAL stage — it pauses again |
| a loop whose head is upstream of the resume point | the real head (top level or inside the subflow) |
| a later entry into a subflow on the pause path | its real root, its inputMapper, no captured seed |
| a pause N subflows deep | each outer subflow re-entered AT the next mount — no pre-mount stage re-runs |
| a mount (or the paused stage) that is a decider / selector branch or a fork child | the dispatcher's continuation, at its own level |
| a decider-level `loopTo` continuation | a LOOP edge (`onLoop`, counted toward `maxIterations`) |
| `interrupt()` inside a decider / selector / fork-parent function | the stage re-runs AND dispatches |
| several parallel siblings paused | asked in turn; the join after the last |
| `$getArgs()` inside a re-entered subflow | the inputMapper's result, as on a run |
| a capture for a subflow OFF the pause path | nothing — only the path's subflows take a seed |
| an OUTER subflow's capture missing (a degraded checkpoint) | that subflow re-runs from its root with its inputMapper |
| a path the chart cannot walk, or a subflow id mounted twice | refused in `resume()`, before any stage runs |

`onResume` (fired by the executor, before `onRunStart`) names the stand-in's own
`runtimeStageId` — one execution per mount on the path runs before it
(`ResumeEntry.stepsBeforeStandIn`); only a degraded checkpoint missing an outer
capture, whose opening stages re-run, makes that count unknowable up front.

Before 9.28.0 the traversal was ROOTED at the stand-in and the leaf subflow's
root was swapped for it for the whole resumed run: a loop back to the paused
id re-ran the resume half (the stage never asked again), a loop target upstream
of the resume point hit a bare loop stub (one stage ran, then the run ended
silently), a pause two subflows deep re-ran the outer subflow's stages before
the inner mount, and a paused subflow mounted as a branch or fork child lost
its parent's continuation.

**Still true (by design):** the loop budget (`maxIterations`) is per LEG — a
resumed traversal counts its own loop edges (the checkpoint carries per-stage
visit counts, not per-edge loop counters), and `FlowLoopEvent.iteration`
restarts with it; `TraversalContext.loopIteration` stays monotonic.

**Known limitations (pinned in `test/lib/pause/resume-known-limitations.test.ts`):**
a pause inside a LAZY subflow or an `addParallelForEach` branch is refused
(their graphs are resolved at run time, not in the chart a resume walks); a
paused parallel-branch STAGE (a plain fork child or selected branch) resumes in
its dispatcher's context, not its branch's `runs/<branch>` namespace; and the
resumed child of a fan-out runs outside the fan-out's `allSettled`, so a failure
after the resume fails the run. Each as in 9.27.0.

### Ids and stamps — one owner each (F7, 9.37.0)

- **The id grammar** `[subflowPath/]stageId#executionIndex` has one owner,
  [`../ids/runtimeStageId.ts`](../ids/README.md). Every reader asks it
  (`stageIdOf`, `subflowPathOf`, `isExecutionKey`, …) — no file outside
  `ids/` splits on `#` or `/`. Its delimiters are RESERVED: the builder refuses
  them in every user-authored id (R5), so last-delimiter parsing is sound.
- **One prefixer.** [`graph/prefixNodeTree.ts`](./graph/prefixNodeTree.ts) is
  the subflow-id prefixer for both the builder (mount time) and the traverser
  (lazy subflows, `parallelForEach` branches). It never refuses — the ids it
  writes carry `/` on purpose.
- **One stamp constructor.** [`traversalContext.ts`](./traversalContext.ts)
  builds every `TraversalContext`: the per-stage stamp, the run-boundary root,
  and the executor's `onResume`. The resume stamp names the real subflow
  (`subflowId`, the paused stage's innermost) and depth (subflows deep — the
  one meaning `depth` has on every stamp), and
  LINKS to the paused execution through `resumedFrom` — a link, not a parent:
  a resume is a new `runId`.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const inner = flowChart('Plan', () => {}, 'plan')
  .addPausableFunction('Ask', { execute: () => ({ q: 'ok?' }), resume: () => {} }, 'ask')
  .build();
const chart = flowChart('Init', () => {}, 'init').addSubFlowChartNext('sf', inner, 'Inner').build();

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder({
  id: 'resume-probe',
  onResume: (e) => console.log(e.traversalContext?.subflowId, e.traversalContext?.resumedFrom),
});
await executor.run();
await executor.resume(executor.getCheckpoint()!, { answer: 'yes' });
// → 'sf' { runId: '<the paused run>', runtimeStageId: 'sf/ask#3' }
```

The link is read off the checkpoint's one optional `pausedExecution` field, so a
resume records the same wherever its checkpoint came from; an older checkpoint
resumes without one. `depth` has one meaning on every stamp — the subflow
nesting of the stage's address, read off its runtimeStageId.

---

## Design Decisions — Each Traced Back to the Main Goal

| Decision | Why | How it serves the goal |
|---|---|---|
| Pre-order DFS | Execution order = traversal order | Trace is naturally chronological — no post-hoc sorting |
| 7 explicit phases | Each concern isolated, independently testable | New trace types (timing, cost) = new observer calls, not monolith edits |
| HandlerDeps injection | Handlers don't know about traverser | Test branch logic with mocks, no full engine setup needed |
| TraverserOptions object | Replaces 15 positional params | Self-documenting, extensible without breaking callers |
| Narrative at decision time | Sentences written when context is unambiguous | No hallucination risk — recording facts, not inferring them |
| Null Object for narrative | No conditionals in hot path | Zero-cost when narrative is disabled |
| ContinuationResolver iteration limit | Default 1000 max iterations per node | Prevents infinite loops from user code, always terminates |
| SubflowExecutor isolation | Own runtime, own memory, own narrative | Subflow can't corrupt parent state — clean I/O mapping at boundaries |
| Promise.allSettled for forks | All children run, failures don't cancel siblings | Trace captures all outcomes, not just the first failure |
| Dynamic StageNode detection | Stages can return new graph fragments at runtime | Supports LLM-generated execution plans (dynamic graph extension) |

---

## Dependency Graph

```
         FlowchartTraverser
        /         |         \
  handlers/   narrative/    graph/
       |          |
  HandlerDeps  FlowRecorderDispatcher
  (types.ts)     ├── NarrativeFlowRecorder
       |         ├── recorders/ (7 built-in strategies)
  memory/        └── custom FlowRecorders
  scope/
```

External dependencies: none (inherits lodash from memory/).

---

## Test Coverage

Four test tiers across the engine:

| Tier | What it proves | Example |
|---|---|---|
| **unit/** | Individual module correctness | NodeResolver.findNodeById, FlowRecorderDispatcher fan-out, strategy compression |
| **scenario/** | Multi-step workflow correctness | linear chain A→B→C, FlowRecorder in real traversal, decider routing |
| **property/** | Invariants hold for random inputs | maxIterations enforced, suppressed + emitted = total for all strategies |
| **boundary/** | Edge cases and extremes | 0 iterations, 10K iterations, rapid attach/detach, empty recorders |
