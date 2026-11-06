# RFC-003 — Contextual Bug Localization (weighted slicing for stochastic stages)

*Two-part design: Part A fixes the verified gaps in footprintjs backtracking; Part B builds the
LLM contextual-bug localizer on top (agentfootprint). Companion to RFC-002 (shares the influence-
scoring core) and the FDL paper (counterfactual exclude/re-run, applied to slice suspects).
Status: proposed. June 2026.*

**One-line claim:** make the causal DAG complete enough to trust (control edges + honesty markers),
then make it useful at LLM stages (semantic edge weights), then make it conclusive (counterfactual
bisection). `git bisect` for context.

---

## Part A — Fix the backtracking gaps (footprintjs)

Verified state of `memory/backtrack.ts`: BFS over read→write edges, properly transitive,
DAG-deduped, staged O(log N) writer lookup. Four gaps, four fixes — all additive.

### A1 · Control-dependence edges (the missing edge kind)

**Gap:** a decider reads `creditScore`, routes to a branch; the branch writes `status` reading
nothing. Backtrack from `status` → no parents. The variable that chose *which code ran* is
invisible — data edges only.

**Fix:**
1. **Engine (additive):** `TraversalContext.parentRuntimeStageId?: string` — the parent context's
   runtimeStageId (available as `context.parent?.runtimeStageId` at TraversalContext creation,
   FlowchartTraverser.ts:515–524). Loop re-entries stay unambiguous (runtime ids, not stage ids).
2. **`controlDepRecorder()`** (footprintjs/trace, FlowRecorder): on `onDecision`/`onSelected`,
   record `{ deciderRuntimeStageId, chosen, evidence?, ruleLabel? }`; map every subsequently
   executed stage whose ancestor chain (via parentRuntimeStageId) passes through the chosen branch
   → `controlParent = deciderRuntimeStageId`. Exposes `ControlDepLookup: (runtimeStageId) =>
   { deciderId, label? } | undefined`.
3. **`causalChain` option:** `{ controlDeps?: ControlDepLookup }`. When expanding node N, also add
   a parent edge to its governing decider with `kind: 'control'`, labeled by the decide() rule
   label when present ("Good credit"). The decider node then expands normally through its own
   data reads — so `status ← [control] ClassifyRisk ← [data: creditScore] PullBureau` chains
   end-to-end.

### A2 · Honesty markers for untracked reads

**Gap:** reads via `$getArgs()`/`$getEnv()` (untracked by design), `getValueSilent`/
`getValueDirect` (StageContext.ts:219–225), or closures produce no edge. The DAG cannot show the
edges it's missing — worst failure mode for an evidence tool.

**Fix (additive):** ScopeFacade sets per-stage flags when args/env/silent paths are used; surface
as `CommitBundle.untrackedSources?: ReadonlyArray<'args' | 'env' | 'silent'>`; backtracker stamps
`CausalNode.incompleteSources` from it; `formatCausalChain` prints `⚠ also consumed args/env —
slice may be incomplete here`. Cost: three booleans per stage. (Closure smuggling stays
undetectable — documented as the residual limit; the anti-pattern docs already forbid it.)

### A3 · Weighted edges — the hook for Part B

**Gap:** an LLM stage that read 12 keys gets 12 unweighted parents. Structurally true,
diagnostically useless (the hairball).

**Fix (additive, engine stays zero-dep):**
```ts
interface CausalEdge { parent: CausalNode; kind: 'data' | 'control'; key?: string; weight: number; }
// CausalNode.parents kept for compat; new CausalNode.parentEdges: CausalEdge[]
type EdgeWeigher = (child: CausalNode, parent: CausalNode, key: string | undefined,
                    kind: 'data' | 'control') => number | undefined;  // undefined → 1.0
causalChain(log, id, keysRead, { controlDeps, weigh?: EdgeWeigher });
```
The engine never computes weights itself — no embeddings, no new deps. Deterministic stages keep
weight 1.0; the weigher is where agentfootprint injects semantics (Part B). Edge weights render in
`formatCausalChain` as `← via systemPrompt (0.18)`.

### A4 · Truncation visibility
Root gains `truncated?: { byDepth: boolean; byNodes: boolean }`; dev-mode warns. Net-change
commit semantics (write-then-revert invisible at commit level) documented at the `causalChain`
JSDoc with a pointer to op-level events for the rare consumer that needs them.

---

## Part B — The localizer (agentfootprint, `/observe`)

### B1 · Pipeline

```ts
const report = await localizeContextBug({
  snapshot, recorders,                    // commitLog + keysRead + control deps + llm-call ids
  embedder,                               // injected — mock in tests (RFC-002 shared core)
  atStep?: runtimeStageId,                // explicit, or:
  trigger?: 'quality',                    // qualityTrace() lowest-scoring step
  rerun?: AblationRunner,                 // enables stage 4 (else report stops at ranking)
});
```

1. **Trigger.** Explicit step, or `qualityTrace` (already shipped) finds where quality dropped.
2. **Structural slice.** `causalChain` with A1 control deps + A2 honesty markers — the *provable*
   candidate set: every input that fed the step, every decision that routed to it.
3. **Semantic weighting.** For nodes that are LLM calls (ids from `stream.llm_start`), the weigher
   scores each parent edge: FDL composite of the parent's written content vs the child's output
   (same four signals, same embedder, same cache as RFC-002 — **one shared `influence-core`
   module serves the paper pipeline, RFC-002, and this**). The 40-edge hairball becomes a ranked
   shortlist; constraining scoring to provably-fed inputs kills the spurious-similarity failure
   mode the paper's §8.4 worries about.
4. **Counterfactual bisection (ground truth).** For top suspects, re-run with the suspect ablated —
   adapters per source kind: tool (`ignoredTools`, the paper's mechanism), injection/fact/skill
   (exclude the injection id), memory (filter the entry), arg (callers supply an override).
   Compare outputs across N seeded reruns (mean similarity ± spread — variance reported, unlike
   the paper's single runs). Multi-culprit: binary search over the ranked set.
5. **Report.** `{ step, suspects: [{ source, kind, score, edgePath, verdict, runs }],
   sliceStats, honestyFlags }` — every suspect carries its full evidence path back through the
   DAG, control edges labeled by rule.

### B2 · Honest claims (the discipline, again)
Edge weights at LLM stages are correlational (proxy); slice completeness is bounded by tracking
(and now *says so* via A2 markers); bisection verdicts are the only causal statements in the
report. Falsifiable validation: across planted-bug scenarios, ablating the top-ranked suspect
flips the outcome significantly more often than ablating the bottom-ranked — the paper's Table-3
shape, done with variance.

### B3 · Lens panel (U-tier)
Weighted DAG: edge thickness = weight, control edges dashed with rule labels, ⚠ badges on
incomplete nodes, click-suspect → "ablate & re-run" button — the FDL exclude/re-run interaction,
one level deeper.

---

## Build plan — small blocks, each testable alone

| # | Block | Repo | Deliverable | Acceptance test | Effort |
|---|---|---|---|---|---|
| D1 | `parentRuntimeStageId` on TraversalContext | F | additive field | golden event test incl. loop re-entry uniqueness | S |
| D2 | Untracked-read flags | F | facade flags → `CommitBundle.untrackedSources` | property: args/env/silent reads always flagged; tracked-only stages never | S |
| D3 | `CausalEdge` + `controlDeps` in backtrack.ts | F | control edges + compat-preserved `parents` | the credit fixture: `status ← control ClassifyRisk ← data creditScore`; existing backtrack suite green | M |
| D4 | `weigh` hook + truncation flags | F | EdgeWeigher plumbed, default 1.0 | unit: weights attached; truncated flag set at caps | S |
| D5 | `controlDepRecorder()` | F | FlowRecorder + lookup | decider/selector/nested-subflow fixtures; runId reset | M |
| D6 | `influence-core` extraction | A | shared scoring module (signals + cache) used by RFC-002 + B3 | parity test vs paper pipeline outputs | S/M |
| D7 | LLM-edge weigher | A | weigher binding llm_start ids + embedder | hairball fixture → ranked shortlist, deterministic across runs | M |
| D8 | `localizeContextBug` + ablation adapters | A | orchestrator + tool/injection/memory ablators | scripted-mock e2e: planted misleading fact found and confirmed | M |
| D9 | Bisection harness + report + variance | A | N-seeded reruns, multi-culprit search | two planted culprits both isolated; report carries spread | M |
| D10 | Lens weighted-DAG panel | UI | thickness/dashed/⚠/ablate-button | U-tier, after D8 | M |

Sequencing: D1–D5 ship as one footprintjs minor (pure additive; lands cleanly before or after
RFC-001's R2 — different region). D6 first on the agentfootprint side (it also de-dupes RFC-002).
Examples per Convention 2: `examples/observability/context-bisect/` 01-planted-fact ·
02-control-edge-credit · 03-bisect-two-culprits.

## Dependencies & relations
- Uses RFC-002's scoring core (D6 extracts it once for both).
- Pairs with RFC-001: embedding work in the weigher is async I/O — deferred-tier friendly.
- Causal memory (#5) extends bisection cross-run ("this context bug bit us last Tuesday").
- The follow-up paper: Part B + B2's validation = the rigorous successor to the FDL paper's
  counterfactual section; related work adds ContextCite + program slicing (Weiser '84, thin
  slicing) — a pairing no one else has published on agent traces.
