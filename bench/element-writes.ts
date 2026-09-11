/**
 * element-writes — N element writes on ONE array in ONE stage.
 *
 * Why it exists: 9.22.0 made an element write through the scope proxy
 * (`arr[i].n = i`) commit as a whole-array `set` of the ROOT key, so N element
 * writes in one stage stage N whole-array rows on ONE path. The 9.22.0 perf
 * review found that the commit funnel (`TransactionBuffer.toChangeOnlyPayload`)
 * and the replay law (`applySmartMerge`, behind the live commit, `materialise`
 * and `stateAt`) each cloned the array ONCE PER ROW — O(N × rows) for a bundle
 * whose bytes are O(N). 9.22.1 skips the clone a later row on the same path
 * redoes; this bench is the checked-in instrument that says by how much.
 *
 * What it measures, for N ∈ {100, 1k, 10k} under BOTH `commitValues`
 * encodings: a seed stage writing an N-element array, then a work stage doing
 * N element writes through the proxy — whole run (ms), the stage body alone
 * (ms — the proxy's per-write cost, NOT touched by 9.22.1), the rows in the
 * work bundle, and one `stateAt` fold of the finished log (ms — the replay
 * law). Beside it, the bulk path `$batchArray` at each N: one clone, one row.
 * That ratio is the number `src/lib/reactive/README.md` quotes.
 *
 * A NESTED array (`scope.k.arr[i].n = i`) commits the same way — `set` of
 * `k` — and measures the same; the top-level key is used so `$batchArray`
 * applies to the identical shape.
 *
 * Run:  npx tsx bench/element-writes.ts                 # current src
 *       npx tsx bench/element-writes.ts --dist <root>   # a BUILT tree (its dist/esm)
 *       npx tsx bench/element-writes.ts --sizes 100,1000 # only these N
 * The `--dist` form is how an older tag is measured side by side: build it in
 * a scratch copy and point here. N=10k is measured ONCE (no warmup) because
 * the loop variant's stage body is itself O(N²) in the proxy (see the README
 * guidance: use `$batchArray` for bulk edits).
 */

export {}; // a module, so these names stay out of the bench folder's script scope

const SIZES = [100, 1_000, 10_000];
const ROUNDS = 5;
const WARMUP = 2;
const SLOW_FROM = 10_000; // one round, no warmup, at and above this N

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => { addFunction: any; build: () => any };
  FlowChartExecutor: new (chart: any, options?: any) => {
    run(): Promise<unknown>;
    getSnapshot(): { commitLog: Array<{ trace: unknown[] }>; initialState?: unknown };
  };
  stateAt: (source: unknown, idx: number) => unknown;
};

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const flag = process.argv.indexOf('--dist');
  if (flag !== -1 && process.argv[flag + 1]) {
    const root = process.argv[flag + 1].replace(/\/$/, ''); // absolute path of a built tree
    const core = await import(`file://${root}/dist/esm/index.js`);
    const trace = await import(`file://${root}/dist/esm/trace.js`);
    return { lib: { ...core, stateAt: trace.stateAt } as Lib, label: root };
  }
  const core = (await import('../src/index')) as unknown as Lib;
  const trace = (await import('../src/trace')) as unknown as { stateAt: Lib['stateAt'] };
  return { lib: { ...core, stateAt: trace.stateAt }, label: 'src' };
}

function sizes(): number[] {
  const flag = process.argv.indexOf('--sizes');
  return flag !== -1 && process.argv[flag + 1] ? process.argv[flag + 1].split(',').map(Number) : SIZES;
}

type Variant = 'loop' | 'batch';

/** Seed + work chart. `body` receives the measured stage-body time. */
function buildChart(lib: Lib, n: number, variant: Variant, body: { ms: number }) {
  const seed = (scope: any) => {
    scope.arr = Array.from({ length: n }, (_, id) => ({ id, n: 0, tag: `t${id % 7}` }));
  };
  const work =
    variant === 'loop'
      ? (scope: any) => {
          const arr = scope.arr;
          const t0 = performance.now();
          for (let i = 0; i < n; i++) arr[i].n = i;
          body.ms = performance.now() - t0;
        }
      : (scope: any) => {
          const t0 = performance.now();
          scope.$batchArray('arr', (arr: any[]) => {
            for (let i = 0; i < n; i++) arr[i].n = i;
          });
          body.ms = performance.now() - t0;
        };
  return lib.flowChart('Seed', seed, 'seed').addFunction('Work', work, 'work').build();
}

type Sample = { total: number; body: number; fold: number; rows: number };

async function once(lib: Lib, n: number, variant: Variant, commitValues: 'full' | 'delta'): Promise<Sample> {
  const body = { ms: 0 };
  const chart = buildChart(lib, n, variant, body);
  const executor = new lib.FlowChartExecutor(chart, { commitValues });
  const t0 = performance.now();
  await executor.run();
  const total = performance.now() - t0;
  const snapshot = executor.getSnapshot();
  const t1 = performance.now();
  lib.stateAt(snapshot, snapshot.commitLog.length - 1);
  const fold = performance.now() - t1;
  const rows = snapshot.commitLog[snapshot.commitLog.length - 1].trace.length;
  return { total, body: body.ms, fold, rows };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(lib: Lib, n: number, variant: Variant, commitValues: 'full' | 'delta'): Promise<Sample> {
  const slow = n >= SLOW_FROM;
  const rounds = slow ? 1 : ROUNDS;
  for (let i = 0; i < (slow ? 0 : WARMUP); i++) await once(lib, n, variant, commitValues);
  const samples: Sample[] = [];
  for (let i = 0; i < rounds; i++) samples.push(await once(lib, n, variant, commitValues));
  return {
    total: median(samples.map((s) => s.total)),
    body: median(samples.map((s) => s.body)),
    fold: median(samples.map((s) => s.fold)),
    rows: samples[0].rows,
  };
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(2)).padStart(8);

async function main() {
  const { lib, label } = await loadLib();
  console.log(
    `element-writes [${label}] — N element writes in one stage (median of ${ROUNDS}; N ≥ ${SLOW_FROM}: 1 run)`,
  );
  console.log(
    `${'N'.padStart(6)} ${'mode'.padEnd(5)} ${'variant'.padEnd(7)} ${'rows'.padStart(6)} ${'total ms'.padStart(8)} ` +
      `${'body ms'.padStart(8)} ${'fold ms'.padStart(8)}   loop/batch`,
  );
  for (const n of sizes()) {
    for (const commitValues of ['full', 'delta'] as const) {
      const loop = await measure(lib, n, 'loop', commitValues);
      const batch = await measure(lib, n, 'batch', commitValues);
      for (const [variant, s] of [
        ['loop', loop],
        ['batch', batch],
      ] as const) {
        const ratio =
          variant === 'loop'
            ? `${(loop.total / batch.total).toFixed(0)}× total, ${(loop.body / batch.body).toFixed(0)}× body`
            : '';
        console.log(
          `${String(n).padStart(6)} ${commitValues.padEnd(5)} ${variant.padEnd(7)} ${String(s.rows).padStart(6)} ` +
            `${fmt(s.total)} ${fmt(s.body)} ${fmt(s.fold)}   ${ratio}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
