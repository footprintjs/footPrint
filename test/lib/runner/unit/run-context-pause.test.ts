/**
 * The short run form says when a run paused.
 *
 * `chart.run()`, `chart.recorder(r).run()` and `chart.redact(p).run()` build an executor, run it and hand back
 * a `RunResult`. They dropped the executor's own answer, so a run that PAUSED resolved exactly like a run that
 * finished: no flag, no checkpoint, and `output` was the output mapper applied to half-built state. The caller
 * could not tell that the stages after the pause never ran, and had no checkpoint to resume from.
 *
 * Now a paused run carries `paused: true` and the `checkpoint` (resumable on a `FlowChartExecutor` of the same
 * chart), and has no `output`: the chart has not produced one yet, so the mapper is not asked.
 */
import { describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

interface S {
  amount: number;
  approved?: boolean;
  receipt?: string;
}

function approvalChart(mapper = vi.fn((state: S) => ({ receipt: state.receipt }))) {
  const chart = flowChart<S>(
    'Seed',
    (s) => {
      s.amount = 1200;
    },
    'seed',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: (s) => (s.amount > 1000 ? { question: `approve ${s.amount}?` } : undefined),
        resume: (s, answer: { approved: boolean }) => {
          s.approved = answer.approved;
        },
      },
      'approve',
    )
    .addFunction(
      'Receipt',
      (s) => {
        s.receipt = s.approved ? 'paid' : 'refused';
      },
      'receipt',
    )
    .contract({ mapper } as never)
    .build();
  return { chart, mapper };
}

describe('the short run form — a run that paused', () => {
  it('chart.run() reports the pause and carries the checkpoint', async () => {
    const { chart } = approvalChart();
    const result = await chart.run();
    expect(result.paused).toBe(true);
    expect(result.checkpoint?.pausedStageId).toBe('approve');
    expect(result.checkpoint?.pauseData).toEqual({ question: 'approve 1200?' });
    // The state so far, and nothing from the stages that did not run.
    expect(result.state).toEqual({ amount: 1200 });
  });

  it('has no output, and does not ask the output mapper about half-built state', async () => {
    const { chart, mapper } = approvalChart();
    const result = await chart.run();
    expect(result.output).toBeUndefined();
    expect(mapper).not.toHaveBeenCalled();
  });

  it('a mapper that needs the finished state no longer turns a pause into a rejection', async () => {
    const { chart } = approvalChart(
      vi.fn((state: S) => {
        if (state.receipt === undefined) throw new Error('no receipt yet');
        return state.receipt;
      }),
    );
    await expect(chart.run()).resolves.toMatchObject({ paused: true });
  });

  it('the checkpoint resumes on an executor of the same chart', async () => {
    const { chart } = approvalChart();
    const paused = await chart.run();
    const executor = new FlowChartExecutor(chart);
    await executor.resume(paused.checkpoint!, { approved: true });
    expect(executor.getSnapshot().sharedState).toMatchObject({ amount: 1200, approved: true, receipt: 'paid' });
  });

  it.each([
    [
      'chart.recorder(r).run()',
      (chart: ReturnType<typeof approvalChart>['chart']) => chart.recorder({ id: 'r' } as never).run(),
    ],
    [
      'chart.redact(p).run()',
      (chart: ReturnType<typeof approvalChart>['chart']) => chart.redact({ keys: ['none'] }).run(),
    ],
  ])('%s reports it too', async (_name, run) => {
    const { chart } = approvalChart();
    const result = await run(chart);
    expect(result.paused).toBe(true);
    expect(result.checkpoint?.pausedStageId).toBe('approve');
    expect(result.output).toBeUndefined();
  });
});

describe('the short run form — a run that finished is unchanged', () => {
  it('has its output and no pause fields at all', async () => {
    const chart = flowChart<S>(
      'Seed',
      (s) => {
        s.amount = 5;
        s.receipt = 'paid';
      },
      'seed',
    )
      .contract({ mapper: (state: S) => ({ receipt: state.receipt }) } as never)
      .build();
    const result = await chart.run();
    expect(result.output).toEqual({ receipt: 'paid' });
    // The same keys in the same order as before, so a stored result reads the same.
    expect(Object.keys(result)).toEqual(['state', 'output', 'executionTree', 'commitLog']);
    expect(Object.hasOwn(result, 'paused')).toBe(false);
    expect(Object.hasOwn(result, 'checkpoint')).toBe(false);
  });

  it('a pausable stage that does not pause finishes the run', async () => {
    const chart = flowChart<S>(
      'Seed',
      (s) => {
        s.amount = 10;
      },
      'seed',
    )
      .addPausableFunction('Approve', { execute: () => undefined, resume: () => {} } as never, 'approve')
      .build();
    const result = await chart.run();
    expect(Object.hasOwn(result, 'paused')).toBe(false);
    expect(result.state).toEqual({ amount: 10 });
  });
});
