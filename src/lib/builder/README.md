# builder/

The flowchart construction library. Zero dependencies on any other footprint library.

---

## Why This Exists

FootPrint flowcharts are tools. They get exposed to LLMs via tool-use APIs. The LLM reads the tool description, decides which tool to call, and the engine executes the flowchart.

The problem is tool selection. Two tools named `getUserInfo` and `getUserDetails` are indistinguishable from their names. An LLM will guess, try both, or pick wrong. Short one-line descriptions don't carry enough signal. What the LLM actually needs is **what the tool does internally** — the full execution plan, stage by stage.

That's what this builder produces. When a developer builds a flowchart and describes each stage, the builder **accumulates those descriptions into a complete tool description** — a numbered execution plan that tells the LLM exactly what's inside. Not just the name. The full internal reasoning chain: what each stage does, where the graph branches, what each branch means.

```
getUserInfo:                              getUserDetails:
1. lookupByEmail — search by email        1. registerUser — create in DB if needed
2. fetchProfile — load from cache         2. getUser — fetch with relations
```

Now the LLM picks correctly on the first try. One is a safe read-only lookup. The other has side effects. The accumulated description *is* the differentiator.

**This is the builder's main job: produce self-describing flowcharts.** Everything else — the StageNode tree for the engine, the JSON spec for visualization, the stageMap for function lookup — serves that goal. The builder constructs all of these in tandem from a single fluent API, so they can never drift apart.

---

## The Three Primitives

Each one exists to serve the main goal: **define the shape of execution so that every decision path is known, traceable, and visualisable before a single stage runs.**

---

### 1. FlowChartBuilder — "The Blueprint"

The main class. Provides a fluent API for constructing the execution graph node by node.

**Why it connects to the main goal:** For traces to be connected, the engine must know the full graph shape before execution — which stages exist, what follows what, where branches are. The builder encodes this structure so the engine can traverse it deterministically. No runtime graph discovery, no dynamic assembly. The shape is fixed at build time. That's what makes the traces reproducible.

**Why a fluent builder, not a JSON config?** Three reasons:

1. **Type safety** — Each method returns a typed context. `addDeciderFunction()` returns a `DeciderList` that only allows branch-related methods. You can't accidentally call `addFunction()` inside a decider's branch list — the types won't let you.
2. **Dual structure** — The builder constructs the StageNode tree *and* the SerializedPipelineStructure simultaneously. A JSON config would need a separate compilation step, creating a gap where they could drift apart.
3. **stageMap registration** — Every function is registered in a Map<name, fn> as it's added. The engine looks up functions by name at runtime. If you forgot to register one, execution would fail silently. The builder makes this automatic.

```typescript
import { flowChart } from 'footprint/builder';

const chart = flowChart('validate', validateFn)
  .addFunction('process', processFn)
  .addFunction('respond', respondFn)
  .build();

// chart.root          → StageNode tree (runtime)
// chart.stageMap      → Map<name, fn> (lookup)
// chart.buildTimeStructure → SerializedPipelineStructure (JSON)
// chart.description   → "FlowChart: validate\nSteps:\n1. validate\n2. process\n3. respond"
```

**Key design decision:** The builder maintains a *cursor* — a pointer to the current node. Each `addFunction()` appends after the cursor and advances it. This makes linear chaining trivial (`A → B → C`) but also means branching requires helper classes that temporarily take over the cursor. When you call `addDeciderFunction()`, you enter a `DeciderList` context. When you call `.end()`, the cursor returns to the main builder. Same pattern as XML builders or SQL query builders.

---

### 2. DeciderList — "The If/Else"

Returned by `addDeciderFunction()`. Collects branches where the decider function's return value picks which branch to follow.

**Why it connects to the main goal:** Decisions are the most important thing to trace. When a user asks *"Why was my loan rejected?"*, the answer is a decider that chose the `'reject'` branch. For that trace to work, the engine needs to know *at build time* which branches exist, what their IDs are, and what function runs for each. DeciderList captures all of this so the engine can record *"decider 'riskAssessment' chose branch 'reject'"* with full context.

**Why a separate class?** The decider context is different from the linear chaining context. Inside a decider, you can only add branches (not chain stages). The type system enforces this — `DeciderList` exposes `addFunctionBranch()` and `end()`, not `addFunction()`. When you call `.end()`, validation runs (at least one branch required, no duplicate IDs), the spec is finalized, and control returns to the main builder.

```typescript
const chart = flowChart('input', inputFn)
  .addDeciderFunction('riskAssessment', riskFn)
    .addFunctionBranch('approve', 'Approve', approveFn)
    .addFunctionBranch('reject', 'Reject', rejectFn)
    .setDefault('approve')
  .end()
  .addFunction('output', outputFn)
  .build();
```

**Key design decision:** `setDefault()` doesn't add a `defaultBranchId` field. Instead it clones an existing branch with `id: 'default'`. This means the engine doesn't need special "default" logic — it just matches the ID `'default'` like any other branch. The branch's function and metadata are inherited from the cloned source.

---

### 3. SelectorFnList — "The Fan-Out"

Returned by `addSelectorFunction()`. Mirrors `addDeciderFunction()` exactly, except the function returns an **array** of branch IDs instead of a single one — enabling fan-out to multiple branches.

**Why it connects to the main goal:** When a stage needs to fan out — *"notify the user via email AND sms"* — the trace needs to record which branches were selected and why. SelectorFnList creates a proper node in the graph, with its own function registered in the stageMap, so the engine treats it as a stage: it runs the function, records the result in the trace, and then follows all selected branches.

**Why not a separate `addSelector` (no-node) variant?** For consistency. The old code had `addDecider` (no-node, deprecated) alongside `addDeciderFunction`. We removed `addDecider` to keep the API symmetric. The same logic applies here — every routing decision should be a real stage with a name, a function in the stageMap, and a line in the trace. No invisible routing.

**Decider vs Selector — think radio button vs checkbox:**
- `addDeciderFunction` = **radio button** → fn returns **one** branch ID → engine follows one path
- `addSelectorFunction` = **checkbox** → fn returns **array** of branch IDs → engine follows multiple paths

Same API shape, same structure, same trace output. Just single-select vs multi-select.

```typescript
const chart = flowChart('entry', entryFn)
  .addSelectorFunction('PickChannels', pickChannelsFn)
    .addFunctionBranch('email', 'SendEmail', emailFn)
    .addFunctionBranch('sms', 'SendSMS', smsFn)
  .end()
  .build();

// Creates new node: { name: 'PickChannels', selectorFn: true, children: [...] }
// Registered in stageMap: chart.stageMap.get('PickChannels') === pickChannelsFn
```

---

## How They Work Together

The full flow for building a flowchart:

```
1. flowChart('validate', fn) → creates FlowChartBuilder, calls start()
   → StageNode: { name: 'validate', fn }
   → Spec:      { name: 'validate', type: 'stage' }
   → stageMap:  { 'validate' → fn }
   → cursor:    points to 'validate'

2. .addFunction('process', fn)
   → creates node, links cursor.next → node, advances cursor
   → StageNode: validate.next = { name: 'process', fn }
   → Spec:      validate.next = { name: 'process', type: 'stage' }
   → stageMap:  { 'validate' → fn, 'process' → fn }

3. .addDeciderFunction('decide', deciderFn)
   → creates decider node, links cursor.next → node
   → returns DeciderList (cursor moves to builder, branching context begins)

4. .addFunctionBranch('approve', 'Approve', approveFn)
   → creates branch node, adds as child of decider node
   → StageNode: decide.children = [{ name: 'Approve', id: 'approve' }]
   → validates no duplicate branch IDs

5. .end()
   → validates at least 1 branch, sets deciderFn = true
   → Spec: decide.type = 'decider', decide.branchIds = ['approve', ...]
   → returns control to FlowChartBuilder, cursor = decider node

6. .build()
   → assembles FlowChart: { root, stageMap, buildTimeStructure, description }
   → description auto-generated from all _appendDescriptionLine calls
```

For subflow mounting:

```
Parent builder creates sub = flowChart('sub', fn).build()
     |
     main.addSubFlowChart('sf', sub, 'SubFlow')
     |
     +-→ Prefix all subflow node names: 'sub' → 'sf/sub'
     +-→ Merge subflow stageMap into parent: 'fn' → 'sf/fn'
     +-→ Record subflow definition in parent.subflows
     +-→ Mount as parallel child: main.children = [{ name: 'SubFlow', subflowId: 'sf' }]
     |
     Nesting works recursively: inner subflow → 'outer/inner/node'
```

---

## Why Description Is the Most Important Feature

Every `addFunction()`, `addDeciderFunction()`, and `addSelectorFunction()` call accepts an optional `description` parameter. The builder accumulates these into a single `chart.description` string — a numbered, human-readable execution plan.

This sounds like a nice-to-have. It's not. **It's the thing that makes LLM tool selection work.**

### The Problem

Consider two flowcharts exposed as tools to an LLM:

- `getUserInfo`
- `getUserDetails`

From the names alone, an LLM can't tell them apart. It will try both. It will guess wrong. It will waste tokens. This is the fundamental tool selection problem — tool names are ambiguous, and short one-line descriptions don't give enough signal.

### The Solution

When developers write descriptions for each stage, the builder accumulates them automatically:

```typescript
const getUserInfo = flowChart('lookupByEmail', lookupFn, undefined, undefined, undefined, 'search user table by email')
  .addFunction('fetchProfile', fetchFn, undefined, undefined, 'load profile from cache')
  .build();

// getUserInfo.description =
// "FlowChart: lookupByEmail
// Steps:
// 1. lookupByEmail — search user table by email
// 2. fetchProfile — load profile from cache"

const getUserDetails = flowChart('registerUser', registerFn, undefined, undefined, undefined, 'create user in DB if not exists')
  .addFunction('getUser', getFn, undefined, undefined, 'fetch full user record with relations')
  .build();

// getUserDetails.description =
// "FlowChart: registerUser
// Steps:
// 1. registerUser — create user in DB if not exists
// 2. getUser — fetch full user record with relations"
```

Now the LLM sees *exactly* what each tool does internally. It knows `getUserInfo` does a lookup + cache read (safe, read-only), while `getUserDetails` creates a user + fetches with relations (has side effects). It picks correctly on the first try.

### Why This Matters for Footprint Specifically

Footprint's whole point is that flowcharts are tools — they get exposed to LLMs via tool-use APIs. The `chart.description` becomes the tool description. The better the description, the better the LLM's tool selection accuracy.

This is a compounding effect:
1. Developer writes a description for each stage (one line each)
2. Builder accumulates them into a full execution plan
3. Decider branches get listed: *"Decides between: approve, reject"*
4. Selector branches get listed: *"Selects from: email, sms, push"*
5. Subflow descriptions get nested and indented
6. Loop targets get noted: *"→ loops back to step 3"*

The result is a complete, structured tool description that gives the LLM enough signal to choose the right tool — not just the name, but the full internal reasoning chain. This is what raises tool selection accuracy from guesswork to precision.

### Per-Stage Descriptions

Stage descriptions are also stored individually in `chart.stageDescriptions` (Map<name, description>). This powers per-stage narrative generation — when the engine runs a stage, it can look up the developer's description and include it in the execution trace. The LLM reading the trace sees not just *what* happened, but *why* the developer intended it.

---

## Design Decisions — Each Traced Back to the Main Goal

| Decision | Why | How it serves the goal |
|---|---|---|
| Dual structure (StageNode + Spec) built in tandem | Runtime graph and visualization spec can never drift apart | Traces match the visualized structure exactly |
| Cursor-based chaining | Linear flows read left-to-right, just like the execution order | Graph shape mirrors how you think about the flow |
| Helper classes for branching (DeciderList, SelectorFnList) | Type system enforces valid branch structure | Can't build a broken graph — compile-time safety |
| stageMap auto-registration | Every function registered as it's added | Engine never encounters a stage with no function — silent failures impossible |
| stageMap collision detection | Same name + different fn reference = build error | Prevents subtle bugs where two different functions fight for the same stage name |
| `build()` produces immutable output | FlowChart is a snapshot, not a live builder | Engine can safely traverse without worrying about concurrent modification |
| `toSpec()` excludes functions | Spec is JSON-safe — no closures, no fn references | Can be serialized, stored in a database, sent over the wire |
| Subflow prefix namespacing (`sf/name`) | Mounted subflow names can't collide with parent names | Nested subflows produce clean, unique stage names in the trace |
| `setDefault()` clones instead of adding a flag | Engine treats default like any other branch ID | No special-case logic in the engine — simpler traversal, fewer bugs |
| No `addSelector` (no-node variant) | Mirrors removal of `addDecider` — all routing creates a node | Every decision is a real stage in the trace — no invisible routing |
| `execute()` intentionally omitted | Belongs in the runner layer (Phase 5), not the builder | Builder has zero execution dependencies — can be used for visualization-only tooling |
| Description auto-generated from stage descriptions | Every stage's description accumulates into a full execution plan | Becomes the LLM tool description — makes tool selection accurate, not guesswork |

---

## Dependency Graph

```
This library has ZERO dependencies on other footprint libraries.

  FlowChartBuilder
  /       |       \
    DeciderList    SelectorFnList
  \       |       /
       types
  (StageNode, SerializedPipelineStructure, FlowChart, etc.)
```

External dependencies: none.

---

## Test Coverage

Four test tiers, 97 tests across 11 suites:

| Tier | What it proves | Example |
|---|---|---|
| **unit/** | Individual method correctness | FlowChartBuilder.start() sets root and cursor |
| **scenario/** | Multi-step workflow correctness | linear chain → fork-join → decider branching → subflow mounting |
| **property/** | Invariants hold for random inputs (fast-check) | every node has a name, stageMap size = unique stage count |
| **boundary/** | Edge cases and extremes | 200-stage chain, 100 parallel children, 50-branch decider |

### Tested Capacity (Boundary Results)

These are tested and passing — not theoretical limits, but what the test suite proves works:

| What | Tested at | Detail |
|---|---|---|
| Linear chain length | **200** | 200 stages linked via next pointers, all reachable from root ✓ |
| Parallel children | **100** | 100 children under a single fork node ✓ |
| Decider branches | **50** | 50 branches under a single decider ✓ |
| Mounted subflows | **10** | 10 subflows mounted on a single parent ✓ |
| Spec serialization | **50** | 50-stage chain spec traversal matches node chain ✓ |
| Tree validity | **random inputs × 50 runs** | Property test: every node has a non-empty name ✓ |
| StageMap consistency | **random inputs × 50 runs** | Property test: stageMap.size equals unique stage count ✓ |
| Name collision detection | **random inputs × 30 runs** | Property test: duplicate name + different fn always throws ✓ |
