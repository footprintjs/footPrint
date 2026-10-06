/**
 * A stage's arrival is narrated ONCE. After `onResume` (the resumed stage) or a
 * flow-only `onLoop` (the loop target), the stage's own completion line does not
 * repeat "Next, it moved on to X." — the arrival sentence already said where the
 * run went. Pinned byte for byte, both narrators.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src';
import { flowChart, FlowChartExecutor, NarrativeFlowRecorder } from '../../../../src';

const ask: PausableHandler<any> = {
  execute: async () => ({ pause: true, data: { question: 'ok?' } }),
  resume: async (scope, input) => {
    scope.answer = input;
  },
};

function pausingChart() {
  return flowChart<any>(
    'Seed',
    (scope) => {
      scope.v = 1;
    },
    'seed',
  )
    .addPausableFunction('Ask', ask, 'ask')
    .addFunction(
      'Done',
      (scope) => {
        scope.v = 2;
      },
      'done',
    )
    .build();
}

function loopingChart() {
  return flowChart<any>(
    'Start',
    (scope) => {
      scope.n = 0;
    },
    'start',
  )
    .addFunction(
      'Work',
      (scope) => {
        scope.n += 1;
        if (scope.n >= 3) scope.$break();
      },
      'work',
    )
    .loopTo('work')
    .build();
}

describe('arrival is narrated once', () => {
  it('after a same-executor resume: combined and flow-only', async () => {
    const executor = new FlowChartExecutor(pausingChart());
    executor.enableNarrative();
    const flow = new NarrativeFlowRecorder('flow-only');
    executor.attachFlowRecorder(flow);
    await executor.run();
    await executor.resume(executor.getCheckpoint()!, { ok: true });

    expect(executor.getNarrativeEntries().map((entry) => entry.text)).toEqual([
      'Stage 1: The process began with Seed.',
      'Step 1: Write v = 1',
      'Execution paused at Ask.',
      'Execution resumed at Ask with input.',
      'Stage 2: It continued from the pause.',
      'Step 1: Write answer = {ok}',
      'Stage 3: Next, it moved on to Done.',
      'Step 1: Write v = 2',
    ]);
    expect(flow.getSentences()).toEqual([
      'Next, it moved on to Seed.',
      'Execution paused at Ask.',
      'Execution resumed at Ask with input.',
      'Next, it moved on to Done.',
    ]);
  });

  it('after a fresh-executor resume: the resumed stage is not announced as the beginning', async () => {
    const first = new FlowChartExecutor(pausingChart());
    await first.run();
    const resumed = new FlowChartExecutor(pausingChart());
    resumed.enableNarrative();
    await resumed.resume(first.getCheckpoint()!, { ok: true });

    expect(resumed.getNarrativeEntries().map((entry) => entry.text)).toEqual([
      'Execution resumed at Ask with input.',
      'Stage 1: It continued from the pause.',
      'Step 1: Write answer = {ok}',
      'Stage 2: Next, it moved on to Done.',
      'Step 1: Write v = 2',
    ]);
  });

  it('after a flow-only loop pass', async () => {
    const executor = new FlowChartExecutor(loopingChart());
    const flow = new NarrativeFlowRecorder('flow-only');
    executor.attachFlowRecorder(flow);
    await executor.run();

    expect(flow.getSentences()).toEqual([
      'Next, it moved on to Start.',
      'Next, it moved on to Work.',
      'On pass 1 through Work.',
      'On pass 2 through Work.',
      'Execution stopped at Work.',
    ]);
  });
});
