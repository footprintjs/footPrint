import { expect, it, vi } from 'vitest';

import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';

it('does not invoke a new component setup after a failFast leg has retired', async () => {
  let enter!: () => void, release!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const setup = vi.fn(() => ({}));
  const lateBody = vi.fn(() => 'late-body');
  const late = flowChart('late', lateBody, 'late').build();
  const lateOwner = createRunLifecycle(late, { runnerId: 'late', componentSetup: setup });
  lateOwner.slot('component');
  const slow = flowChart(
    'hold',
    async () => {
      enter();
      await released;
      return 'held';
    },
    'hold',
  )
    .addSubFlowChartNext('late', late, 'late')
    .build();
  const slowOwner = createRunLifecycle(slow, {
    runnerId: 'slow',
    componentSetup: (component) => {
      component.onFinalize(() => {
        finish();
      });
      return {};
    },
  });
  slowOwner.slot('component');
  const failure = new Error('first-child-failure');
  const fast = flowChart(
    'fail',
    async () => {
      await entered;
      throw failure;
    },
    'fail',
  ).build();
  const parent = flowChart('parent', () => undefined, 'parent')
    .addSelectorFunction('choose', () => ['fast', 'slow'], 'choose', undefined, { failFast: true })
    .addSubFlowChartBranch('fast', fast, 'fast')
    .addSubFlowChartBranch('slow', slow, 'slow')
    .end()
    .build();
  try {
    await expect(new FlowChartExecutor(parent).run()).rejects.toBe(failure);
    expect(setup).not.toHaveBeenCalled();
  } finally {
    release();
    await finished;
  }
  expect(setup).not.toHaveBeenCalled();
  expect(lateBody).not.toHaveBeenCalled();
});
