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
| **ResumeEntry** | A resume's ONE-SHOT re-entry: where the resumed run starts, what each subflow on the pause path takes on its first entry | "Execution resumed at Ask" |
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
import { FlowChartExecutor, NarrativeFlowRecorder } from 'footprintjs';

// Default narrative (auto-attached when narrative enabled)
const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();
executor.getNarrativeEntries().map((e) => e.text); // plain-English sentences

// Custom FlowRecorder
const metricsRecorder = {
  id: 'metrics',
  onLoop: (event) => metrics.trackLoop(event.target, event.iteration),
  onDecision: (event) => metrics.trackDecision(event.decider, event.chosen),
};
executor.attachFlowRecorder(metricsRecorder);
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
chart. It builds a **stand-in** for the paused stage (same id, name, tags; its
function is the resume half — or, for an `interrupt()` pause, the stage's own
function with the answer deposited — and its `next` is the stage's real
continuation) and plans the way down with `ResumeEntry.plan` (`handlers/ResumeEntry.ts`).

**The law: the resume's synthetic structure is used EXACTLY ONCE.** The stand-in
is where the resumed traversal STARTS (`TraverserOptions.entry`) — it is never
in the node map or the subflow dictionary, so no id can resolve to it. Each
subflow on the pause path takes its hop — its captured pre-pause state (seeding
the nested runtime INSTEAD of the inputMapper) and its entry point (the next
mount on the path, or the stand-in at the leaf) — on its FIRST entry, and never
again. The traverser's `root` stays the real chart, so after the re-entry
every loop target, every later subflow entry and every re-visit of the paused
stage resolves exactly as on a run.

```typescript
// A reviewer is asked inside a subflow mounted in a loop body; an unclear
// answer loops back to the stage that paused.
const review = flowChart('Check', check, 'check')
  .addPausableFunction('Ask', { execute: ask, resume: record }, 'ask')
  .addDeciderFunction('Clear?', isClear, 'is-clear')
  .addFunctionBranch('unclear', 'Unclear', noop, 'ask again', { loopTo: 'ask' })
  .addFunctionBranch('clear', 'Clear', noop)
  .end()
  .build();

// After resume(checkpoint, { answer: 'hmm?' }):
//   the resume half runs ONCE (the stand-in) → Clear? → loop to 'ask'
//   → the REAL 'Ask' runs its execute half and PAUSES AGAIN (a re-ask).
// After a later resume the outer loop reaches its head (outside the
// subflow), and the next pass through the Review mount is a FRESH entry:
// its inputMapper runs, its first stage runs, no stale seed.
```

Full run: `examples/runtime-features/pause-resume/09-ask-again-in-a-loop.ts`.

What that guarantees (pinned in `test/lib/pause/resume-real-chart*.test.ts`):

| After a resume… | …resolves to |
|---|---|
| a loop back to the paused stage | the REAL stage — it pauses again |
| a loop whose head is upstream of the resume point | the real head (top level or inside the subflow) |
| a later entry into a subflow on the pause path | its real root, its inputMapper, no captured seed |
| a pause N subflows deep | each outer subflow re-entered AT the next mount — no pre-mount stage re-runs |
| a capture for a subflow OFF the pause path | nothing — only the path's subflows take a seed |
| a path the chart cannot walk | refused in `resume()`, before any stage runs |

Before 9.27.1 the traversal was ROOTED at the stand-in and the leaf subflow's
root was swapped for it for the whole resumed run: a loop back to the paused
id re-ran the resume half (the stage never asked again), a loop target upstream
of the resume point hit a bare loop stub (one stage ran, then the run ended
silently), and a pause two subflows deep re-ran the outer subflow's stages
before the inner mount.

**Still true (by design):** the loop budget (`maxIterations`) is per LEG — a
resumed traversal counts its own loop edges (the checkpoint carries per-stage
visit counts, not per-edge loop counters), and `FlowLoopEvent.iteration`
restarts with it; `TraversalContext.loopIteration` stays monotonic.

**Known limitation (unchanged by 9.27.1, pinned in
`test/lib/pause/resume-known-limitations.test.ts`):** when the paused subflow is
mounted as a DECIDER BRANCH or a FORK CHILD, the dispatcher's own continuation
lives one level up and the checkpoint records only the innermost dispatcher
and one continuation id — a decider's `next` then runs inside the subflow (its
writes stay there), and a fork's join does not run. Fixing it needs the
dispatcher's level on the record (one continuation per level of the pause
path) — an additive checkpoint field, so a design decision of its own.

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
