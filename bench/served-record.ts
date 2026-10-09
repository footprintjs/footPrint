/**
 * served-record — what serving the record costs (9.44.2).
 *
 * Why it exists: a commit bundle or fold base that holds a value `Object.freeze` cannot seal (a Date, a
 * Map, a buffer …) is served as a copy of its open paths on every `getSnapshot()` — the containers on
 * the way to each such value, mapped at the record's first serve (`capture/freeze.ts · serveRecord`);
 * one freezing sealed whole is served as itself. This bench is the instrument for both sides: a log of
 * N commits each writing a small JSON value, and the same log with a Date in every commit. `first ms`
 * is the first `getSnapshot()` (it maps the open paths), `snapshot ms` the median of the next 21;
 * `served copies` says how many bundles a snapshot copied.
 *
 * Run:  npx tsx bench/served-record.ts
 */

export {}; // a module, so these names stay out of the bench folder's script scope

const SIZES = [100, 1_000];
const ROUNDS = 21;

async function main() {
  const { flowChart, FlowChartExecutor } = (await import('../src/index')) as any;

  async function run(n: number, withDate: boolean) {
    let builder = flowChart('S0', (scope: any) => write(scope, 0), 's0');
    for (let i = 1; i < n; i++) builder = builder.addFunction(`S${i}`, (scope: any) => write(scope, i), `s${i}`);
    function write(scope: any, i: number) {
      scope.$setValue(`k${i}`, withDate ? { n: i, at: new Date(i) } : { n: i, at: i });
    }
    const executor = new FlowChartExecutor(builder.build());
    await executor.run();
    return executor;
  }

  console.log('served-record [src] — getSnapshot() over N commits (first, then median of 21)');
  console.log('     N  record              first ms   snapshot ms   served copies');
  for (const n of SIZES) {
    for (const withDate of [false, true]) {
      const executor = await run(n, withDate);
      const t = performance.now();
      const log = executor.getSnapshot().commitLog;
      const first = performance.now() - t;
      const again = executor.getSnapshot().commitLog;
      const copies = log.filter((bundle: unknown, i: number) => bundle !== again[i]).length;
      const times: number[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const t0 = performance.now();
        executor.getSnapshot();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const label = withDate ? 'a Date per commit' : 'JSON-shaped';
      console.log(
        `${String(n).padStart(6)}  ${label.padEnd(18)} ${first.toFixed(2).padStart(8)}   ${times[ROUNDS >> 1]
          .toFixed(2)
          .padStart(11)}   ${String(copies).padStart(13)}`,
      );
    }
  }
}

main();
