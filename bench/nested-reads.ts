/**
 * nested-reads — the naive re-read loop: `scope.k.arr[i]` for i < N, in ONE stage.
 *
 * Why it exists: the 9.22.0 perf review (finding 4) found that the nested
 * proxy's get trap built a FRESH array proxy — with its own empty element
 * cache — on every `.arr` access, so this loop never hit the element cache
 * and allocated an array proxy (plus an element proxy) per iteration.
 * 9.23.2 gives every object proxy the per-member cache the top-level scope
 * already had (`liveView.ts · cachedMember`); this bench is the checked-in
 * instrument that says by how much.
 *
 * What it measures, for N ∈ {1k, 10k}: a seed stage writing `k = { arr }`
 * with N object elements, then a read stage doing the loop THREE ways —
 * `s.k.arr[i].n` (re-reads `k.arr` every iteration), the hoisted
 * `const arr = s.k.arr` (one array proxy by construction, the element cache
 * alone), and `s.k.o.x` re-read N times (a nested OBJECT member). Reported:
 * the stage body alone (ms, median), so the engine's fixed per-run cost is
 * out of the picture.
 *
 * Two `readTracking` dials, because they measure different things. `'off'`
 * isolates the PROXY's cost — what this bench exists for. `'full'` (the
 * default) is what a stage actually pays: every `s.k` in the loop is a
 * tracked read, and `'full'` retains a `structuredClone` of `k` for each one
 * (`StageContext.getValue` · `retainedForm`) — ~0.25 ms per read at N = 1k,
 * ~2.5 ms at N = 10k, so the naive loop is O(N × |k|) under that dial
 * whatever the proxy does. It is measured at N = 1k only (N = 10k is ~25 s
 * per run) and printed beside `'off'` so the two costs are never confused:
 * hoist `s.k` out of the loop and the retention clone happens once.
 *
 * Run:  npx tsx bench/nested-reads.ts                 # current src
 *       npx tsx bench/nested-reads.ts --dist <root>   # a BUILT tree (its dist/esm)
 *       npx tsx bench/nested-reads.ts --sizes 1000    # only these N
 * The `--dist` form is how an older tag is measured side by side: build it in
 * a scratch copy and point here.
 */

export {}; // a module, so these names stay out of the bench folder's script scope

const SIZES = [1_000, 10_000];
const ROUNDS = 9;
const WARMUP = 2;
const FULL_TRACKING_UP_TO = 1_000; // the default dial clones `k` per `s.k` — O(N × |k|), ~25 s per run at 10k

type Tracking = 'off' | 'full';

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => { addFunction: any; build: () => any };
  FlowChartExecutor: new (chart: any, options?: any) => { run(): Promise<unknown> };
};

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const flag = process.argv.indexOf('--dist');
  if (flag !== -1 && process.argv[flag + 1]) {
    const root = process.argv[flag + 1].replace(/\/$/, ''); // absolute path of a built tree
    return { lib: (await import(`file://${root}/dist/esm/index.js`)) as Lib, label: root };
  }
  return { lib: (await import('../src/index')) as unknown as Lib, label: 'src' };
}

function sizes(): number[] {
  const flag = process.argv.indexOf('--sizes');
  return flag !== -1 && process.argv[flag + 1] ? process.argv[flag + 1].split(',').map(Number) : SIZES;
}

type Variant = 'reread' | 'hoisted' | 'object';

const LOOPS: Record<Variant, (scope: any, n: number) => number> = {
  // The naive loop: `s.k.arr` is resolved on every iteration.
  reread: (scope, n) => {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += scope.k.arr[i].n;
    return acc;
  },
  // The hoisted loop: one array proxy by construction; only the element cache is exercised.
  hoisted: (scope, n) => {
    const arr = scope.k.arr;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += arr[i].n;
    return acc;
  },
  // A nested OBJECT member re-read N times.
  object: (scope, n) => {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += scope.k.o.x;
    return acc;
  },
};

/** Seed + read chart. `body` receives the measured stage-body time. */
function buildChart(lib: Lib, n: number, variant: Variant, body: { ms: number; acc: number }) {
  const seed = (scope: any) => {
    scope.k = { arr: Array.from({ length: n }, (_, id) => ({ id, n: id % 3 })), o: { x: 1 } };
  };
  const read = (scope: any) => {
    const t0 = performance.now();
    body.acc = LOOPS[variant](scope, n);
    body.ms = performance.now() - t0;
  };
  return lib.flowChart('Seed', seed, 'seed').addFunction('Read', read, 'read').build();
}

async function once(lib: Lib, n: number, variant: Variant, readTracking: Tracking): Promise<number> {
  const body = { ms: 0, acc: 0 };
  const chart = buildChart(lib, n, variant, body);
  await new lib.FlowChartExecutor(chart, { readTracking }).run();
  const expected = variant === 'object' ? n : Array.from({ length: n }, (_, id) => id % 3).reduce((a, b) => a + b, 0);
  if (body.acc !== expected) throw new Error(`${variant} N=${n}: read ${body.acc}, expected ${expected}`);
  return body.ms;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(lib: Lib, n: number, variant: Variant, readTracking: Tracking): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await once(lib, n, variant, readTracking);
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i++) samples.push(await once(lib, n, variant, readTracking));
  return median(samples);
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(2)).padStart(8);

async function main() {
  const { lib, label } = await loadLib();
  console.log(`nested-reads [${label}] — N reads through a nested proxy in one stage (body ms, median of ${ROUNDS})`);
  console.log(
    `${'N'.padStart(6)} ${'tracking'.padEnd(8)} ${'reread'.padStart(8)} ${'hoisted'.padStart(8)} ${'object'.padStart(
      8,
    )}   reread/hoisted`,
  );
  for (const n of sizes()) {
    for (const tracking of ['off', 'full'] as const) {
      if (tracking === 'full' && n > FULL_TRACKING_UP_TO) continue;
      const reread = await measure(lib, n, 'reread', tracking);
      const hoisted = await measure(lib, n, 'hoisted', tracking);
      const object = await measure(lib, n, 'object', tracking);
      console.log(
        `${String(n).padStart(6)} ${tracking.padEnd(8)} ${fmt(reread)} ${fmt(hoisted)} ${fmt(object)}   ${(
          reread / hoisted
        ).toFixed(1)}×`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
