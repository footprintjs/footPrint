/**
 * input-under-policy — what it costs a run that its stages ask for their input, under a redaction policy.
 *
 * Why it exists: what a stage takes from its input (`scope.$getArgs()`) keeps the policy's rule wherever
 * the stage writes it (`memory/hiddenObjectTrail.ts · rememberInput`). To know what the policy hides in
 * the input, the input is served once more by the rule that serves it (`memory/servedPlaces.ts`). That
 * is one walk of the input. Asked again for each stage, it would be paid once a stage, so the answer is
 * kept for the run. This is the checked-in instrument for both halves of that claim: the cost of the
 * one look, and that twenty stages cost what one does.
 *
 * Each chart: `stages` stages, each of which asks for the input and reads one number out of it. The
 * input holds `ROWS` records and one record under the name the policy hides. Two settings:
 *
 *   no policy   nothing is hidden: the input is never looked at
 *   policy      the policy hides `secret`: the input is served once more, for the first stage that asks
 *
 * Run:  node --import tsx bench/input-under-policy.ts                        # current src
 *       node --import tsx bench/input-under-policy.ts --root /abs/path/to/it  # another checkout's src
 * Prints, per chart and setting, the median of 7 runs after one warm-up run, with the fastest and slowest.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const ROUNDS = 7;
const ROWS = 200_000;
const STAGES = [1, 20];

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => any;
  FlowChartExecutor: new (chart: any, options?: object) => {
    run(options?: object): Promise<unknown>;
    getSnapshot(): any;
    setRedactionPolicy(policy: object): void;
  };
};

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const at = process.argv.indexOf('--root');
  const root = at !== -1 ? process.argv[at + 1]?.replace(/\/$/, '') : undefined;
  if (root) return { lib: (await import(`${root}/src/index.ts`)) as Lib, label: root };
  return { lib: (await import('../src/index')) as unknown as Lib, label: 'src' };
}

async function main() {
  const { lib, label } = await loadLib();
  console.log(`engine: ${label}, an input of ${ROWS.toLocaleString('en')} records`);
  const input = { rows: [...Array.from({ length: ROWS }, (_, i) => ({ i })), { secret: { token: 't' } }] };
  for (const stages of STAGES) {
    let builder = lib.flowChart('S0', (s: any) => (s.n = s.$getArgs().rows.length), 's0');
    for (let i = 1; i < stages; i++) {
      builder = builder.addFunction(`S${i}`, (s: any) => (s.n = s.$getArgs().rows.length + i), `s${i}`);
    }
    const chart = builder.build();
    for (const setting of ['no policy', 'policy'] as const) {
      const times: number[] = [];
      for (let round = 0; round <= ROUNDS; round++) {
        const executor = new lib.FlowChartExecutor(chart, { readTracking: 'off' });
        if (setting === 'policy') executor.setRedactionPolicy({ keys: ['secret'] });
        const start = performance.now();
        await executor.run({ input });
        const ms = performance.now() - start;
        if (executor.getSnapshot().sharedState.n !== ROWS + stages) throw new Error('the run did not finish');
        if (round > 0) times.push(ms); // the first run warms up
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      console.log(
        `${stages} stage${stages === 1 ? '' : 's'} asking for the input | ${setting}: ${median.toFixed(
          1,
        )} ms (${times[0].toFixed(1)} to ${times[times.length - 1].toFixed(1)})`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
