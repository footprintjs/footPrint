# Performance Baseline (backlog #12)

Reference numbers for the perf work in backlog #13 (truly-lazy TransactionBuffer),
#14 (read-tracking clone opt-in) and #15 (trampoline). Re-run with `npm run bench`
and diff against this file in those PRs.

**Machine:** Apple M2, 8 GB RAM, macOS (darwin arm64)
**Node:** v22.16.0
**Date:** 2026-06-09 (sections A–C + micro: v8.1.0 @ 29c9edc) / 2026-06-10 (section D re-measured post-#15 trampoline; sections A–B + micro re-measured post-#13 lazy buffer)
**Source version:** 8.1.0 (worktree of main @ 29c9edc); section D updated on the `trampoline` branch (post-v8.3.0); section A updated on the `lazy-buffer` branch (post-v9.0.0)

> **#15 SHIPPED:** `executeNode` is now an iterative trampoline driver — see
> section D for before/after. Micro + linear-chain benches were re-run on the
> trampoline branch and are within run-to-run noise of the 8.1.0 numbers below
> (500-stage linear: 22.24ms → 20.96ms; commit/replay/clone unchanged) — no
> >20% regressions.

> **#13 SHIPPED:** the TransactionBuffer is now constructed on a stage's first
> WRITE — reads never construct it, and `commit()` with no buffer records the
> (empty) bundle with zero clones. Section A has before/after. Micro benches
> re-run post-#13: read-throughput rows improved (reads no longer construct a
> buffer — Read 1,000 keys 843µs → 623µs, Read 100,000 keys 81.27ms → 65.52ms);
> write/clone/replay/commit/linear-chain rows within run-to-run noise. The
> depth-probe long run improved 508ms → 468ms (51µs → 47µs/iter) because its
> loop body includes non-writing stages.

> **#14 SHIPPED:** the per-tracked-read VALUE clone (`_stageReads`) is now
> policy-gated — `readTracking: 'full' | 'summary' | 'off'` on the executor
> (default `'full'`, byte-identical). Section A gained two variant rows for the
> 1MB-value reads: **'off' → 7µs** (was 130.15ms — zero per-read work),
> **'summary' → 30.34ms** (no value clone; the remaining cost is `Object.keys`
> on the bench's ~9.5k-key object — the size proxy is O(key count), still ~4×
> cheaper than the clone; on typical small objects it is µs). The default row
> is unchanged (130.15ms vs 129.65ms — run-to-run noise). Side measurement:
> `onRead` recorder events never cloned — 50×1MB reads with a recorder attached
> under 'off' run in 0.29ms and all events carry the SAME reference, so
> narrative/recorder output is identical in every mode.

How these were produced:

```bash
npm run bench            # all three scripts, in order
npm run bench:micro      # bench/run.ts        — memory-layer micro benches
npm run bench:baseline   # bench/baseline.ts   — end-to-end charts (A/B/C below)
npm run bench:depth      # bench/depth-probe.ts — depth-guard probe (D below)
npm run bench:heap       # bench/retained-heap.ts — retained-heap probe (E below; sets --expose-gc)
```

**Machine contract (`fp-bench/1`):** this file is the HUMAN document — prose,
findings, history. The machine mirror is `bench/results/latest.json`, written
by `bench:baseline` (sections A/B/C), `bench:depth` (D) and `bench:heap` (E):
`{ schema: 'fp-bench/1', date, node, platform, commit, rows: [{ section,
name, value, unit, detail }] }`. `npm run bench:compare` diffs it against the
committed reference `bench/results/baseline.json`, prints per-row deltas, and
HIGHLIGHTS regressions (▲ red; exit 1 above `--threshold`, default 25%,
gated by per-unit noise floors) and improvements (▼ green). Update the
reference by copying a reviewed `latest.json` over `baseline.json` in the
perf PR that justifies it.

All benches use fixed sizes, warmup rounds and report the **median** of multiple
measured rounds. Expect a few percent run-to-run jitter; the structural ratios
(late/early growth, per-stage freight, depth slopes) are the stable signals.

---

## A. Read-heavy stage over ~1MB shared state (`bench:baseline`)

### POST-#13 + #14 (lazy buffer + read-tracking policy — 2026-06-10, current)

| Benchmark | Median | Detail |
|---|---|---|
| First tracked read (1MB state) | **3µs** | was 4.97ms — reads never construct the buffer (#13) |
| 2,000 small tracked reads | 1.24ms | 1,613,066 ops/s |
| 50 tracked reads of 1MB value | 130.15ms | default `readTracking: 'full'` — unchanged (129.65ms pre-#14, within noise); the per-read VALUE clone is the DEFAULT's cost by design |
| … same, `readTracking: 'summary'` | 30.34ms | per-read marker, no value clone (#14); remaining cost = `Object.keys` proxy on the ~9.5k-key bench object |
| … same, `readTracking: 'off'` | **7µs** | no stageReads tracking, zero per-read clone (#14) |
| Run: seed(1MB) + 1-small-read stage | 14.59ms | was 21.66ms — the read-only stage clones nothing; the seed stage still pays its own write freight |
| Run: seed(1MB) + touch-nothing stage | 15.30ms | was 21.44ms — empty commit records the bundle with zero clones |
| Δ one-read vs no-touch | ≈0 (-710µs) | both stage kinds are now genuinely free |
| Per no-touch stage over 1MB state | **≈0 (-160µs)** | was 10.19ms — regression guard: must stay µs (sub-noise across runs) |

**Finding 1 — RESOLVED by #13:** the per-stage freight was never read-specific —
`commit()` constructed the buffer unconditionally after EVERY stage. #13 moved
buffer construction to the stage's first WRITE: reads consult the buffer only if
it exists (read-your-writes preserved), and a commit with no buffer records the
same empty bundle with ZERO clones (no buffer construction, no applyPatch
replay). Commit-log/narrative output is byte-identical to pre-#13. Guarded by
`test/lib/memory/scenario/lazy-buffer.test.ts` (clone-count assertions fail on
the eager-buffer implementation).

### PRE-#13 (v8.1.0 — historical)

| Benchmark | Median | Detail |
|---|---|---|
| First tracked read (1MB state) | 4.97ms | TransactionBuffer construction: 2× structuredClone of full state |
| 2,000 small tracked reads | 1.27ms | 1,569,243 ops/s |
| 50 tracked reads of 1MB value | 138.80ms | 360 ops/s (per-read value clone) |
| Run: seed(1MB) + 1-small-read stage | 21.66ms | read-only stage pays buffer construction |
| Run: seed(1MB) + touch-nothing stage | 21.44ms | pays it too — commit() constructs the buffer |
| Δ one-read vs no-touch | ≈0 (216µs) | BOTH pay full freight (see finding 1) |
| Per no-touch stage over 1MB state | 10.19ms | from 1-vs-5-stage charts; #13 target: ~0 |

**Finding 1 (pre-#13, refines the #13 brief):** the read-only-stage freight is
real, but it is NOT read-specific. `context.commit()` runs after EVERY stage
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

**Post-#13 re-measurement (2026-06-10):** 27.94ms wall / 44µs early / 401µs late
— within run-to-run noise of the table above, as expected: this chart's ONLY
loop stage writes every iteration, so it constructs the buffer regardless and
the late-iteration O(state) clone freight is the WRITING stage's own (that is
#14/commit-cost territory, not #13's). Loops whose bodies include non-writing
stages DO improve — the depth-probe long run (Context → sf-tools → Decide,
scalar state) dropped 508ms → 468ms for 10,000 iterations (51µs → 47µs/iter).

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

## E. Retained heap — agent-style growing-history loop (`bench:heap`)

Probe: `bench/retained-heap.ts` (needs `--expose-gc`; the npm script sets it).
Replicates the #18 measurement in footprintjs-only form: Context → sf-tools
subflow → Decide → loopTo, appending a ~1KB message to a tracked `history`
array per iteration. Reports `heapUsed` after `global.gc()` (1) with the
executor (and its execution tree) still referenced and (2) after dropping it.

### POST-#13b (staging state released at commit — 2026-06-10, current)

| Benchmark | Value | Detail |
|---|---|---|
| Retained @ N=200, executor referenced | **59.7MB** | was 137.2MB — the tree retains ZERO buffers / state generations |
| Retained @ N=500, executor referenced | **365.9MB** | was 849.1MB — pre-#13b the full-agent variant OOMed a default heap here (#18) |
| Retained after dropping executor | ~0.4MB | floor — everything the executor pinned was releasable |

**Finding 5 (#13b shipped — what remains is the audit surface):**
`StageContext.commit()` now releases the stage's TransactionBuffer (2
full-state clones) and first-touch `stateView` (a reference pinning one full
committed-state generation) at commit end. The remaining growth is BY DESIGN
and still O(N²) for a growing tracked array — at N=200: commit log ≈18MB
(each bundle records the full changed array), `stageReads` + `stageWrites`
snapshot clones ≈36MB (`$batchArray` = 1 tracked read + 1 tracked write of
the full array per iteration). Levers: `readTracking: 'summary' | 'off'`
(#14) removes the read half; the write half has no policy yet and the
per-commit clone WALL cost still dominates long-loop latency — both tracked
as **#13c**.

### PRE-#13b (v9.2.0 — historical)

| Benchmark | Value | Detail |
|---|---|---|
| Retained @ N=200, executor referenced | 137.2MB | ~701KB/iteration — every StageContext pinned its stateView generation + buffer clones forever |
| Retained @ N=500, executor referenced | 849.1MB | quadratic; the full-agent #18 measurement OOMed a default Node heap at this N |
| Retained after dropping executor | ~0.4MB | the pin was the execution tree, not a leak |

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
| structuredClone 1MB | 2.47ms | the unit of buffer-construction freight (2× this) — post-#13 paid only by stages that WRITE |
| Replay 10 commits | 14µs | |
| Replay 50 commits | 144µs | |
| Replay 100 commits | 441µs | |
| Replay 500 commits | 8.31ms | |
| Commit with 1 write | 10µs | |
| Commit with 10 writes | 57µs | |
| Commit with 50 writes | 289µs | |
| Commit with 100 writes | 574µs | |
