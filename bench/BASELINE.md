# Performance Baseline (backlog #12)

Reference numbers for the perf work in backlog #13 (truly-lazy TransactionBuffer),
#14 (read-tracking clone opt-in) and #15 (trampoline). Re-run with `npm run bench`
and diff against this file in those PRs.

**Machine:** Apple M2, 8 GB RAM, macOS (darwin arm64)
**Node:** v22.16.0
**Date:** 2026-06-09 (sections A–C + micro: v8.1.0 @ 29c9edc) / 2026-06-10 (section D re-measured post-#15 trampoline)
**Source version:** 8.1.0 (worktree of main @ 29c9edc); section D updated on the `trampoline` branch (post-v8.3.0)

> **#15 SHIPPED:** `executeNode` is now an iterative trampoline driver — see
> section D for before/after. Micro + linear-chain benches were re-run on the
> trampoline branch and are within run-to-run noise of the 8.1.0 numbers below
> (500-stage linear: 22.24ms → 20.96ms; commit/replay/clone unchanged) — no
> >20% regressions.

How these were produced:

```bash
npm run bench            # all three scripts, in order
npm run bench:micro      # bench/run.ts        — memory-layer micro benches
npm run bench:baseline   # bench/baseline.ts   — end-to-end charts (A/B/C below)
npm run bench:depth      # bench/depth-probe.ts — depth-guard probe (D below)
```

All benches use fixed sizes, warmup rounds and report the **median** of multiple
measured rounds. Expect a few percent run-to-run jitter; the structural ratios
(late/early growth, per-stage freight, depth slopes) are the stable signals.

---

## A. Read-heavy stage over ~1MB shared state (`bench:baseline`)

| Benchmark | Median | Detail |
|---|---|---|
| First tracked read (1MB state) | 4.97ms | TransactionBuffer construction: 2× structuredClone of full state |
| 2,000 small tracked reads | 1.27ms | 1,569,243 ops/s |
| 50 tracked reads of 1MB value | 138.80ms | 360 ops/s (per-read value clone) |
| Run: seed(1MB) + 1-small-read stage | 21.66ms | read-only stage pays buffer construction |
| Run: seed(1MB) + touch-nothing stage | 21.44ms | pays it too — commit() constructs the buffer |
| Δ one-read vs no-touch | ≈0 (216µs) | BOTH pay full freight (see finding 1) |
| Per no-touch stage over 1MB state | 10.19ms | from 1-vs-5-stage charts; #13 target: ~0 |

**Finding 1 (refines the #13 brief):** the read-only-stage freight is real, but it
is NOT read-specific. `context.commit()` runs after EVERY stage
(FlowchartTraverser.ts:736) and `StageContext.commit()` calls
`getTransactionBuffer()` unconditionally (StageContext.ts:256) — so even a stage
that never touches state constructs the buffer (2× structuredClone of the entire
shared state, ~10ms per stage over 1MB state on this machine). #13 must make the
commit path skip buffer construction when nothing was staged, or the "read-only
stages become free" goal won't show up in this bench.

## B. Loop growth — 100-iteration `loopTo`, ~1KB append/iteration (`bench:baseline`)

| Benchmark | Median | Detail |
|---|---|---|
| Total wall (100 iterations) | 28.75ms | history grows to ~100KB |
| Iteration latency (iters 1–10) | 46µs | |
| Iteration latency (iters 91–100) | 424µs | **9.2× early** — O(state) clone per iteration |
| Peak RSS | 212.5MB | Δ from bench-B start: 3.7MB (process-wide RSS; bench A runs first) |

## C. Deep-nested subflow mounts (`bench:baseline`)

| Benchmark | Median | Detail |
|---|---|---|
| 10 nested subflow mounts | 235µs | 23µs/mount (build once: 671µs) |
| 50 nested subflow mounts | 1.36ms | 27µs/mount (build once: 2.43ms) |
| 100 nested subflow mounts | 3.32ms | 33µs/mount (build once: 11.99ms) |

Runtime nesting is NOT capped by `MAX_EXECUTE_DEPTH` — every mount gets a fresh
traverser with its own depth budget. 100-deep runs fine.

**Finding 2 (build-time, found by this bench):** naive nested `build()` blows up
BEFORE runtime — `_appendSubflowDescription` re-embeds the inner chart's full
description on every wrap, so `chart.description` grows exponentially with
nesting depth (`RangeError: Invalid string length` at ~25 levels). The bench
strips `description` between wraps as a workaround; candidate for a backlog item.

## D. Depth probe — agent-style loop chart (`bench:depth`)

Chart: Seed → [loop: Context → sf-tools subflow (2 stages) → Decide] → loopTo.
`MAX_EXECUTE_DEPTH = 500` now bounds TREE nesting only; the loop-iteration
limit (default 1000, `RunOptions.maxIterations`) is the binding constraint
for loops.

### POST-#15 (trampoline — 2026-06-10, current)

| Benchmark | Value | Detail |
|---|---|---|
| Probe @ 10 iterations | guard 1 | chain 1, 11 frames |
| Probe @ 50 iterations | guard 1 | chain 1, 51 frames |
| Frames per loop iteration | 1.0 | driver invocations (the subflow mount's fresh traverser) |
| Guard depth per iteration | **0.0** | flat — regression guard: any positive slope is a trampoline break |
| Chain depth per iteration | **0.0** | flat — retained promise chain no longer grows with iterations |
| Depth wall | none | pre-trampoline wall was iteration 249 |
| Long run: 10,000 iterations | 508ms | DEFAULT maxDepth; peak guard 1, peak chain 1, 51µs/iter |
| Binding limit (all defaults) | iteration 1,001 | `Maximum loop iterations (1000) exceeded for node 'context'` — the documented limit is now actually reachable |

**Finding 4 (post-#15 — what still bounds long loops):** MEMORY, not depth.
The long-run probe uses a scalar-state variant of the chart: appending to a
tracked ARRAY each iteration makes every commit record the full changed array,
so retained commit-log size grows O(N²) — the original history-appending chart
OOMs (~2 GB heap) near ~2,000 iterations on this machine. Per-iteration state
deltas, the commit log, and narrative entries all still accumulate per
iteration; long loops should keep tracked state bounded (windowed arrays,
scalars) or accept the memory cost deliberately.

### PRE-#15 (v8.1.0 — historical, the walls the trampoline removed)

| Benchmark | Value | Detail |
|---|---|---|
| Probe @ 10 iterations | guard 22 | chain 31, 51 frames |
| Probe @ 50 iterations | guard 102 | chain 151, 251 frames |
| Frames per loop iteration | 5.0 | across all traversers |
| Guard depth per iteration | 2.0 | engine `_executeDepth` slope — what the 500-cap checked |
| Chain depth per iteration | 3.0 | retained awaited-frame slope — the #15 trampoline target |
| Predicted wall iteration | ~249 | from guard-depth slope |
| Empirical wall iteration | 249 | guard actually fired (verified) |

**Finding 3 (pre-#15, two depths, both real — RESOLVED by #15):** the engine's
guard counter grew SLOWER than the true retained promise chain. Loop edges
returned `this.continuationResolver.resolve(...)` WITHOUT `await`, so the
`finally` decremented `_executeDepth` before the loop target ran — an
accidental partial tail-release on loop edges only. Guard slope 2.0 vs true
chain slope 3.0 per iteration on this chart. The prior agentfootprint
measurement (~7.0 frames/iter, peak 352 @ 50 iters, wall ≈ 71) was
chart-specific. The trampoline drove both slopes to 0.0 — the success
criterion ("the guard becomes a pure tree-nesting limit; the loop-iteration
limit becomes binding") is met, verified above.

## Micro benches (`bench:micro`, bench/run.ts)

| Benchmark | Median | Detail |
|---|---|---|
| Write 1,000 keys | 1.12ms | 892,326 ops/s |
| Write 10,000 keys | 12.12ms | 825,210 ops/s |
| Write 100,000 keys | 133.78ms | 747,468 ops/s |
| Read 1,000 keys | 843µs | 1,186,064 ops/s |
| Read 10,000 keys | 4.79ms | 2,086,231 ops/s |
| Read 100,000 keys | 81.27ms | 1,230,530 ops/s |
| 10 stages (linear) | 133µs | 0.013ms/stage |
| 50 stages (linear) | 774µs | 0.015ms/stage |
| 200 stages (linear) | 5.56ms | 0.028ms/stage |
| 500 stages (linear) | 22.24ms | 0.044ms/stage |
| 10 concurrent pipelines | 288µs | |
| 100 concurrent pipelines | 2.78ms | |
| 1,000 concurrent pipelines | 30.72ms | |
| structuredClone 1KB | 2µs | |
| structuredClone 10KB | 9µs | |
| structuredClone 100KB | 76µs | |
| structuredClone 1MB | 2.47ms | the unit of #13's freight: buffer construction = 2× this |
| Replay 10 commits | 14µs | |
| Replay 50 commits | 144µs | |
| Replay 100 commits | 441µs | |
| Replay 500 commits | 8.31ms | |
| Commit with 1 write | 10µs | |
| Commit with 10 writes | 57µs | |
| Commit with 50 writes | 289µs | |
| Commit with 100 writes | 574µs | |
