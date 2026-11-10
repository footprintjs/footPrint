# Performance Baseline (backlog #12)

Reference numbers for the engine's hot paths. **These are single-machine
numbers**: one run of each script on one laptop, on one day. They are a
reference for comparing a change against, on the same machine, not a claim
about any other machine. Expect a few percent run-to-run jitter (more for µs
rows); the structural ratios (late/early growth, depth slopes, dial-on vs
dial-off) are the stable signals.

**Machine:** Apple M5 Pro, 48 GB RAM, macOS (darwin arm64)
**Node:** v24.21.0
**Date:** 2026-11-10
**Engine source:** commit `2d99968` (footprintjs 11.2.0; the bench scripts carry
the 2026-11-10 measurement fixes). Every number in sections A–E and Micro below
comes from ONE run of the four commands under "Reproduce", in that order. The
same A–E numbers are in `bench/results/baseline.json`.

## Reproduce

```bash
rm -f bench/results/latest.json
node --import tsx bench/baseline.ts                     # sections A/B/C  (npm run bench:baseline)
node --import tsx bench/depth-probe.ts                  # section D       (npm run bench:depth)
node --expose-gc --import tsx bench/retained-heap.ts    # section E       (npm run bench:heap)
node --expose-gc --import tsx bench/run.ts              # Micro           (npm run bench:micro, without the heap column)
node --import tsx bench/compare.ts                      # diff latest.json against baseline.json (npm run bench:compare)
```

`npm run bench` runs micro, baseline and depth in order. The npm scripts use
`npx tsx`; `node --import tsx` is the same runner and is what was used here.

**Machine contract (`fp-bench/1`):** this file is the HUMAN document. The
machine mirror is `bench/results/latest.json`, written by `bench/baseline.ts`
(sections A/B/C), `bench/depth-probe.ts` (D) and `bench/retained-heap.ts` (E):
`{ schema: 'fp-bench/1', date, node, platform, commit, rows: [{ section,
name, value, unit, detail }] }`. `bench/compare.ts` diffs it against the
committed reference `bench/results/baseline.json`, prints per-row deltas, and
HIGHLIGHTS regressions (▲ red; exit 1 above `--threshold`, default 25%,
gated by per-unit noise floors) and improvements (▼ green). The reference has
every row the scripts write today (27 rows), so no row shows as "added".
Update the reference by copying a reviewed `latest.json` over `baseline.json`
in the PR that justifies it, and update this file from the same run.

All benches use fixed sizes, warmup rounds and report the **median** of
multiple measured rounds.

**What is engine and what is not.** Since FootPrint 10 the record (the
transaction buffer, the commit log `EventLog`, replay, `stateAt`, the readers)
lives in the `foottrace` package. Sections A–E run whole charts through the
engine, so they include foottrace's share. The Micro "Replay" rows time only
foottrace's `EventLog.materialise`, and the "structuredClone" rows time only V8.

---

## A. Read-heavy stage over ~1MB shared state (`bench/baseline.ts`)

| Benchmark | Median | Detail |
|---|---|---|
| First tracked read (1MB state) | 19µs | reads never construct the transaction buffer (#13) |
| 2,000 small tracked reads | 1.21ms | 1,651,869 ops/s |
| 50 tracked reads of 1MB value | 121.83ms | default `readTracking: 'full'` — the per-read value clone is the default's cost by design |
| … same, `readTracking: 'summary'` | 14.28ms | per-read marker, no value clone (#14) |
| … same, `readTracking: 'off'` | 6µs | no stageReads tracking (#14) |
| Run: seed(1MB) + 1-small-read stage | 9.45ms | the read-only stage clones nothing; the seed stage pays its own write |
| Run: seed(1MB) + touch-nothing stage | 10.12ms | an empty commit records the bundle with zero clones |
| Δ one-read vs no-touch | ≈0 (-668µs) | both stage kinds are free |
| Per no-touch stage over 1MB state | ≈0 (-237µs) | regression guard: must stay at µs scale (sub-noise) |

**Finding 1 (resolved by #13):** the per-stage freight was never
read-specific — `commit()` used to construct the transaction buffer after
EVERY stage. #13 moved buffer construction to the stage's first WRITE: reads
consult the buffer only if it exists, and a commit with no buffer records the
same empty bundle with zero clones. The buffer is now foottrace's
(`RecordFrame`, composed by `StageContext`). Guarded by
`test/lib/memory/scenario/lazy-buffer.test.ts`.

## B. Loop growth — 100-iteration `loopTo`, ~1KB append/iteration (`bench/baseline.ts`)

| Benchmark | Median | Detail |
|---|---|---|
| Total wall (100 iterations) | 15.70ms | history grows to ~100KB |
| Iteration latency (iters 1–10) | 37µs | |
| Iteration latency (iters 91–100) | 204µs | 5.5× the early latency |
| Peak RSS | 360.2MB | process-wide RSS (Δ from bench-B start: 1.6MB; bench A runs first) |

## C. Deep-nested subflow mounts (`bench/baseline.ts`)

| Benchmark | Median | Detail |
|---|---|---|
| 10 nested subflow mounts | 261µs | 26µs/mount (build once: 594µs) |
| 50 nested subflow mounts | 1.53ms | 31µs/mount (build once: 5.58ms) |
| 100 nested subflow mounts | 3.61ms | 36µs/mount (build once: 15.48ms) |

Runtime nesting is NOT capped by `MAX_EXECUTE_DEPTH` — every mount gets a fresh
traverser with its own depth budget. 100-deep runs fine.

**Finding 2 (build-time, found by this bench; fixed in the builder):** nested
`build()` used to re-embed the inner chart's full description on every wrap, so
`chart.description` grew exponentially with nesting depth (`RangeError: Invalid
string length` at ~25 levels). `FlowChartBuilder · _appendSubflowDescription` now
inlines only the inner summary and re-lists its steps once, so the bench builds
the nested chart as written, with no workaround. Measured on 2026-11-10 with a
throwaway script that wraps the same chart 100 times: the description is 933
characters at 10 levels, 10,533 at 50 and 36,006 at 100 (each level re-lists the
steps below it, so the growth is quadratic, not exponential).

## D. Depth probe — agent-style loop chart (`bench/depth-probe.ts`)

Chart: Seed → [loop: Context → sf-tools subflow (2 stages) → Decide] → loopTo.
`MAX_EXECUTE_DEPTH = 500` bounds TREE nesting only; the loop-iteration limit
(default 1000, `RunOptions.maxIterations`) is the binding constraint for loops.
The script fails (exit 1) when the depth slopes are not flat, when the long run
stops early, or when the runaway loop is stopped by anything but the iteration
limit.

| Benchmark | Value | Detail |
|---|---|---|
| Probe @ 10 iterations | guard 1 | chain 1, 11 frames |
| Probe @ 50 iterations | guard 1 | chain 1, 51 frames |
| Frames per loop iteration | 1.0 | driver invocations (the subflow mount's fresh traverser) |
| Guard depth per iteration | 0.0 | must be 0.0 — any positive slope is a trampoline break |
| Chain depth per iteration | 0.0 | must be 0.0 — the retained promise chain does not grow with iterations |
| Depth wall | none (flat) | pre-trampoline wall was iteration 249 |
| Long run: 10,000 iterations | 500ms | default maxDepth; peak guard 1, peak chain 1, 50µs/iter |
| Binding limit (all defaults) | iteration 1,001 | `Maximum loop iterations (1000) exceeded for node 'context'` |

**Finding 4 (what still bounds long loops):** MEMORY, not depth. The long-run
probe uses a scalar-state variant of the chart: appending to a tracked ARRAY
each iteration makes every commit record the full changed array under the
default `commitValues: 'full'`, so the retained commit log grows O(N²). Long
loops should keep tracked state bounded (windowed arrays, scalars), use the
dials in section E, or accept the memory cost deliberately.

## E. Retained heap — agent-style growing-history loop (`bench/retained-heap.ts`)

Probe: needs `--expose-gc`. Context → sf-tools subflow → Decide → loopTo,
appending a ~1KB message to a tracked `history` array per iteration, N=200.
Reports `heapUsed` after `global.gc()` (1) with the executor (and its execution
tree) still referenced and (2) after dropping it.

| Benchmark | Value | Detail |
|---|---|---|
| Retained @ N=200, executor referenced | 61.6MB | default dials |
| Retained after dropping executor | 1.0MB | the floor |
| Per iteration (tree retained) | 315.6KB | the first row divided by 200 |
| `writeTracking: 'summary'` | 41.1MB | stageWrites kept as markers (#13c-A) |
| `writeTracking: 'off'` | 41.0MB | no stageWrites kept (#13c-A) |
| `commitValues: 'delta'` | 41.3MB | the commit log stores append bundles (#13c-B) |
| `commitValues: 'delta'` + `read/writeTracking: 'off'` | 2.6MB | all three dials |

**Finding 5 (#13b — staging state released at commit):** a committed stage no
longer pins its transaction buffer or its first-touch view of state; foottrace's
`RecordFrame · release` drops both at the end of `StageContext.commit()`. What
the executor still retains is the audit surface: the commit log, the narrative
and the per-stage `stageReads`/`stageWrites` tracking. On this chart each
iteration reads and writes the full `history` array, so under the default dials
each of those grows with the array.

**Findings 6 and 7 (the dials):** the rows above show the share each dial
removes on this chart at N=200: `writeTracking` 'summary' or 'off' and
`commitValues: 'delta'` each take the default 61.6MB to about 41MB; all three
together leave 2.6MB. `'delta'` is lossless: every step's state is rebuilt by
replay (foottrace's `EventLog.materialise` / `stateAt`). This script measures
only N=200; the earlier N=500 and N=1000 rows are under History, not
re-measured on 2026-11-10.

---

## Micro benches (`bench/run.ts`)

Run with `--expose-gc` so the concurrent-pipelines heap column is sampled after
a forced collection (without it the column prints n/a).

| Benchmark | Median | Detail |
|---|---|---|
| Write 1,000 keys | 280µs | 3,568,765 ops/s |
| Write 10,000 keys | 3.94ms | 2,541,081 ops/s |
| Write 100,000 keys | 67.15ms | 1,489,137 ops/s |
| Read 1,000 keys | 340µs | 2,939,733 ops/s |
| Read 10,000 keys | 4.11ms | 2,430,207 ops/s |
| Read 100,000 keys | 73.55ms | 1,359,603 ops/s |
| Read 10,000 root keys from a fork child | 3.74ms | 2,674,006 ops/s (served from live state) |
| 10 stages (linear) | 163µs | 0.016ms/stage |
| 50 stages (linear) | 679µs | 0.014ms/stage |
| 200 stages (linear) | 1.87ms | 0.009ms/stage |
| 500 stages (linear) | 12.67ms | 0.025ms/stage |
| 10 concurrent pipelines | 228µs | ~0B heap after gc (below the sample's noise) |
| 100 concurrent pipelines | 2.56ms | ~803.1KB heap after gc |
| 1,000 concurrent pipelines | 25.11ms | ~8.2MB heap after gc |
| structuredClone 1KB | 1µs | V8 only |
| structuredClone 10KB | 6µs | V8 only |
| structuredClone 100KB | 59µs | V8 only |
| structuredClone 1MB | 2.00ms | V8 only |
| Replay 10 commits | 5µs | foottrace `EventLog.materialise` only |
| Replay 50 commits | 36µs | foottrace `EventLog.materialise` only |
| Replay 100 commits | 45µs | foottrace `EventLog.materialise` only |
| Replay 500 commits | 217µs | foottrace `EventLog.materialise` only |
| Commit with 1 write | 3µs | `commit()` only (setup and writes outside the clock) |
| Commit with 10 writes | 25µs | `commit()` only |
| Commit with 50 writes | 128µs | `commit()` only |
| Commit with 100 writes | 279µs | `commit()` only |

---

## History (2026-06, Apple M2, 8 GB RAM, Node v22.16.0 — not re-measured on 2026-11-10)

Kept so the before/after of each fix stays readable. These come from a
different machine and engine version (8.1.0–9.2.0); do not compare them with
the tables above.

**Pre-#13 (v8.1.0), section A:** first tracked read (1MB state) 4.97ms — the
buffer construction cloned the full state twice; per no-touch stage over 1MB
state 10.19ms.

**Pre-#15 (v8.1.0), section D:** guard depth slope 2.0/iteration, chain depth
slope 3.0/iteration, empirical wall at iteration 249. **Finding 3 (resolved by
#15):** the engine's guard counter grew slower than the true retained promise
chain, because loop edges returned the continuation without `await`. The
trampoline drove both slopes to 0.0.

**Pre-#13b (v9.2.0), section E:** retained @ N=200 137.2MB, @ N=500 849.1MB —
every StageContext pinned its state view and buffer clones; the full-agent #18
measurement ran out of the default Node heap at N=500.

**Section E at N=500 and N=1000 (2026-06-10, post-#13c-B):**

| Configuration | N=200 | N=500 | N=1000 |
|---|---|---|---|
| default (`'full'`, all dials default) | 59.7MB | 365.9MB | — |
| `commitValues: 'delta'` only | 40.4MB | 245.2MB | 971.6MB |
| `'delta'` + `read/writeTracking: 'off'` | 1.6–1.9MB | 4.0MB | 7.7MB |
