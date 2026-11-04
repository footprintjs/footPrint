import { readFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type ScheduleSample, type ScheduleShape, sampleSchedule, scheduleShapes } from './fixtures/plainSchedule.js';

it.each(scheduleShapes)('scheduling %s keeps its pinned tick and all41offsets', async (shape) => {
  const expected = JSON.parse(
    readFileSync(new URL('./fixtures/plain-schedule-base-6d8.json', import.meta.url), 'utf8'),
  ) as Record<ScheduleShape, ScheduleSample>;
  // Owned-execute is unreleased: its real detach/dispose callbacks pin14, versus base13 (Claude N2 ruling).
  const admitted =
    shape === 'owned'
      ? (JSON.parse(
          readFileSync(new URL('./fixtures/owned-schedule-a24e.json', import.meta.url), 'utf8'),
        ) as ScheduleSample)
      : expected[shape];
  if (shape === 'owned') {
    expect(expected[shape].ticks).toBe(13);
    expect(admitted.ticks).toBe(14);
  }
  expect(admitted.table).toHaveLength(41);
  expect(new Set(admitted.table)).toEqual(new Set(['nested,sibling', 'sibling,nested']));
  for (const declared of [false, true]) {
    expect(await sampleSchedule(shape, declared)).toEqual(admitted);
  }
});

it.each([
  ['selector', 'stage'],
  ['selector', 'mount'],
  ['parallelForEach', 'stage'],
  ['parallelForEach', 'mount'],
] as const)('plain %s %s failFast keeps the unscoped sibling continuation', async (shape, continuation) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const after = vi.fn(() => 'after');
  const holding = flowChart(
    'hold',
    async () => {
      enter();
      await held;
    },
    'hold',
  );
  const slow =
    continuation === 'stage'
      ? holding.addFunction('after', after, 'after').build()
      : holding.addSubFlowChartNext('late', flowChart('after', after, 'after').build(), 'late').build();
  const failure = new Error('failFast');
  const fast = flowChart(
    'fail',
    async () => {
      await entered;
      throw failure;
    },
    'fail',
  ).build();
  const start = flowChart('parent', () => undefined, 'parent');
  const chart =
    shape === 'selector'
      ? start
          .addSelectorFunction('choose', () => ['fast', 'slow'], 'choose', undefined, { failFast: true })
          .addSubFlowChartBranch('fast', fast, 'fast')
          .addSubFlowChartBranch('slow', slow, 'slow')
          .end()
          .build()
      : start
          .addParallelForEach('each', 'each', {
            items: () => ['fast', 'slow'],
            branch: (name: string) => (name === 'fast' ? fast : slow),
            into: 'results',
            maxBranches: 2,
            failFast: true,
          })
          .build();
  await expect(new FlowChartExecutor(chart).run()).rejects.toBe(failure);
  release();
  for (let i = 0; i < 200; i++) await Promise.resolve();
  expect(after).toHaveBeenCalledOnce();
});

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
