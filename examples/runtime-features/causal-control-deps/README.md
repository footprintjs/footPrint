# Causal slicing with control-dependence edges (RFC-003 Part A)

`causalChain` follows **data** edges (read→write). But a branch stage often
runs without reading anything — it ran BECAUSE a decider chose it. These
examples show the full causal-completeness toolkit:

| Piece                                              | What it adds                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `TraversalContext.parentRuntimeStageId` (D1)       | the runtime ancestor chain — crosses subflow boundaries, unambiguous across loop iterations                          |
| `CommitBundle.untrackedSources` (D2)               | honesty flags for `args`/`env`/unshadowed `silent` reads → `⚠ … slice may be incomplete here` in `formatCausalChain` |
| `causalChain({ controlDeps })` + `CausalEdge` (D3) | `kind: 'control'` edges to the governing decider, labeled by the decide() rule label                                 |
| `causalChain({ weigh })` + `truncated` (D4)        | consumer-injected edge weights (the engine never computes them) + explicit truncation visibility                     |
| `controlDepRecorder()` (D5)                        | the built-in `ControlDepLookup` producer — attach, run, plug into the backtracker                                    |

## Examples

1. **[01-credit-fixture.ts](01-credit-fixture.ts)** — the canonical chain:
   `status ← [control: Good credit] ClassifyRisk ← via creditScore PullBureau`,
   with the `⚠ also consumed args` honesty marker and a consumer-injected
   edge weigher.

Run with:

```bash
npx tsx examples/runtime-features/causal-control-deps/01-credit-fixture.ts
```
