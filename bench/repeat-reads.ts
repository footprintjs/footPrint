/**
 * repeat-reads — what a stage pays for reading the SAME key many times.
 *
 * Why it exists: a tracked read retains what it read (`readTracking`): a copy of the value under
 * `'full'` (the default), a marker under `'summary'`. Up to 11.2.0 that was done at every read. A stage
 * that walks a list by index (`items[0]`, `items[1]`, …) therefore copied the whole list once per
 * element, and the cost grew with the square of the list. `memory/keptReads.ts` retains a read once
 * for each object a key holds, and a text is kept without a copy (`retainedValue · retainedForm`). This
 * is the checked-in instrument for both decisions, and for the numbers their comments quote.
 *
 * Each chart: Seed writes one value; one stage reads it `reads` times.
 *
 * Run:  npx tsx bench/repeat-reads.ts                  # current src
 *       npx tsx bench/repeat-reads.ts --root <path>    # another checkout's src (to compare)
 * Prints, per case and setting, the median of 7 runs after one warm-up run, with the fastest and slowest.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const ROUNDS = 7;

interface Case {
  readonly name: string;
  /** What Seed writes under `value`. */
  seed(): unknown;
  /** The stage under test: reads `scope.value` again and again. */
  stage(scope: any): void;
}

const records = (length: number) => Array.from({ length }, (_, id) => ({ id, text: `message number ${id}` }));
const walk = (length: number) => (scope: any) => {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += scope.value[i].id;
  scope.sum = sum;
};

const CASES: Case[] = [
  { name: 'a list of 1,000 records, read by index 1,000 times', seed: () => records(1_000), stage: walk(1_000) },
  { name: 'a list of 3,000 records, read by index 3,000 times', seed: () => records(3_000), stage: walk(3_000) },
  {
    // The control: one read, then plain JavaScript. What the walk above should cost.
    name: 'a list of 1,000 records, taken once into a variable',
    seed: () => records(1_000),
    stage(scope) {
      const list = scope.value;
      let sum = 0;
      for (let i = 0; i < 1_000; i++) sum += list[i].id;
      scope.sum = sum;
    },
  },
  {
    // A write at every step, to another key: the list is still the object it was.
    name: 'a list of 1,000 records, read by index, a counter written each time',
    seed: () => records(1_000),
    stage(scope) {
      scope.sum = 0;
      for (let i = 0; i < 1_000; i++) scope.sum += scope.value[i].id;
    },
  },
  {
    // NOT helped by the rule, and here so that nobody thinks it is: the stage writes the list it walks.
    // From its first write on it reads its own working copy, a new list after each write.
    name: 'a list of 1,000 records, each one marked through the scope (writes the key it reads)',
    seed: () => records(1_000),
    stage(scope) {
      for (let i = 0; i < 1_000; i++) scope.value[i].done = true;
      scope.sum = 1_000;
    },
  },
  {
    // The way out for that loop: one read, and the held list serves every index and every write.
    name: 'the same marking, the list taken once into a variable',
    seed: () => records(1_000),
    stage(scope) {
      const list = scope.value;
      for (let i = 0; i < 1_000; i++) list[i].done = true;
      scope.sum = 1_000;
    },
  },
  {
    // The other way out: one read and one write.
    name: 'the same marking as one write (the list mapped and assigned)',
    seed: () => records(1_000),
    stage(scope) {
      scope.value = scope.value.map((record: object) => ({ ...record, done: true }));
      scope.sum = 1_000;
    },
  },
  {
    name: 'an object of 5,000 keys, one field read 1,000 times',
    seed: () => Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i])),
    stage(scope) {
      let sum = 0;
      for (let i = 0; i < 1_000; i++) sum += scope.value.k7;
      scope.sum = sum;
    },
  },
  {
    name: 'a text of 1 MB, read 1,000 times',
    seed: () => 'x'.repeat(1_000_000),
    stage(scope) {
      let length = 0;
      for (let i = 0; i < 1_000; i++) length += scope.value.length;
      scope.sum = length;
    },
  },
];

/** What a recorded read keeps: the two settings that keep anything. */
const SETTINGS = ['full', 'summary'] as const;

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => any;
  FlowChartExecutor: new (chart: any, options?: object) => { run(): Promise<unknown>; getSnapshot(): any };
};

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const flag = process.argv.indexOf('--root');
  if (flag !== -1 && process.argv[flag + 1]) {
    const root = process.argv[flag + 1].replace(/\/$/, '');
    return { lib: (await import(`${root}/src/index.ts`)) as Lib, label: root };
  }
  return { lib: (await import('../src/index')) as unknown as Lib, label: 'src' };
}

async function main() {
  const { lib, label } = await loadLib();
  for (const each of CASES) {
    const chart = lib
      .flowChart(
        'Seed',
        (s) => {
          s.value = each.seed();
        },
        'seed',
      )
      .addFunction('Read', each.stage, 'read')
      .build();
    for (const readTracking of SETTINGS) {
      const times: number[] = [];
      for (let round = 0; round <= ROUNDS; round++) {
        const executor = new lib.FlowChartExecutor(chart, { readTracking });
        const start = performance.now();
        await executor.run();
        const ms = performance.now() - start;
        if (typeof executor.getSnapshot().sharedState.sum !== 'number') throw new Error('the stage did not finish');
        if (round > 0) times.push(ms); // the first run warms up
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      console.log(
        `${label}: ${each.name}, readTracking '${readTracking}': median ${median.toFixed(1)} ms ` +
          `(fastest ${times[0].toFixed(1)}, slowest ${times[times.length - 1].toFixed(1)})`,
      );
    }
  }
}

void main();
