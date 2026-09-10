/**
 * read-cost — the per-tracked-read cost of the default (no policy) run.
 *
 * Why it exists: 9.19.0 moved the redaction verdict into `StageContext`, so
 * every tracked read and staged write now ASKS a rule. The no-policy path
 * must stay cost-identical, and this bench is the checked-in instrument that
 * says whether it does: 1,000 linear stages × 20 tracked reads each of
 * pre-seeded keys (20,000 reads, readTracking 'full'), no policy, median of
 * several rounds after warmup.
 *
 * Run:  npx tsx bench/read-cost.ts                 # current src
 *       npx tsx bench/read-cost.ts --dist <root>   # a BUILT tree (its dist/esm)
 * The `--dist` form is how an older tag is measured side by side: build it in
 * a scratch copy and point here.
 */

const STAGES = 1_000;
const READS_PER_STAGE = 20;
const ROUNDS = 15;
const WARMUP = 3;

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => { addFunction: any; build: () => any };
  FlowChartExecutor: new (chart: any, options?: any) => { run(): Promise<unknown> };
};

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const flag = process.argv.indexOf('--dist');
  if (flag !== -1 && process.argv[flag + 1]) {
    const root = process.argv[flag + 1]; // absolute path of a built tree
    const url = `file://${root.replace(/\/$/, '')}/dist/esm/index.js`;
    return { lib: (await import(url)) as Lib, label: root };
  }
  const src = (await import('../src/index')) as unknown as Lib;
  return { lib: src, label: 'src' };
}

function buildChart(lib: Lib) {
  const keys = Array.from({ length: READS_PER_STAGE }, (_, i) => `k${i}`);
  const read = (scope: any) => {
    let acc = 0;
    for (const k of keys) acc += scope[k] as number;
    scope.acc = acc;
  };
  let builder = lib.flowChart('S0', read, 's0');
  for (let i = 1; i < STAGES; i++) builder = builder.addFunction(`S${i}`, read, `s${i}`);
  return { chart: builder.build(), seed: Object.fromEntries(keys.map((k, i) => [k, i])) };
}

async function timeRun(lib: Lib, chart: any, seed: Record<string, number>): Promise<number> {
  const executor = new lib.FlowChartExecutor(chart, { initialContext: seed });
  const t0 = performance.now();
  await executor.run();
  return performance.now() - t0;
}

async function main() {
  const { lib, label } = await loadLib();
  const { chart, seed } = buildChart(lib);
  for (let i = 0; i < WARMUP; i++) await timeRun(lib, chart, seed);
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i++) samples.push(await timeRun(lib, chart, seed));
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const reads = STAGES * READS_PER_STAGE;
  console.log(
    `read-cost [${label}] ${STAGES} stages × ${READS_PER_STAGE} reads, no policy: ` +
      `median ${median.toFixed(2)} ms (${((median * 1e6) / reads).toFixed(0)} ns/read), ` +
      `min ${samples[0].toFixed(2)} ms, max ${samples[samples.length - 1].toFixed(2)} ms, ${ROUNDS} rounds`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
