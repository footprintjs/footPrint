/**
 * mapper-reads — what a subflow mount costs on every pass of a loop, for the two things its mappers
 * can make expensive.
 *
 * Why it exists: a mapper's reads are recorded as reads of the mount (`engine/handlers/mapperScope.ts`).
 * Two decisions in that change were made by measuring, and this is the checked-in instrument for both:
 *
 *   1. A LARGE VALUE HANDED ON. Recording a read can keep a copy of the value (`readTracking: 'full'`),
 *      and a mount in a loop passes the same large value on at every pass. `StageContext · readLiveRoot`
 *      keeps a summary and never a copy: with a copy this loop ran 15 to 18% slower than before the
 *      reads were recorded; with a summary the difference is within the noise.
 *   2. A WIDE STATE, ONE KEY READ. What a mapper is handed must cost what it reads, not what the state
 *      holds. The first cut defined one accessor per root key for every mapper call: with 500 keys
 *      this loop ran 9 times slower although the mapper reads one key. The view is a proxy now.
 *   3. A WIDE STATE, ALL OF IT HANDED ON. The other side of 2: a mapper that spreads the state reads
 *      every key, and every read is recorded. This case says what that costs.
 *
 * Each chart: Seed writes the state; a subflow mount reads in its inputMapper and merges one small
 * value back; a decider loops back to the mount.
 *
 * Run:  npx tsx bench/mapper-reads.ts                  # current src
 *       npx tsx bench/mapper-reads.ts --root <path>    # another checkout's src (to compare)
 * Prints, per case, the median of 7 runs after one warm-up run, with the fastest and slowest.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const ROUNDS = 7;

interface Case {
  readonly name: string;
  readonly passes: number;
  /** What Seed writes beside the loop counter. */
  seed(state: any): void;
  /** What the mount hands its subflow: the reads this bench is about. */
  inputMapper(parent: any): Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: 'a list of 2,000 messages handed on',
    passes: 100,
    seed(state) {
      state.messages = Array.from({ length: 2_000 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `message ${i} ${'x'.repeat(80)}`,
      }));
    },
    inputMapper: (parent) => ({ history: parent.messages }),
  },
  {
    name: 'a state of 500 keys, one key read',
    passes: 200,
    seed(state) {
      for (let i = 0; i < 500; i++) state[`key${i}`] = i;
    },
    inputMapper: (parent) => ({ history: [parent.key7] }),
  },
  {
    // What recording costs when a mapper does read everything: 500 reads per call, each kept as a summary.
    name: 'a state of 500 keys, all of it handed on',
    passes: 200,
    seed(state) {
      for (let i = 0; i < 500; i++) state[`key${i}`] = i;
    },
    inputMapper: (parent) => ({ history: [{ ...parent }] }),
  },
];

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => any;
  FlowChartExecutor: new (chart: any) => { run(): Promise<unknown>; getSnapshot(): any };
};

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const flag = process.argv.indexOf('--root');
  if (flag !== -1 && process.argv[flag + 1]) {
    const root = process.argv[flag + 1].replace(/\/$/, '');
    return { lib: (await import(`${root}/src/index.ts`)) as Lib, label: root };
  }
  return { lib: (await import('../src/index')) as unknown as Lib, label: 'src' };
}

function buildChart(lib: Lib, each: Case) {
  const sub = lib
    .flowChart(
      'Call',
      (s) => {
        s.reply = `reply to ${(s.history as unknown[]).length} messages`;
      },
      'call',
    )
    .build();
  return lib
    .flowChart(
      'Seed',
      (s) => {
        each.seed(s);
        s.turn = 0;
      },
      'seed',
    )
    .addSubFlowChartNext('llm', sub, 'LLM', {
      inputMapper: each.inputMapper,
      outputMapper: (out: any) => ({ lastReply: out.reply }),
    })
    .addDeciderFunction(
      'Again',
      (s: any) => {
        s.turn += 1;
        return s.turn < each.passes ? 'more' : 'stop';
      },
      'again',
    )
    .addFunctionBranch('more', 'Back', () => undefined, 'go round again', { loopTo: 'llm' })
    .addFunctionBranch('stop', 'Done', () => undefined)
    .end()
    .build();
}

async function main() {
  const { lib, label } = await loadLib();
  for (const each of CASES) {
    const chart = buildChart(lib, each);
    const times: number[] = [];
    for (let round = 0; round <= ROUNDS; round++) {
      const executor = new lib.FlowChartExecutor(chart);
      const start = performance.now();
      await executor.run();
      const ms = performance.now() - start;
      if (executor.getSnapshot().sharedState.turn !== each.passes) throw new Error('the loop did not run every pass');
      if (round > 0) times.push(ms); // the first run warms up
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(
      `${label}: ${each.name}, ${each.passes} passes: median ${median.toFixed(1)} ms ` +
        `(fastest ${times[0].toFixed(1)}, slowest ${times[times.length - 1].toFixed(1)})`,
    );
  }
}

void main();
