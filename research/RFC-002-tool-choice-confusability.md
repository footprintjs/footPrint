# RFC-002 — Tool-Choice Confusability: Catalog Lint + Margin Recorder

*Design doc for tiers 1–2 (tier 3 specified as validation, built later). Companion to RFC-001
(delivery substrate) and the FDL paper (the influence-scoring machinery, repurposed one level up:
from "which outputs shaped the answer" to "which descriptions shaped the choice").
Home: agentfootprint (`/observe`). Status: proposed. June 2026.*

---

## 1. Problem

When an LLM faces N tools, the tool *descriptions are the router* — and today they are debugged by
vibes. Failure mode: two descriptions embed too close ("get_fcns_database" vs
"influx_get_fcns_database"), the model picks inconsistently, runs go wrong intermittently, and no
artifact explains why. The deterministic-router version of this bug class just bit Neo four times
(`check:routing` now pins it); the LLM-routed version has no equivalent check anywhere in the
industry.

The data needed already exists in the stack: `stream.llm_start.tools` records the exact catalog
offered per call; the chosen call is on the same event stream; embedders are already an injected
adapter (`mockEmbedder()` / production embedders).

**The loop this RFC ships:** lint flags a confusable pair (build time, free) → developer edits the
description → lint passes instantly → margin recorder confirms the choice got decisive in real
runs → tier 3 (later) validates on the actual model via choice-entropy sampling.

## 2. Honest claim (FDL discipline carried over)

Tier 1–2 scores are **proxies** for the model's selection function — embedding geometry, not model
internals. They are framed as *confusability heuristics + margin evidence*, never "the model chose
because." Tier 3 exists precisely to validate the proxy: low-margin choices should show high
sampling entropy, and description edits should collapse it. If that correlation fails in practice,
the proxy is demoted, loudly.

## 3. Tier 1 — Build-time catalog lint (`analyzeToolCatalog`)

```ts
import { analyzeToolCatalog } from 'agentfootprint/observe';

const report = await analyzeToolCatalog(tools, {
  embedder,                  // injected — mockEmbedder() in tests, real in CI
  confusabilityThreshold: 0.85,
});
// report.pairs:    [{ a, b, similarity, verdict: 'confusable'|'watch', hint }]
// report.structural: [{ tool, rule, message }]   // see rules below
// report.ok:       boolean (gates CI)
```

- **Confusability check:** pairwise cosine similarity over descriptions; pairs ≥ threshold are
  `confusable` (fail), within 0.05 below = `watch` (warn). Hint suggests the differentiating axis
  ("both say 'FC name server registrations' — one is time-series, one is live; lead with that").
- **Structural rules** (free to bundle, sourced from the Neo review findings): missing/short
  description (< 40 chars); description says *what* but not *when* (no temporal/conditional cue —
  heuristic: no "for/when/after/first/fallback"); enum-able string params described in prose
  (`'avg_iops | peak_iops | mbps'` in a description ⇒ suggest JSON-Schema `enum`); optional params
  whose omission has meaning but no description saying so.
- **CI shape:** `npx agentfootprint-lint-tools` (or consumer script) exits non-zero on `!report.ok`
  — the LLM-router twin of Neo's `check:routing`.
- Embedding cost: N descriptions, cached by content hash; a 30-tool catalog = 30 embeddings, once.

## 4. Tier 2 — Runtime margin recorder (`toolChoiceRecorder`)

```ts
import { toolChoiceRecorder } from 'agentfootprint/observe';

const choice = toolChoiceRecorder({ embedder });   // CombinedRecorder
agent.recorder(choice);

choice.getCalls();          // per runtimeStageId:
// { offered: [{ name, score }], chosen: ['influx_get_fcns_database'],
//   margin: 0.02, flagged: true }
choice.getFlagged();        // calls where margin < marginThreshold (default 0.05)
```

- **Inputs per LLM call:** the offered catalog (`stream.llm_start.tools`), the chosen tool(s)
  (`stream.tool_start` / `llm_end.toolCalls`), and the choice context (user message + latest
  reasoning text — same slots the model saw).
- **Scoring:** similarity of choice-context embedding to each offered description → ranked
  competition; `margin` = score(chosen) − score(best non-chosen). Small margin = fragile choice;
  chosen ≠ top-scored = proxy disagreement (always flagged — it's either a proxy miss or a
  genuinely surprising model choice; both are exactly what a debugger wants surfaced).
- **Composition (Convention 1):** owns a `KeyedStore<ToolChoiceEntry>` keyed by `runtimeStageId`;
  implements the emit/flow hooks it needs; nothing else.
- **Delivery:** declared `delivery: 'deferred'` once RFC-001 lands (embedding calls are async I/O —
  the poster child for the deferred tier); until then it buffers events inline (µs) and embeds
  lazily on first read, keeping embedding latency off the hot path either way.
- **UI (U-item, later):** Lens "Tool choice" panel — per-iteration bar chart, chosen tool
  highlighted, margin badge, flagged calls in the run summary.

## 5. Tier 3 — Validation (specified now, built later)

- **Choice-entropy sampling:** replay a flagged call K times at temperature; the empirical
  distribution over chosen tools is ground-truth confusion. Report entropy alongside the tier-2
  margin.
- **Description A/B:** edit one description, replay, compare entropy/choice — exclude-and-re-run
  applied to prompt surfaces. This is the experiment that converts "confusable per the proxy" into
  "confusable in fact," and the validation study for the follow-up paper.
- **Proxy health metric:** correlation between tier-2 margin and tier-3 entropy across flagged
  calls — published in the report so consumers know how much to trust tier 2 in their domain.

## 6. Build plan — small blocks, each testable alone

| # | Block | Deliverable | Acceptance test | Effort |
|---|---|---|---|---|
| C1 | Pairwise similarity core | pure fn: descriptions → matrix + pairs | property: symmetric; self-sim = 1; threshold monotonicity (mockEmbedder) | S |
| C2 | Structural lint rules | rule fns + report assembly | one fixture catalog per rule, incl. the Neo `metric`-enum case | S |
| C3 | CI gate | `report.ok` + exit-code wrapper + content-hash embed cache | non-ok catalog fails; cache hits on re-run | S |
| C4 | Margin scorer | pure fn: (catalog, contextText, chosen) → scores/margin/flags | fixtures: decisive, narrow, proxy-disagreement | S |
| C5 | `toolChoiceRecorder` | CombinedRecorder + KeyedStore wiring | scripted-mock agent run → entries per LLM call; runId reset (Convention 4) | M |
| C6 | Flag surfacing | `getFlagged()` + run-summary counts | flagged calls match C4 fixtures end-to-end | S |
| C7 | Lens panel | bar chart + margin badge | U-tier; after C5 ships | M |
| C8 | Tier-3 sampler + A/B harness | entropy + proxy-health report | validation scenario from §5 | M |

Per Convention 2, `examples/observability/tool-confusability/` ships with C3 and C5: 01-lint a
deliberately confusable catalog, 02-fix-and-pass, 03-margin-recorder on a scripted run.

## 7. Strategic note

This completes the stack's explanation triad — decisions (`decide()` evidence), evidence (FDL),
**selection** (this) — and it is independently adoptable: any agentfootprint user (and, via the
catalog-lint's plain `{name, description}[]` input, any agent developer at all) can run tier 1
with zero stack buy-in. Same funnel shape as AgentThinkingUI. Neo is the first test catalog:
30+ tools, several deliberately-twinned NX-API/Influx pairs — if the lint doesn't flag
`get_fcns_database` vs `influx_get_fcns_database`, the threshold is wrong.
