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
 * Each chart: `stages` stages, each of which asks for the input and reads one number out of it. Two
 * inputs: 200,000 records with ONE record under the name the policy hides, and 20,000 records that EACH
 * hold a field of that name (a list of users, each with a password). The second is the one that
 * showed a cost growing with the square of the hidden places (2.6 s for one stage, 50 s for twenty,
 * before a rule's paths were read once and kept: `memory/selectedObjects.ts`). Two settings:
 *
 *   no policy   nothing is hidden: the input is never looked at
 *   policy      the policy hides `secret`: the input is served once more, for the first stage that asks,
 *               and every stage that asks remembers the hidden places
 *
 * Run:  node --import tsx bench/input-under-policy.ts                        # current src
 *       node --import tsx bench/input-under-policy.ts --root /abs/path/to/it  # another checkout's src
 * Prints, per chart and setting, the median of 7 runs after one warm-up run, with the fastest and slowest.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const ROUNDS = 7;
const STAGES = [1, 20];

interface Shape {
  readonly name: string;
  readonly rows: number;
  /** The records of the input: `rows` of them, and what the policy hides among them. */
  make(): unknown[];
}

const SHAPES: Shape[] = [
  {
    name: '200,000 records, one hidden place',
    rows: 200_001,
    make: () => [...Array.from({ length: 200_000 }, (_, i) => ({ i })), { secret: { token: 't' } }],
  },
  {
    name: '20,000 records, a hidden field on each',
    rows: 20_000,
    make: () => Array.from({ length: 20_000 }, (_, i) => ({ i, secret: { token: `t${i}` } })),
  },
];

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
  console.log(`engine: ${label}`);
  for (const shape of SHAPES) {
    const input = { rows: shape.make() };
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
          if (executor.getSnapshot().sharedState.n !== shape.rows + stages - 1)
            throw new Error('the run did not finish');
          if (round > 0) times.push(ms); // the first run warms up
        }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];
        const asking = `${stages} stage${stages === 1 ? '' : 's'} asking`;
        const range = `${times[0].toFixed(1)} to ${times[times.length - 1].toFixed(1)}`;
        console.log(`${shape.name} | ${asking} | ${setting}: ${median.toFixed(1)} ms (${range})`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
