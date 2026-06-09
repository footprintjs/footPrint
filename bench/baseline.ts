/**
 * FootPrint Baseline Benchmarks — end-to-end charts (backlog #12)
 *
 * Run: npx tsx bench/baseline.ts
 *
 * Captures TODAY's behavior on the paths the upcoming perf work targets,
 * so #13 (truly-lazy TransactionBuffer), #14 (read-tracking clone opt-in)
 * and #15 (trampoline) can show before/after deltas. Companion: the depth
 * guard probe lives in bench/depth-probe.ts; micro benches in bench/run.ts.
 *
 * A. Read-heavy stage over ~1MB shared state
 *    - first tracked read  → constructs the TransactionBuffer, which today
 *      does TWO structuredClones of the ENTIRE shared state
 *      (TransactionBuffer.ts:25-26 via StageContext.getValue →
 *      getTransactionBuffer) — read-only stages pay full freight
 *    - N small tracked reads → per-read overhead (each read structuredClones
 *      the value into _stageReads, StageContext.ts:213)
 *    - N reads of the 1MB value itself → value-clone-dominated reads
 *    - read-only vs touch-nothing vs stage-count scaling → BASELINE FINDING:
 *      the one-read/no-touch delta is ~0 because `context.commit()` runs for
 *      EVERY stage (FlowchartTraverser.ts:736) and `StageContext.commit()`
 *      constructs the buffer unconditionally (StageContext.ts:256) — so even
 *      a stage that never touches state pays the 2× full-state clone. The
 *      per-stage freight is exposed by comparing charts with 1 vs 5 no-touch
 *      stages. #13 must make commit() skip buffer construction too.
 *
 * B. Loop growth — 100-iteration loopTo chart appending ~1KB messages to a
 *    growing history array (simulates agent message history). Per-iteration
 *    latency early vs late + peak RSS.
 *
 * C. Deep-nested subflows — 10/50/100 nested subflow mounts, wall time.
 *    (Each mount gets a FRESH traverser, so MAX_EXECUTE_DEPTH=500 does NOT
 *    cap nesting depth — it caps the awaited chain within ONE traverser.)
 *
 * Numbers recorded in bench/BASELINE.md.
 *
 * $getValue/$setValue are used (instead of typed property access) because the
 * benches rotate through DYNAMIC keys — exactly what those escape hatches are
 * for. They route to the same tracked ScopeFacade.getValue/setValue paths.
 */

import { flowChart, FlowChartExecutor } from '../src/index';
import type { FlowChart } from '../src/index';
import {
  type BenchResult,
  formatBytes,
  formatMs,
  formatNum,
  makeMessage,
  makeObject,
  measureAsync,
  median,
  printHeader,
  printTable,
} from './util';

type LooseState = Record<string, unknown>;

// ─── Bench A: read-heavy stage over ~1MB shared state ───

const STATE_BYTES = 1_048_576; // ~1MB doc
const SMALL_KEYS = 100;
const N_SMALL_READS = 2_000;
const N_DOC_READS = 50;
const ROUNDS = 7;

async function benchReadHeavy(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  // Per-round samples captured from INSIDE the reader stage (closure).
  let firstReadMs = 0;
  let smallReadsMs = 0;
  let docReadsMs = 0;

  const seedFn = async (scope: { $setValue(k: string, v: unknown): void }) => {
    scope.$setValue('doc', makeObject(STATE_BYTES));
    for (let i = 0; i < SMALL_KEYS; i++) scope.$setValue(`k_${i}`, i);
  };

  const chart = flowChart<LooseState>('Seed', seedFn, 'seed')
    .addFunction(
      'Reader',
      async (scope) => {
        // First tracked read of the stage — constructs the TransactionBuffer
        // (2× structuredClone of the entire ~1MB shared state today).
        let t0 = performance.now();
        scope.$getValue('k_0');
        firstReadMs = performance.now() - t0;

        // Small tracked reads (rotating keys; values are numbers, so the
        // per-read _stageReads clone is cheap — this isolates per-read overhead).
        t0 = performance.now();
        for (let i = 0; i < N_SMALL_READS; i++) scope.$getValue(`k_${i % SMALL_KEYS}`);
        smallReadsMs = performance.now() - t0;

        // Reads of the ~1MB doc — every tracked read structuredClones the value.
        t0 = performance.now();
        for (let i = 0; i < N_DOC_READS; i++) scope.$getValue('doc');
        docReadsMs = performance.now() - t0;
      },
      'reader',
    )
    .build();

  const firstArr: number[] = [];
  const smallArr: number[] = [];
  const docArr: number[] = [];

  // Warmup
  await new FlowChartExecutor(chart).run();
  for (let r = 0; r < ROUNDS; r++) {
    await new FlowChartExecutor(chart).run();
    firstArr.push(firstReadMs);
    smallArr.push(smallReadsMs);
    docArr.push(docReadsMs);
  }

  results.push({
    name: 'First tracked read (1MB state)',
    value: formatMs(median(firstArr)),
    detail: 'TransactionBuffer construction: 2× structuredClone of full state',
  });
  const smallMed = median(smallArr);
  results.push({
    name: `${formatNum(N_SMALL_READS)} small tracked reads`,
    value: formatMs(smallMed),
    detail: `${formatNum(Math.round(N_SMALL_READS / (smallMed / 1000)))} ops/s`,
  });
  const docMed = median(docArr);
  results.push({
    name: `${formatNum(N_DOC_READS)} tracked reads of 1MB value`,
    value: formatMs(docMed),
    detail: `${formatNum(Math.round(N_DOC_READS / (docMed / 1000)))} ops/s (per-read value clone)`,
  });

  // Read-only-stage variant: identical seed, second stage does ONE small read
  // vs a stage that never touches state.
  //
  // BASELINE FINDING: the delta is ~0 — NOT because read-only stages are free,
  // but because `context.commit()` runs after EVERY stage and constructs the
  // buffer unconditionally. Every stage over 1MB state pays the ~2× full-state
  // clone today. The 1-vs-5 no-touch comparison below isolates that per-stage
  // freight end-to-end. #13's target: BOTH deltas ≈ 0.
  const oneReadChart = flowChart<LooseState>('Seed', seedFn, 'seed')
    .addFunction(
      'OneRead',
      async (scope) => {
        scope.$getValue('k_0');
      },
      'one-read',
    )
    .build();

  const buildNoTouchChart = (stages: number) => {
    const builder = flowChart<LooseState>('Seed', seedFn, 'seed');
    for (let i = 0; i < stages; i++) {
      builder.addFunction(`NoTouch${i}`, async () => undefined, `no-touch-${i}`);
    }
    return builder.build();
  };
  const noTouchChart = buildNoTouchChart(1);
  const noTouch5Chart = buildNoTouchChart(5);

  const oneRead = await measureAsync(async () => {
    await new FlowChartExecutor(oneReadChart).run();
  }, ROUNDS);
  const noTouch = await measureAsync(async () => {
    await new FlowChartExecutor(noTouchChart).run();
  }, ROUNDS);
  const noTouch5 = await measureAsync(async () => {
    await new FlowChartExecutor(noTouch5Chart).run();
  }, ROUNDS);

  results.push({
    name: 'Run: seed(1MB) + 1-small-read stage',
    value: formatMs(oneRead.median),
    detail: 'read-only stage pays buffer construction',
  });
  results.push({
    name: 'Run: seed(1MB) + touch-nothing stage',
    value: formatMs(noTouch.median),
    detail: 'pays it too — commit() constructs the buffer',
  });
  results.push({
    name: 'Δ one-read vs no-touch',
    value: formatMs(oneRead.median - noTouch.median),
    detail: '≈0 today: BOTH pay full freight (see header)',
  });
  results.push({
    name: 'Per no-touch stage over 1MB state',
    value: formatMs((noTouch5.median - noTouch.median) / 4),
    detail: 'from 1-vs-5-stage charts; #13 target: ~0',
  });

  return results;
}

// ─── Bench B: loop growth (100 iterations, growing history) ───

const LOOP_ITERS = 100;
const LOOP_ROUNDS = 3;

interface LoopState {
  history: unknown[];
  i: number;
}

async function benchLoopGrowth(): Promise<BenchResult[]> {
  // Per-round samples (closure-captured from inside the loop stage).
  let iterMarks: number[] = [];
  let rssPeak = 0;
  const rssStart = process.memoryUsage().rss; // RSS is process-wide; bench A ran before us

  const chart = flowChart<LoopState>(
    'Seed',
    async (scope) => {
      scope.history = [];
      scope.i = 0;
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        iterMarks.push(performance.now());
        const rss = process.memoryUsage().rss;
        if (rss > rssPeak) rssPeak = rss;

        const i = scope.i; // tracked read
        scope.$batchArray('history', (arr) => {
          arr.push(makeMessage(i)); // ~1KB append — agent-history-style growth
        });
        scope.i = i + 1; // tracked write
        if (i + 1 >= LOOP_ITERS) scope.$break();
      },
      'work',
    )
    .loopTo('work')
    .build();

  const wallArr: number[] = [];
  const earlyArr: number[] = [];
  const lateArr: number[] = [];

  // maxDepth raised so the depth guard (bench/depth-probe.ts measures it)
  // stays out of the way — we're measuring per-iteration latency here.
  const runOnce = async () => {
    iterMarks = [];
    const t0 = performance.now();
    await new FlowChartExecutor(chart).run({ maxDepth: 10_000 });
    return performance.now() - t0;
  };

  await runOnce(); // warmup
  for (let r = 0; r < LOOP_ROUNDS; r++) {
    const wall = await runOnce();
    const deltas: number[] = [];
    for (let i = 1; i < iterMarks.length; i++) deltas.push(iterMarks[i] - iterMarks[i - 1]);
    wallArr.push(wall);
    earlyArr.push(median(deltas.slice(0, 10)));
    lateArr.push(median(deltas.slice(-10)));
  }

  const early = median(earlyArr);
  const late = median(lateArr);
  return [
    {
      name: `Total wall (${LOOP_ITERS} iterations)`,
      value: formatMs(median(wallArr)),
      detail: `history grows to ~${formatBytes(LOOP_ITERS * 1024)}`,
    },
    { name: 'Iteration latency (iters 1–10)', value: formatMs(early), detail: 'median' },
    {
      name: `Iteration latency (iters ${LOOP_ITERS - 9}–${LOOP_ITERS})`,
      value: formatMs(late),
      detail: `median — ${(late / early).toFixed(1)}× early`,
    },
    {
      name: 'Peak RSS',
      value: formatBytes(rssPeak),
      detail: `process.memoryUsage().rss (Δ from bench-B start: ${formatBytes(Math.max(0, rssPeak - rssStart))})`,
    },
  ];
}

// ─── Bench C: deep-nested subflow mounts ───

const NEST_DEPTHS = [10, 50, 100];

/** Build a chart with `depth` nested subflow mounts around a single leaf stage. */
function buildNestedChart(depth: number): FlowChart<any, any> {
  let chart: FlowChart<any, any> = flowChart<LooseState>(
    'Leaf',
    async (scope) => {
      scope.$setValue('leafDone', true);
    },
    'leaf',
  ).build();

  for (let d = depth; d >= 1; d--) {
    chart = flowChart<LooseState>(`Enter${d}`, async () => undefined, `enter-${d}`)
      .addSubFlowChartNext(`sf-${d}`, chart, `Level${d}`)
      .build();
    // BASELINE FINDING (build-time, found by this bench): every wrap re-embeds
    // the inner chart's FULL description (_appendSubflowDescription), so the
    // description grows EXPONENTIALLY with nesting depth — naive nesting blows
    // up with "RangeError: Invalid string length" at ~25 levels, long before
    // any runtime limit. Strip it between wraps; traversal doesn't depend on it.
    chart.description = '';
  }
  return chart;
}

async function benchDeepSubflows(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  for (const depth of NEST_DEPTHS) {
    const buildStart = performance.now();
    const chart = buildNestedChart(depth);
    const buildMs = performance.now() - buildStart;

    const t = await measureAsync(async () => {
      await new FlowChartExecutor(chart).run();
    }, 5);

    results.push({
      name: `${depth} nested subflow mounts`,
      value: formatMs(t.median),
      detail: `${formatMs(t.median / depth)}/mount (build once: ${formatMs(buildMs)})`,
    });
  }

  return results;
}

// ─── Runner ───

async function main() {
  printHeader('FootPrint Baseline Benchmarks (backlog #12)');

  printTable('A. Read-heavy stage over ~1MB shared state', await benchReadHeavy());
  printTable(`B. Loop growth (${LOOP_ITERS}-iteration loopTo, growing history)`, await benchLoopGrowth());
  printTable('C. Deep-nested subflow mounts', await benchDeepSubflows());

  console.log('\n---\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
