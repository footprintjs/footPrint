/**
 * checkpoint-size — what a PAUSE leaves behind, field by field, as an agent
 * run grows.
 *
 * Why it exists: a pause checkpoint is persisted (Redis, Postgres, a file) and
 * read back by `resume()`. Format 1 carried the run's whole execution tree and
 * the finished subflows' results — neither read by a resume — so its size grew
 * with every finished iteration while the state a resume needs stayed small.
 * This bench is the instrument that says, in BYTES, what a checkpoint holds.
 *
 * The chart is agent-shaped: the loop runs at the ROOT (an agent run is the
 * executor's own chart), each turn mounts an LLM-call subflow and a tool
 * subflow whose raw result is LARGE, the conversation is a bounded window (so
 * the state is fixed-size), a warmup subflow loops before the agent starts,
 * and the last turn's tool asks a person from TWO subflows down:
 *
 *   Seed → [warmup: Step ⟲] → Think → [llm] → Append → Route ─┬─ tool → [tool] ⟲ Think
 *                                                             └─ ask → [ask: Prepare → [approval: Review → Confirm ⏸] → Act]
 *
 * Per row: the checkpoint's JSON bytes, total and per field, at
 * TURNS = 15 / 60 / 240. A lean checkpoint is the same size on every row.
 *
 * Run:  npx tsx bench/checkpoint-size.ts                 # this tree's src
 *       npx tsx bench/checkpoint-size.ts --src <root>    # another tree's src (e.g. a 9.43.0 checkout)
 */

export {}; // a module

const TURNS = [15, 60, 240];
const TOOL_BYTES = 40_000; // one tool's raw result
const MSG_BYTES = 4_000; // one conversation message
const WINDOW = 20; // messages the conversation keeps
const WARMUP_STEPS = 30;

type Lib = {
  flowChart: (name: string, fn: (scope: any) => unknown, id: string) => any;
  FlowChartExecutor: new (chart: unknown) => {
    run(): Promise<unknown>;
    getCheckpoint(): Record<string, unknown> | undefined;
  };
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const fixed = (text: string, bytes: number) => text.padEnd(bytes, '.').slice(0, bytes);
const bytesOf = (value: unknown) => (value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length);

function agentChart(lib: Lib, turns: number) {
  const { flowChart } = lib;
  const llm = flowChart(
    'Build prompt',
    (s) => {
      s.prompt = (s.messages as { role: string }[]).map((m) => m.role).join(',');
    },
    'build-prompt',
  )
    .addFunction(
      'Call model',
      (s: any) => {
        s.response = { role: 'assistant', content: fixed(`call a tool at turn ${s.turn}`, MSG_BYTES) };
      },
      'call-model',
    )
    .build();
  const tool = flowChart(
    'Fetch',
    (s) => {
      s.raw = fixed(`raw tool output for turn ${s.turn}`, TOOL_BYTES);
    },
    'fetch',
  )
    .addFunction(
      'Summarize',
      (s: any) => {
        s.result = { role: 'tool', content: fixed(`summary of ${String(s.raw).slice(0, 40)}`, MSG_BYTES) };
      },
      'summarize',
    )
    .build();
  const approval = flowChart(
    'Review',
    (s) => {
      s.reviewed = fixed(`review for turn ${s.turn}`, MSG_BYTES);
    },
    'review',
  )
    .addPausableFunction(
      'Confirm',
      {
        execute: (s: any) => ({ question: `Run the action for turn ${s.turn}?` }),
        resume: (s: any, input: { approved: boolean }) => {
          s.approved = input.approved;
        },
      },
      'confirm',
    )
    .build();
  const askTool = flowChart(
    'Prepare',
    (s) => {
      s.raw = fixed(`raw action input for turn ${s.turn}`, TOOL_BYTES);
    },
    'prepare',
  )
    .addSubFlowChartNext('approval', approval, 'Approval', {
      inputMapper: (p: any) => ({ turn: p.turn }),
      outputMapper: (sf: any) => ({ approved: sf.approved }),
    })
    .addFunction(
      'Act',
      (s: any) => {
        s.result = { role: 'tool', content: fixed(`acted at turn ${s.turn} approved=${s.approved}`, MSG_BYTES) };
      },
      'act',
    )
    .build();
  const warmup = flowChart(
    'Step',
    (s) => {
      s.step = (s.step ?? 0) + 1;
      s.scratch = fixed(`warmup step ${s.step}`, MSG_BYTES);
    },
    'step',
  )
    .addDeciderFunction('More?', (s: any) => (s.step < WARMUP_STEPS ? 'again' : 'done'), 'more')
    .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'step' })
    .addFunctionBranch('done', 'Done', () => undefined)
    .end()
    .build();

  return flowChart(
    'Seed',
    (s) => {
      s.request = fixed('help me with the task', 200);
    },
    'seed',
  )
    .addSubFlowChartNext('warmup', warmup, 'Warmup', {
      inputMapper: () => ({}),
      outputMapper: (sf: any) => ({ warmed: sf.step }),
    })
    .addFunction(
      'Think',
      (s: any) => {
        s.turn = (s.turn ?? 0) + 1;
        if (!s.history) s.history = [{ role: 'user', content: s.request }];
        if (s.lastTool) s.history = [...s.history, s.lastTool].slice(-WINDOW);
      },
      'think',
    )
    .addSubFlowChartNext('llm', llm, 'LLM call', {
      inputMapper: (p: any) => ({ messages: p.history, turn: p.turn }),
      outputMapper: (sf: any) => ({ lastResponse: sf.response }),
    })
    .addFunction(
      'Append response',
      (s: any) => {
        s.history = [...s.history, s.lastResponse].slice(-WINDOW);
      },
      'append-response',
    )
    .addDeciderFunction('Route', (s: any) => (s.turn >= turns ? 'ask' : 'tool'), 'route')
    .addSubFlowChartBranch('tool', tool, 'Run tool', {
      inputMapper: (p: any) => ({ turn: p.turn }),
      outputMapper: (sf: any) => ({ lastTool: sf.result }),
    })
    .loopTo('think')
    .addSubFlowChartBranch('ask', askTool, 'Ask tool', {
      inputMapper: (p: any) => ({ turn: p.turn }),
      outputMapper: (sf: any) => ({ lastTool: sf.result }),
    })
    .end()
    .build();
}

async function main() {
  const root = (arg('--src') ?? `${__dirname}/..`).replace(/\/$/, '');
  const lib = (await import(`${root}/src/index.ts`)) as unknown as Lib;
  console.log(`checkpoint-size — ${root}/src`);
  console.log(
    `tool result ${TOOL_BYTES} B · message ${MSG_BYTES} B · window ${WINDOW} · warmup ${WARMUP_STEPS} steps\n`,
  );

  const fields = new Map<string, number[]>();
  const totals: number[] = [];
  for (const turns of TURNS) {
    const executor = new lib.FlowChartExecutor(agentChart(lib, turns));
    await executor.run();
    const checkpoint = executor.getCheckpoint();
    if (!checkpoint) throw new Error(`turns=${turns}: the run did not pause`);
    totals.push(bytesOf(checkpoint));
    for (const [field, value] of Object.entries(checkpoint)) {
      if (!fields.has(field))
        fields.set(
          field,
          TURNS.map(() => 0),
        );
      fields.get(field)![totals.length - 1] = bytesOf(value);
    }
  }

  const cell = (n: number) => String(n).padStart(12);
  console.log(`${'field'.padEnd(18)}${TURNS.map((t) => `${t} turns`.padStart(12)).join('')}`);
  const rows = [...fields].sort((a, b) => b[1][1]! - a[1][1]!);
  for (const [field, sizes] of rows) console.log(`${field.padEnd(18)}${sizes.map(cell).join('')}`);
  console.log(`${'TOTAL (bytes)'.padEnd(18)}${totals.map(cell).join('')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
