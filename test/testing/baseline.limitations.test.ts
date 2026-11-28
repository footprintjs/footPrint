import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../src/index.js';
import { drive } from '../lib/pause/resume-real-chart-fixture.js';
import { askChart, describeError, jsonCheckpoint, report, type State } from './baseline.fixtures.js';

describe.each(['same', 'fresh'] as const)('native limitation observations: %s executor', (mode) => {
  it.each(['lazy-subflow', 'parallel-for-each'] as const)(
    '%s pause records the actual native resume refusal',
    async (kind) => {
      const start = flowChart<State>('Seed', () => undefined, 'seed');
      const chart =
        kind === 'lazy-subflow'
          ? start.addLazySubFlowChartNext('lazy', askChart, 'Lazy').build()
          : start
              .addParallelForEach('Each', 'each', {
                items: () => ['one'],
                branch: () => askChart(),
                maxBranches: 1,
                into: 'results',
              })
              .build();
      const first = new FlowChartExecutor(chart);
      await first.run();
      const checkpoint = jsonCheckpoint(first);
      const resumed = mode === 'same' ? first : new FlowChartExecutor(chart);
      let failure: unknown;
      try {
        await resumed.resume(checkpoint, true);
      } catch (error) {
        failure = error;
      }
      report('limit.' + kind + '.' + mode, 'native-limitation', {
        pausedStageId: checkpoint.pausedStageId,
        subflowPath: checkpoint.subflowPath,
        failure: describeError(failure),
      });
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Cannot resume: stage.*not found/);
    },
  );

  it('records the dispatcher namespace of a resumed selected branch without calling it parity', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addSelectorFunction('Pick', () => ['review'], 'pick')
      .addPausableFunctionBranch('review', 'Review', {
        execute: (s: State) => {
          s.before = true;
          return { question: 'q' };
        },
        resume: (s: State) => {
          s.after = true;
        },
      })
      .end()
      .build();
    const run = await drive(chart, mode === 'same' ? 'same' : 'cross');
    const branches = run.state.runs as Record<string, Record<string, unknown>>;
    report('limit.namespace.' + mode, 'native-limitation', { state: run.state, paused: run.executor.isPaused() });
    expect(branches.review.before).toBe(true);
    expect(run.state.after).toBe(true);
    expect(branches.review.after).toBeUndefined();
  });

  it('records actual resumed-child failure and reports its state surfaces', async () => {
    const original = new Error('controlled resumed child failure');
    const child = flowChart<State>('Start', () => undefined, 'start')
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: State) => {
            s.beforeFailure = true;
            throw original;
          },
        },
        'ask',
      )
      .build();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addSubFlowChart('child', child, 'Child')
      .addFunction(
        'Join',
        (s) => {
          s.joined = true;
        },
        'join',
      )
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = jsonCheckpoint(first);
    const resumed = mode === 'same' ? first : new FlowChartExecutor(chart);
    let failure: unknown;
    try {
      await resumed.resume(checkpoint, true);
    } catch (error) {
      failure = error;
    }
    report('limit.failure.' + mode, 'native-limitation', {
      sameError: failure === original,
      failure: describeError(failure),
      state: resumed.getSnapshot().sharedState,
      subflows: resumed.getSnapshot().subflowResults,
    });
    expect(failure).toBe(original);
    expect(resumed.getSnapshot().sharedState.joined).toBeUndefined();
  });
});

it('keeps controlled pending work unknown until actual signal cancellation settles it', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const cancellation = new Error('controlled cancellation');
  const chart = flowChart<State>(
    'Wait',
    async (s) => {
      s.beforeWait = true;
      enter();
      await held;
      controller.signal.throwIfAborted();
    },
    'wait',
  ).build();
  const executor = new FlowChartExecutor(chart);
  let settled = false;
  const running = executor
    .run({ signal: controller.signal })
    .then(
      () => ({ kind: 'completed' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
    .finally(() => {
      settled = true;
    });
  await entered;
  report('terminal.pending', 'unknown', { settled });
  expect(settled).toBe(false);
  controller.abort(cancellation);
  release();
  const outcome = await running;
  report('terminal.cancelled', 'observation', {
    kind: outcome.kind,
    failure: outcome.kind === 'rejected' ? describeError(outcome.error) : null,
    state: executor.getSnapshot().sharedState,
  });
  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') expect(outcome.error).toBe(cancellation);
  expect(settled).toBe(true);
});

it('preserves an ordinary stage failure and commits its preceding write', async () => {
  const original = new Error('controlled stage failure');
  const chart = flowChart<State>(
    'Fail',
    (s) => {
      s.beforeFailure = true;
      throw original;
    },
    'fail',
  ).build();
  const executor = new FlowChartExecutor(chart);
  let failure: unknown;
  try {
    await executor.run();
  } catch (error) {
    failure = error;
  }
  const state = executor.getSnapshot().sharedState;
  report('terminal.failed', 'observation', { sameError: failure === original, failure: describeError(failure), state });
  expect(failure).toBe(original);
  expect(state.beforeFailure).toBe(true);
});
