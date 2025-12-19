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

**Why it connects to the main goal:** The traverser doesn't just execute stages — it *observes* execution. At every phase, it records what's happening: the narrative generator captures flow decisions, the runtime structure manager tracks the execution shape, the extractor runner takes snapshots. The traverser is the single place where all of these observations converge, because it's the only thing that sees the full execution order.

**Why pre-order DFS?** Because execution order matches traversal order. When you visit a node, you execute it *before* visiting its children — that's pre-order. The stage runs, commits its data, and then the traverser dispatches children or follows the next pointer. This means the trace is naturally chronological — you don't need to sort or reorder events after the fact.

**Why 7 phases?** Each phase is a distinct concern with a clear invariant:

| Phase | Name | What it does | What it captures |
|-------|------|--------------|-----------------|
| 0 | CLASSIFY | Detect subflow references, delegate to SubflowExecutor | "Entering the LLM Core subflow" |
| 1 | VALIDATE | Check node invariants (decider has children? selector has children?) | Fail-fast errors before wasted work |
| 2 | EXECUTE | Run stage function, commit patch, check break | "The process began with Validate Input" |
| 3 | DYNAMIC | Detect StageNode returns, auto-register subflows | Dynamic graph extension (stages that produce new stages) |
| 4 | CHILDREN | Dispatch fork (parallel), selector (filtered), decider (conditional) | "3 paths executed in parallel: email, sms, push" |
| 5 | CONTINUE | Resolve dynamic next / linear next, handle iteration | "On pass 3 through Retry" |
| 6 | LEAF | No continuation — return output | Terminal node, trace complete for this branch |

Each phase is independently testable. Adding a new cross-cutting concern (say, timing) means adding observation calls to the right phase, not editing a 450-line method.

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

Ten focused modules, each owning one aspect of execution. The traverser delegates to them — it never does the work itself.

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
| **SubflowInputMapper** | Pure functions for subflow data contracts | Input/output mapping between parent and child |
| **ExtractorRunner** | Per-stage snapshot extraction | State snapshots at each step |
| **RuntimeStructureManager** | Mutable structure tracking | Execution shape for visualization |

**Key design decision:** Handlers receive `HandlerDeps` (a dependency injection bag), not a reference to the traverser. This means handlers can be tested by constructing a minimal deps object with mocks — you don't need to instantiate a full traverser to test branch logic.

---

### 3. ControlFlowNarrativeGenerator — "The Narrator"

Converts traversal events into plain-English sentences as they happen.

**Why it connects to the main goal:** This is the flow half of the causal explanation. When the engine traverses a decider node and takes the "reject" branch, the narrative generator produces *"A decision was made, and the path taken was Reject."* When the engine loops back to a retry stage, it produces *"On pass 3 through Retry."* These sentences are a first-class output — not debug logs, not optional annotations, but the story of what the engine did.

**Why not reconstruct the narrative after execution?** Because reconstruction requires interpreting raw execution data — and interpretation is where hallucination happens. The narrative generator writes sentences *at the moment of decision*, when the context is unambiguous. The decider *just* chose "reject" — that's a fact, not an inference. Recording it immediately eliminates the gap between what happened and what gets reported.

**Two narrative systems, complementary:**

```
memory/NarrativeRecorder     = DATA observation  → "wrote userName = 'Alice'"
engine/ControlFlowNarrative  = FLOW observation  → "chose Reject because riskScore > 0.5"
CombinedNarrativeBuilder     = MERGE both        → the full story
```

The data narrative (from `memory/scope/`) tells you what changed. The flow narrative (from this module) tells you what path was taken. Neither is complete alone. Together they answer *"What happened and why?"* — the question every trace consumer is asking.

```typescript
const narrative = new ControlFlowNarrativeGenerator();
// ... traverser executes with this narrative ...

narrative.getSentences();
// [
//   "The process began with Validate Input.",
//   "Next, it moved on to Risk Assessment.",
//   "A decision was made: DTI exceeds 43%, so the path taken was Reject.",
//   "Execution stopped at Send Rejection Letter."
// ]
```

**Key design decision:** The NullControlFlowNarrativeGenerator (Null Object pattern) means the traverser never checks `if (narrative)` — it always calls narrative methods. When narrative is disabled, the null implementation silently discards everything at zero cost. No conditionals in the hot path.

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
       |
  HandlerDeps (types.ts)
       |
  memory/ (SharedMemory, StageContext, EventLog)
  scope/ (ScopeFacade, protection, recorders)
```

External dependencies: none (inherits lodash from memory/).

---

## Test Coverage

Four test tiers, 103 tests across 13 suites:

| Tier | What it proves | Example |
|---|---|---|
| **unit/** | Individual module correctness | NodeResolver.findNodeById, ContinuationResolver iteration counting |
| **scenario/** | Multi-step workflow correctness | linear chain A→B→C, decider routing, fork fan-out, narrative capture |
| **property/** | Invariants hold for random inputs | maxIterations always enforced, per-node independence |
| **boundary/** | Edge cases and error paths | no-fn-no-children throws, decider-without-children throws |
