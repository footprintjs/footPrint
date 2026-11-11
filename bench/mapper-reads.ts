/**
 * mapper-reads — what a subflow mount costs when its inputMapper hands a large value to the subflow,
 * on every pass of a loop.
 *
 * Why it exists: a mapper's reads are recorded as reads of the mount (`engine/handlers/mapperScope.ts`).
 * Recording a read can keep a copy of the value (`readTracking: 'full'`), and a mount in a loop passes
 * the same large value on at every pass. This bench is the checked-in instrument for the decision in
 * `StageContext · readForMapper` to keep a summary and never a copy: with a copy this loop ran 15 to
 * 18% slower than before the reads were recorded; with a summary the difference is within the noise.
 *
 * The chart: Seed writes MESSAGES chat messages; a subflow mount reads them in its inputMapper and
 * merges one small value back; a decider loops back to the mount PASSES times.
 *
 * Run:  npx tsx bench/mapper-reads.ts                  # current src
 *       npx tsx bench/mapper-reads.ts --root <path>    # another checkout's src (to compare)
 * Prints the median of 7 runs after one warm-up run, with the fastest and slowest.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const MESSAGES = 2_000;
const PASSES = 100;
const ROUNDS = 7;

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

function buildChart(lib: Lib) {
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
        s.messages = Array.from({ length: MESSAGES }, (_, i) => ({
          role: i % 2 ? 'assistant' : 'user',
          content: `message ${i} ${'x'.repeat(80)}`,
        }));
        s.turn = 0;
      },
      'seed',
    )
    .addSubFlowChartNext('llm', sub, 'LLM', {
      inputMapper: (s: any) => ({ history: s.messages }),
      outputMapper: (out: any) => ({ lastReply: out.reply }),
    })
    .addDeciderFunction(
      'Again',
      (s: any) => {
        s.turn += 1;
        return s.turn < PASSES ? 'more' : 'stop';
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
  const chart = buildChart(lib);
  const times: number[] = [];
  for (let round = 0; round <= ROUNDS; round++) {
    const executor = new lib.FlowChartExecutor(chart);
    const start = performance.now();
    await executor.run();
    const ms = performance.now() - start;
    if (executor.getSnapshot().sharedState.turn !== PASSES) throw new Error('the loop did not run every pass');
    if (round > 0) times.push(ms); // the first run warms up
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `${label}: ${MESSAGES} messages, ${PASSES} passes: median ${median.toFixed(1)} ms ` +
      `(fastest ${times[0].toFixed(1)}, slowest ${times[times.length - 1].toFixed(1)})`,
  );
}

void main();
