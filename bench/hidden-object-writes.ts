/**
 * hidden-object-writes — what a stage pays, at each write, for having read a hidden object.
 *
 * Why it exists: an object a stage read under a hidden name keeps its rule wherever the stage puts it
 * (`memory/selectedObjects.ts`). To know that, every later write of that stage is searched for the
 * object. A write through the typed scope hands the frame the whole next value of a key, so a naive
 * search of a list at every `push` would cost the square of the list. The search skips every part
 * that is the same object as before the write, which leaves one comparison for each item of a list.
 * This is the checked-in instrument for that claim and for the numbers the file's comment quotes.
 *
 * Each chart: Seed writes a hidden record, an empty list, a list of `rows` records and a hidden list of
 * as many; one stage does the writes. Three settings for each case:
 *
 *   no policy            nothing is hidden: the search is never asked
 *   policy, not read     a policy hides `secret`, the stage does not read it: the search is never asked
 *   policy, read         the stage reads `secret` first: every write after it is searched
 *
 * The difference between the last two is the cost. `readTracking` is `'off'` unless `--tracking` says
 * otherwise, so that the copy a tracked read keeps does not drown the number.
 *
 * Run:  node --import tsx bench/hidden-object-writes.ts                        # current src
 *       node --import tsx bench/hidden-object-writes.ts --root /abs/path/to/it  # another checkout's src,
 *                                                     to compare (an ABSOLUTE path: a relative one is
 *                                                     read against this folder, not the one you are in)
 *       node --import tsx bench/hidden-object-writes.ts --tracking full        # with the default read tracking
 * Prints, per case and setting, the median of 7 runs after one warm-up run, with the fastest and slowest.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const ROUNDS = 7;
const ROWS = 10_000;

interface Case {
  readonly name: string;
  /** The writes under test. `scope.list` starts empty, `scope.rows` holds `ROWS` records. */
  stage(scope: any): void;
}

const CASES: Case[] = [
  {
    name: `${ROWS.toLocaleString('en')} records pushed onto a list, one by one`,
    stage(scope) {
      const list = scope.list;
      for (let i = 0; i < ROWS; i++) list.push({ id: i });
    },
  },
  {
    name: `${ROWS.toLocaleString('en')} records put at the front of a list, one by one`,
    stage(scope) {
      const list = scope.list;
      for (let i = 0; i < ROWS; i++) list.unshift({ id: i });
    },
  },
  {
    name: `one field set on each of ${ROWS.toLocaleString('en')} records of a list`,
    stage(scope) {
      const rows = scope.rows;
      for (let i = 0; i < ROWS; i++) rows[i].done = true;
    },
  },
  {
    // No write of the list at all: what the first read of a large hidden value costs (it is remembered
    // with every record inside it). `hiddenRows` is hidden by the policy; without one it is a plain read.
    name: `a hidden list of ${ROWS.toLocaleString('en')} records, read once and counted`,
    stage(scope) {
      scope.count = scope.hiddenRows.length;
    },
  },
  {
    // The old value of a key, nested one level down under its new value, again and again. Each write
    // holds the whole chain so far; only the top of it is new. The old value is not walked when it moves
    // (`selectedObjects.ts`, why), so this must cost the same with and without a hidden read.
    name: 'a key that nests its old value under its new one, 1,000 times',
    stage(scope) {
      scope.history = { depth: 0 };
      for (let i = 1; i <= 1_000; i++) scope.history = { prev: scope.$getValue('history'), depth: i };
    },
  },
  {
    // Every record of the new list is a new object: each is looked at, and noted as shown. The set of
    // what the key showed is started over at each of these writes, or it would grow to a million entries.
    name: 'the same list assigned whole, 100 times',
    stage(scope) {
      for (let i = 0; i < 100; i++) scope.rows = scope.rows.map((row: object) => ({ ...row, round: i }));
    },
  },
];

const SETTINGS = ['no policy', 'policy, not read', 'policy, read'] as const;

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => any;
  FlowChartExecutor: new (chart: any, options?: object) => {
    run(): Promise<unknown>;
    getSnapshot(): any;
    setRedactionPolicy(policy: object): void;
  };
};

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : undefined;
}

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const root = flag('--root')?.replace(/\/$/, '');
  if (root) return { lib: (await import(`${root}/src/index.ts`)) as Lib, label: root };
  return { lib: (await import('../src/index')) as unknown as Lib, label: 'src' };
}

async function main() {
  const { lib, label } = await loadLib();
  const readTracking = flag('--tracking') ?? 'off';
  console.log(`engine: ${label}, readTracking: ${readTracking}`);
  for (const each of CASES) {
    for (const setting of SETTINGS) {
      const chart = lib
        .flowChart(
          'Seed',
          (s) => {
            s.secret = { token: 'hidden' };
            s.list = [];
            s.rows = Array.from({ length: ROWS }, (_, id) => ({ id }));
            s.hiddenRows = Array.from({ length: ROWS }, (_, id) => ({ id, token: `t${id}` }));
          },
          'seed',
        )
        .addFunction(
          'Write',
          (s: any) => {
            if (setting === 'policy, read') s.seen = typeof s.secret.token;
            each.stage(s);
            s.done = true;
          },
          'write',
        )
        .build();
      const times: number[] = [];
      for (let round = 0; round <= ROUNDS; round++) {
        const executor = new lib.FlowChartExecutor(chart, { readTracking });
        if (setting !== 'no policy') executor.setRedactionPolicy({ keys: ['secret', 'hiddenRows'] });
        const start = performance.now();
        await executor.run();
        const ms = performance.now() - start;
        if (executor.getSnapshot().sharedState.done !== true) throw new Error('the stage did not finish');
        if (round > 0) times.push(ms); // the first run warms up
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      console.log(
        `${each.name} | ${setting}: ${median.toFixed(1)} ms (${times[0].toFixed(1)} to ${times[
          times.length - 1
        ].toFixed(1)})`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
