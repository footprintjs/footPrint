<p align="center">
  <h1 align="center">FootPrint</h1>
  <p align="center">
    <strong>The flowchart pattern for backend code &mdash; self-explainable systems that AI can reason about.</strong>
  </p>
</p>

<p align="center">
  <a href="https://github.com/footprintjs/footPrint/actions"><img src="https://github.com/footprintjs/footPrint/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <!-- coverage-badge --><img src="https://img.shields.io/badge/coverage-93%25-brightgreen.svg" alt="coverage: 93%"><!-- /coverage-badge -->
  <a href="https://www.npmjs.com/package/footprintjs"><img src="https://img.shields.io/npm/v/footprintjs.svg?style=flat" alt="npm version"></a>
  <a href="https://bundlephobia.com/package/footprintjs"><img src="https://img.shields.io/bundlephobia/minzip/footprintjs?label=minzipped" alt="minzipped size"></a>
  <a href="#tree-shakeable--esm-first"><img src="https://img.shields.io/badge/tree--shakeable-%E2%9C%93-success?style=flat" alt="tree-shakeable"></a>
  <a href="https://github.com/footprintjs/footPrint/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/footprintjs"><img src="https://img.shields.io/npm/dm/footprintjs.svg" alt="Downloads"></a>
  <a href="https://footprintjs.github.io/footprint-playground/samples/llm-agent-tool"><img src="https://img.shields.io/badge/Try_with_LLM-Live_Demo-7c6cf0?style=flat" alt="Try with LLM"></a>
  <a href="https://footprintjs.github.io/footprint-playground/"><img src="https://img.shields.io/badge/Playground-37%2B_samples-6366f1?style=flat" alt="Interactive Playground"></a>
  <a href="https://footprintjs.github.io/footPrint/"><img src="https://img.shields.io/badge/Docs-footprintjs-3178c6?style=flat&logo=typescript&logoColor=white" alt="Docs"></a>
</p>

<br>

<p align="center">
  <img src="assets/hero.gif" alt="FootPrint demo — loan application with animated flowchart, memory inspector, and causal trace" width="800">
</p>

**MVC is a pattern for backends. FootPrint is a different pattern** &mdash; the flowchart pattern &mdash; where your business logic is a graph of functions with transactional state. The code becomes self-explainable: AI reads the structure, traces every decision, and explains what happened &mdash; no hallucination.

```bash
npm install footprintjs
```

---

## The Problem

Your LLM needs to explain why your code made a decision. Without structure, it reconstructs reasoning from scattered logs &mdash; expensive, slow, and hallucinates.

| | MVC / Traditional | Flowchart Pattern (FootPrint) |
|---|---|---|
| **LLM explains a decision** | Reconstruct from scattered logs | Read the causal trace directly |
| **Tool descriptions for agents** | Write and maintain by hand | Auto-generated from the graph |
| **State management** | Global/manual, race-prone | Transactional scope with per-stage staged commits |
| **Debugging** | `console.log` + guesswork | Time-travel replay to any stage |

---

## How It Works

A loan pipeline rejects Bob. The user asks: **"Why was I rejected?"**

The runtime auto-generates this trace from what the code actually did:

```
Stage 1: The process began with ReceiveApplication.
  Step 1: Write creditScore = 580, dti = 0.6, employmentStatus = "self-employed"
Stage 2: Next step: Evaluate risk tier from all flags.
  Step 1: Read creditScore = 580
  Step 2: Write riskTier = "high"
  Step 3: Write riskFactors = (3 items)
Stage 3: Next step: Route based on risk tier.
  Step 1: Read riskTier = "high"
[Condition]: It evaluated "High risk": riskTier "high" eq "high" ✓, and chose RejectApplication.
Stage 4: Next step: Generate rejection.
  Step 1: Write decision = "REJECTED — below-average credit; DTI exceeds 43%; Self-employed < 2yr"
```

The LLM backtracks: `riskTier="high"` &larr; `dtiStatus="excessive"` &larr; `dtiRatio=0.6` &larr; `app.monthlyDebts=2100`. Every variable links to its cause:

> **LLM:** "Your application was rejected because your debt-to-income ratio of 60% exceeds the 43% maximum, your credit score of 580 falls in the 'fair' tier, and your self-employment tenure of 1 year is below the 2-year minimum."

That answer came from the trace &mdash; not from the LLM's imagination.

---

## Quick Start

```typescript
import { flowChart, decide, narrative } from 'footprintjs';

// 1. Define your state
interface State {
  user: { name: string; tier: string };
  discount: number;
  lane: string;
}

// 2. Build the flowchart
const chart = flowChart<State>('FetchUser', async (scope) => {
    scope.user = { name: 'Alice', tier: 'premium' };
  }, 'fetch-user')
  .addFunction('ApplyDiscount', async (scope) => {
    scope.discount = scope.user.tier === 'premium' ? 0.2 : 0.05;
  }, 'apply-discount')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { discount: { gt: 0.1 } }, then: 'vip', label: 'High discount' },
    ], 'standard');
  }, 'route', 'Route by discount tier')
    .addFunctionBranch('vip', 'VIPCheckout', async (scope) => {
      scope.lane = 'VIP express';
    })
    .addFunctionBranch('standard', 'StandardCheckout', async (scope) => {
      scope.lane = 'Standard';
    })
    .setDefault('standard')
    .end()
  .build();

// 3. Run — state + self-generated trace included
const result = await chart.recorder(narrative()).run();

console.log(result.state.lane);     // "VIP express"
console.log(result.narrative);
// [
//   "Stage 1: The process began with FetchUser.",
//   "  Step 1: Write user = {name, tier}",
//   "Stage 2: Next, it moved on to ApplyDiscount.",
//   "  Step 1: Read user = {name, tier}",
//   "  Step 2: Write discount = 0.2",
//   "Stage 3: Next step: Route by discount tier.",
//   "  Step 1: Read discount = 0.2",
//   "[Condition]: It evaluated Rule 0 \"High discount\": discount 0.2 gt 0.1 ✓, and chose VIPCheckout.",
//   "Stage 4: Next, it moved on to VIPCheckout.",
//   "  Step 1: Write lane = \"VIP express\"",
// ]
```

> **[Try it in the browser](https://footprintjs.github.io/footprint-playground/)** &mdash; no install needed
>
> **[Browse 37+ examples](https://footprintjs.github.io/footprint-playground/)** &mdash; patterns, recorders, subflows, integrations, and a full loan underwriting demo

---

## Try With Your LLM

Expose any flowchart as an MCP tool in one line &mdash; the description, input schema, and step list are auto-generated from the graph.

```typescript
const tool = chart.toMCPTool();
// { name: 'assesscredit', description: '1. AssessCredit\n2. ...', inputSchema: { ... } }

// Register with any MCP server or pass directly to the Anthropic SDK:
const anthropicTool = { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
```

The LLM calls the tool, gets back the decision and causal trace, and explains the result to the user &mdash; all from the same graph that runs in production.

> **[Live demo: Claude calls a credit-decision flowchart as an MCP tool](https://footprintjs.github.io/footprint-playground/samples/llm-agent-tool)** &mdash; enter your API key, watch the tool call happen, see the trace.

---

## Features

| Feature | Description |
|---------|-------------|
| **Causal Traces** | Every read/write captured &mdash; LLMs backtrack through variables to find causes |
| **Decision Evidence** | `decide()` / `select()` auto-capture WHY a branch was chosen &mdash; operators, thresholds, pass/fail |
| **TypedScope&lt;T&gt;** | Typed property access &mdash; `scope.creditScore = 750` instead of `scope.setValue('creditScore', 750)` |
| **Auto Narrative** | Build-time descriptions for tool selection, runtime traces for explanation |
| **7 Patterns** | Linear, parallel fork, conditional, multi-select, subflow, streaming, loops |
| **Transactional State** | Per-stage staged commits, safe merges, time-travel replay |
| **PII Redaction** | Per-key or declarative `RedactionPolicy` with audit trail |
| **Flow Recorders** | 8 narrative strategies for loop compression |
| **Combined Recorders** | Single-hook observers that span data-flow + control-flow &mdash; `executor.attachCombinedRecorder(r)` |
| **Deferred observers** *(new in 9.6)* | `attach*Recorder(rec, { delivery: 'deferred' })` &mdash; observers run "one beat behind" on a bounded queue instead of inside the engine hot path. Honest backpressure (`drop-oldest`/`sample`/`block`), terminal flush at run resolve/reject/pause, `snapshot.observerStats`. [Guide →](./docs/guides/observers-deferred.md) |
| **Contracts** | I/O schemas (Zod/JSON Schema) + OpenAPI 3.1 + MCP tool generation |
| **Cancellation** | AbortSignal, timeout, early termination via `scope.$break(reason?)` with optional reason |
| **Subflow break propagation** | Mount a subflow with `propagateBreak: true` &mdash; inner `$break` terminates the parent loop, with drill-down preserved |
| **Emit channel** | `scope.$emit(name, payload)` &mdash; user-authored structured events to `EmitRecorder`, pass-through, zero-allocation when no recorder attached, redactable via `emitPatterns` |
| **Detach** *(new in 4.17)* | `scope.$detachAndForget(driver, child, input)` and `scope.$detachAndJoinLater(driver, child, input)` &mdash; fire-and-forget child flowcharts via the `footprintjs/detach` subpath. Six built-in drivers (microtask / immediate / setImmediate / setTimeout / sendBeacon / workerThread) + custom-driver protocol. Builder-native composition (`addDetachAndForget` / `addDetachAndJoinLater`) makes detach a labeled chart stage. `flushAllDetached()` for graceful shutdown. [Guide →](https://footprintjs.github.io/footPrint/guides/patterns/detach/) |
| **Recorder storage primitives** | `BoundaryStateStore<TState>` &mdash; one of three composable storage shelves alongside `SequenceStore<T>` (durable ordered, with `getEntryRanges()`) and `KeyedStore<T>` (durable 1:1). `BoundaryStateStore` tracks live transient state DURING a `[start, stop]` event interval (LLM stream partial, tool args streaming, agent turn state) and clears on stop. O(1) reads via `get` / `hasActive` / `activeCount`. Mental model: recorder *interfaces* (`ScopeRecorder` / `FlowRecorder` / `EmitRecorder`) are observers; stores are *bookkeeping shelves*. A real recorder picks ONE observer interface and OWNS the store as a field (composition &mdash; "one purpose per recorder"). The `Store` classes are exported from `footprintjs/trace` and are the only recorder-storage model &mdash; there are no abstract base classes to extend. [Guide →](https://footprintjs.github.io/footPrint/guides/features/recorder-storage-primitives/) |

---

## Tree-shakeable & ESM-first

Import one thing, ship one thing. footprintjs is built so your bundle grows only with what you actually use:

- **Dual build, true ESM.** Ships CommonJS (`require`) **and** real ECMAScript Modules (`import`) with TypeScript types. The ESM build is marked `type:module` and every internal import carries an explicit `.js` extension, so it loads as true ESM under Node, Vite, Next, Deno, and Bun — no compatibility shims.
- **Per-file modules + `sideEffects:false`.** The dist is emitted file-by-file (never pre-bundled) and declares zero side effects, so bundlers can drop every export you don't touch.
- **Subpath exports.** Pull execution tracing from `footprintjs/trace`, fire-and-forget children from `footprintjs/detach`, engine internals from `footprintjs/advanced` — each is independently tree-shakeable.

**Proven, not promised.** A CI smoke test bundles a minimal `import { flowChart } from 'footprintjs'` and asserts the recorder, detach, and trace layers are pruned — your flowchart core doesn't drag them in. See [`test/esm-packaging.test.ts`](test/esm-packaging.test.ts).

```ts
// Only flowChart? The recorder/detach/trace layers are tree-shaken away.
import { flowChart } from 'footprintjs';
```

---

## Dev Mode

footprintjs ships with developer-only diagnostics that are OFF in production (zero overhead). Turn them on during development to catch mistakes early:

```ts
import { enableDevMode } from 'footprintjs';

if (process.env.NODE_ENV !== 'production') {
  enableDevMode();
}
```

One flag gates every library dev-only check:

| Check | What it warns about |
|---|---|
| Circular refs | `scope.setValue(...)` called with an object that references itself |
| Empty recorders | `attachCombinedRecorder(r)` with `r` that has no `on*` handler (likely mistake) |
| Suspicious predicates | `decide()` / `select()` rules with shapes that probably won't match |
| Snapshot integrity | `getSubtreeSnapshot()` asked for a path that doesn't exist |

All dev warnings are `console.warn`. Use `disableDevMode()` to silence them at runtime.

---

## AI Coding Tool Support

FootPrint ships with built-in instructions for every major AI coding assistant. Your AI tool understands the API, patterns, and anti-patterns out of the box.

```bash
# Download and run the setup script from GitHub
npx degit footprintjs/footPrint/ai-instructions footprint-ai && bash footprint-ai/setup.sh && rm -rf footprint-ai
```

| Tool | What gets installed |
|------|-------------------|
| **Claude Code** | `.claude/skills/footprint/SKILL.md` + `CLAUDE.md` |
| **OpenAI Codex** | `AGENTS.md` |
| **GitHub Copilot** | `.github/copilot-instructions.md` |
| **Cursor** | `.cursor/rules/footprint.md` |
| **Windsurf** | `.windsurfrules` |
| **Cline** | `.clinerules` |
| **Kiro** | `.kiro/rules/footprint.md` |

---

## Roadmap — community extension points

These are deliberately deferred ideas where footprintjs aims to be a *true
developer's friend*: ship a great zero-config default, but let teams who need it
**bring their own** implementation. Contributions welcome — open an issue to
discuss before a PR.

- **Pluggable performance primitives (bring-your-own).** Hot-path internals
  (`deepEqual` for change-only commits, `deepSmartMerge`, deep clones) are
  built-in today. A future opt-in would let extreme-throughput consumers inject
  their own (e.g. a SIMD fast-deep-equal or structural-sharing clone) while
  everyone else keeps the default. Must honour the existing structural-equality
  contract (a wrong comparator could drop real changes), so it ships with a
  documented contract + dev-mode validation. See
  [Commit change semantics](./docs/design/commit-change-semantics.md).

## FAQ

**Are recorders blocking? Do observers slow my chart down?**
Inline (default) recorders run synchronously inside the producing statement.
If an observer is heavy, opt it into the deferred tier:
`executor.attachScopeRecorder(rec, { delivery: 'deferred' })` — events are
captured into one bounded, totally-ordered queue and delivered at the next
microtask checkpoint ("one beat behind"), fully drained before `run()`
returns. Same record, same order; the engine stops paying for observation.
Full model + FAQ: [Deferred observers guide](./docs/guides/observers-deferred.md).

---

## Documentation

| Resource | Link |
|----------|------|
| **Getting Started** | [Quick Start](https://footprintjs.github.io/footPrint/getting-started/quick-start/) &middot; [Key Concepts](https://footprintjs.github.io/footPrint/getting-started/key-concepts/) &middot; [Why footprintjs?](https://footprintjs.github.io/footPrint/getting-started/why/) |
| **Guides** | [Building](https://footprintjs.github.io/footPrint/guides/building/) &middot; [Decision branching](https://footprintjs.github.io/footPrint/guides/decision-branching/) &middot; [Recorders](https://footprintjs.github.io/footPrint/guides/recording/) &middot; [Subflows](https://footprintjs.github.io/footPrint/guides/subflows/) &middot; [Self-describing APIs](https://footprintjs.github.io/footPrint/guides/self-describing/) &middot; [Execution model & limits](./docs/guides/execution-model.md) |
| **API Reference** | [flowChart() / Builder](https://footprintjs.github.io/footPrint/api/flowchart/) &middot; [decide() / select()](https://footprintjs.github.io/footPrint/api/decide/) &middot; [FlowChartExecutor](https://footprintjs.github.io/footPrint/api/executor/) &middot; [Recorders](https://footprintjs.github.io/footPrint/api/recorders/) &middot; [Contract & Self-describing](https://footprintjs.github.io/footPrint/api/contract/) |
| **Try it** | [Interactive Playground](https://footprintjs.github.io/footprint-playground/) &middot; [Try with your LLM](https://footprintjs.github.io/footprint-playground/try-with-ai) &middot; [Live Demo](https://footprintjs.github.io/footprint-demo/) |

---

[MIT](./LICENSE) &copy; [Sanjay Krishna Anbalagan](https://github.com/sanjay1909)
