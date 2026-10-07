/**
 * The lean checkpoint (format 2): a pause leaves behind what a resume reads
 * and the pause's own record — so its size is the state's and the chart's,
 * never the run's length (`runner/checkpoint.ts`).
 *
 * - SIZE: for a fixed state size, the checkpoint is the same whether 3 or 40
 *   agent turns finished before the pause, and whether a finished subflow ran
 *   2 or 60 steps — the same text up to its numbers, so every extra byte is a
 *   digit of a counter (an execution index, a visit count). Format 1 failed
 *   both: its execution tree grew with every finished stage.
 * - WORK: a pause builds no snapshot — not one execution-tree node, however
 *   long the run. Format 1 built the root's whole tree, and one per subflow on
 *   the pause path, to carry one and throw the others away.
 * - SHAPE: exactly the lean fields, and a capture per subflow on the pause
 *   path — no other.
 *
 * Test type: boundary (size and work against run length).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowchartCheckpoint } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { StageContext } from '../../../src/lib/memory/StageContext.js';
import { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime.js';

const TOOL_BYTES = 2_000;
const MSG_BYTES = 200;
const WINDOW = 4;

const fixed = (text: string, bytes: number) => text.padEnd(bytes, '.').slice(0, bytes);
/** A number at a fixed width, so a padded text keeps one shape whatever the number. */
const n4 = (n: unknown) => String(n).padStart(4, '0');

/** The run's final question, two subflows down: [ask: Prepare → [approval: Review → Confirm ⏸] → Act]. */
function askTool() {
  const approval = flowChart<any>(
    'Review',
    (s) => {
      s.reviewed = fixed(`review for turn ${n4(s.turn)}`, MSG_BYTES);
    },
    'review',
  )
    .addPausableFunction(
      'Confirm',
      {
        execute: (s) => ({ question: `Run the action for turn ${n4(s.turn)}?` }),
        resume: (s, input) => {
          s.approved = (input as { approved: boolean }).approved;
        },
      },
      'confirm',
    )
    .build();
  return flowChart<any>(
    'Prepare',
    (s) => {
      s.raw = fixed(`raw action input for turn ${n4(s.turn)}`, TOOL_BYTES);
    },
    'prepare',
  )
    .addSubFlowChartNext('approval', approval, 'Approval', {
      inputMapper: (p: any) => ({ turn: p.turn }),
      outputMapper: (sf: any) => ({ approved: sf.approved }),
    })
    .addFunction(
      'Act',
      (s) => {
        s.result = { role: 'tool', content: fixed(`acted at turn ${n4(s.turn)}`, MSG_BYTES) };
      },
      'act',
    )
    .build();
}

/**
 * An agent run at the root: a warmup subflow loops `warmup` steps, then every
 * turn mounts an LLM-call subflow and a tool subflow with a LARGE raw result;
 * the conversation keeps a window of `WINDOW` messages (fixed-size state); the
 * last turn's tool asks.
 */
function agentChart(turns: number, warmup: number) {
  const llm = flowChart<any>(
    'Call model',
    (s) => {
      s.response = { role: 'assistant', content: fixed(`call a tool at turn ${n4(s.turn)}`, MSG_BYTES) };
    },
    'call-model',
  ).build();
  const tool = flowChart<any>(
    'Fetch',
    (s) => {
      s.raw = fixed(`raw tool output for turn ${n4(s.turn)}`, TOOL_BYTES);
      s.result = { role: 'tool', content: fixed(`summary for turn ${n4(s.turn)}`, MSG_BYTES) };
    },
    'fetch',
  ).build();
  const warm = flowChart<any>(
    'Step',
    (s) => {
      s.step = (s.step ?? 0) + 1;
      s.scratch = fixed(`warmup step ${n4(s.step)}`, MSG_BYTES);
    },
    'step',
  )
    .addDeciderFunction('More?', (s) => (s.step < warmup ? 'again' : 'done'), 'more')
    .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'step' })
    .addFunctionBranch('done', 'Done', () => undefined)
    .end()
    .build();

  return flowChart<any>(
    'Seed',
    (s) => {
      s.request = fixed('help me with the task', MSG_BYTES);
    },
    'seed',
  )
    .addSubFlowChartNext('warmup', warm, 'Warmup', {
      inputMapper: () => ({}),
      outputMapper: (sf: any) => ({ warmed: sf.step }),
    })
    .addFunction(
      'Think',
      (s) => {
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
      'Append',
      (s) => {
        s.history = [...s.history, s.lastResponse].slice(-WINDOW);
      },
      'append',
    )
    .addDeciderFunction('Route', (s) => (s.turn >= turns ? 'ask' : 'tool'), 'route')
    .addSubFlowChartBranch('tool', tool, 'Run tool', {
      inputMapper: (p: any) => ({ turn: p.turn }),
      outputMapper: (sf: any) => ({ lastTool: sf.result }),
    })
    .loopTo('think')
    .addSubFlowChartBranch('ask', askTool(), 'Ask tool', {
      inputMapper: (p: any) => ({ turn: p.turn }),
      outputMapper: (sf: any) => ({ lastTool: sf.result }),
    })
    .end()
    .build();
}

async function pauseOf(chart: ReturnType<typeof agentChart>): Promise<FlowchartCheckpoint> {
  const executor = new FlowChartExecutor(chart);
  const result = (await executor.run()) as { paused?: boolean };
  expect(result.paused).toBe(true);
  return executor.getCheckpoint()!;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** The checkpoint's text with every number written as `#` — what is left is everything but the counters. */
const withoutNumbers = (checkpoint: FlowchartCheckpoint) => JSON.stringify(checkpoint).replace(/\d+/g, '#');
const digitCount = (checkpoint: FlowchartCheckpoint) => JSON.stringify(checkpoint).replace(/\D/g, '').length;

/** Every byte the longer run adds is a digit: the same checkpoint, longer counters. */
function expectSameUpToCounters(short: FlowchartCheckpoint, long: FlowchartCheckpoint): void {
  expect(withoutNumbers(long)).toBe(withoutNumbers(short));
  expect(bytes(long) - bytes(short)).toBe(digitCount(long) - digitCount(short));
}

describe('the checkpoint size does not grow with the run (format 2)', () => {
  it('3 finished turns or 40: the same checkpoint up to its counters', async () => {
    const short = await pauseOf(agentChart(3, 2));
    const long = await pauseOf(agentChart(40, 2));
    expect(long.executionCount!).toBeGreaterThan(short.executionCount! * 5);
    expectSameUpToCounters(short, long);
  });

  it('a finished subflow of 2 steps or 60: the same checkpoint up to its counters', async () => {
    const short = await pauseOf(agentChart(3, 2));
    const long = await pauseOf(agentChart(3, 60));
    expect(long.executionCount! - short.executionCount!).toBeGreaterThan(100);
    expectSameUpToCounters(short, long);
  });

  it('is the state plus a bounded record', async () => {
    const checkpoint = await pauseOf(agentChart(40, 60));
    const state = bytes(checkpoint.sharedState) + bytes(checkpoint.subflowStates);
    // 40 turns of 2 KB tool results and 60 warmup steps finished; the checkpoint
    // is the window, the captured tool input and a record of about 1 KB.
    expect(state).toBeGreaterThan(TOOL_BYTES + WINDOW * MSG_BYTES);
    expect(bytes(checkpoint) - state).toBeLessThan(1_500);
  });
});

describe('the checkpoint shape (format 2)', () => {
  it('holds exactly the lean fields, and one capture per subflow on the pause path', async () => {
    const checkpoint = await pauseOf(agentChart(5, 3));
    expect(Object.keys(checkpoint)).toEqual([
      'checkpointVersion',
      'sharedState',
      'pausedStageId',
      'pausedExecution',
      'subflowPath',
      'pauseData',
      'subflowStates',
      'executionCount',
      'visitCounts',
      'invokerStageId',
      'pausedAt',
    ]);
    expect(checkpoint.checkpointVersion).toBe(2);
    expect(checkpoint.subflowPath).toEqual(['ask', 'ask/approval']);
    expect(Object.keys(checkpoint.subflowStates)).toEqual(['ask/approval', 'ask']);
    // The visit counts are one per stage id the run reached — the chart's size.
    expect(Object.keys(checkpoint.visitCounts!).length).toBeLessThan(20);
  });
});

describe('a pause builds no snapshot (format 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Seed → Think ⟲ `turns` → [ask: … → [approval: … → Confirm ⏸]] — no subflow finishes before the pause. */
  function loopThenAsk(turns: number) {
    return flowChart<any>(
      'Seed',
      (s) => {
        s.turn = 0;
      },
      'seed',
    )
      .addFunction(
        'Think',
        (s) => {
          s.turn += 1;
          s.note = fixed(`turn ${n4(s.turn)}`, MSG_BYTES);
        },
        'think',
      )
      .addDeciderFunction('Route', (s) => (s.turn >= turns ? 'ask' : 'again'), 'route')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'think' })
      .addSubFlowChartBranch('ask', askTool(), 'Ask tool', {
        inputMapper: (p: any) => ({ turn: p.turn }),
        outputMapper: (sf: any) => ({ lastTool: sf.result }),
      })
      .end()
      .build();
  }

  it.each([3, 40])('%i turns, then a pause two subflows down: no tree node, no runtime snapshot', async (turns) => {
    const treeNodes = vi.spyOn(StageContext.prototype, 'getSnapshot');
    const runtimeSnapshots = vi.spyOn(ExecutionRuntime.prototype, 'getSnapshot');
    const executor = new FlowChartExecutor(loopThenAsk(turns));
    await executor.run();
    expect(executor.getCheckpoint()?.subflowPath).toEqual(['ask', 'ask/approval']);
    expect(treeNodes).not.toHaveBeenCalled();
    expect(runtimeSnapshots).not.toHaveBeenCalled();
    // The record is still there, served by the snapshot.
    expect(executor.getSnapshot().commitLog.length).toBeGreaterThan(turns);
  });
});
