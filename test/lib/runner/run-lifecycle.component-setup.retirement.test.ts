import { readFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';

it('scheduling keeps plain and declared-no-setup runs at the measured base tick/table', async () => {
  const expected = JSON.parse(
    readFileSync(new URL('./fixtures/plain-schedule-base-6d8.json', import.meta.url), 'utf8'),
  ) as { ticks: number; table: string[] };
  expect(expected.table).toHaveLength(41);
  expect(expected.table.every((row) => row === 'nested,sibling' || row === 'sibling,nested')).toBe(true);
  for (const declared of [false, true]) {
    const leaf = flowChart('leaf', () => 'answer', 'leaf').build();
    const retained = createRunLifecycle(leaf, { runnerId: 'schedule-leaf' });
    if (declared) retained.slot('component');
    let ticks = 0;
    let done = false;
    const run = new FlowChartExecutor(leaf).run().then(() => {
      done = true;
    });
    // eslint-disable-next-line no-unmodified-loop-condition -- the run promise changes done.
    while (!done && ticks < 100) {
      ticks++;
      await Promise.resolve();
    }
    await run;
    expect.soft(ticks).toBe(expected.ticks);
    const table: string[] = [];
    for (let offset = 0; offset <= 40; offset++) {
      const order: string[] = [];
      const chart = flowChart('start', () => undefined, 'start')
        .addSelectorFunction('fork', () => ['nested', 'sibling'], 'fork')
        .addFunctionBranch('nested', 'nested', async () => {
          await new FlowChartExecutor(leaf).run();
          order.push('nested');
        })
        .addFunctionBranch('sibling', 'sibling', async () => {
          for (let i = 0; i < offset; i++) await Promise.resolve();
          order.push('sibling');
        })
        .end()
        .build();
      await new FlowChartExecutor(chart).run();
      table.push(order.join(','));
    }
    expect.soft(table).toEqual(expected.table);
    expect(retained).toBeDefined();
  }
});

it('scheduling a declared mount without setup agrees with the plain mount at all41offsets', async () => {
  const table = async (declare: boolean): Promise<string[]> => {
    const rows: string[] = [];
    for (let offset = 0; offset <= 40; offset++) {
      const order: string[] = [];
      const leaf = flowChart('leaf', () => undefined, 'leaf').build();
      const owner = createRunLifecycle(leaf, { runnerId: 'mounted-schedule' });
      if (declare) owner.slot('component');
      const left = flowChart('before', () => undefined, 'before')
        .addSubFlowChartNext('leaf', leaf, 'leaf')
        .addFunction(
          'done',
          () => {
            order.push('left');
          },
          'done',
        )
        .build();
      const right = flowChart(
        'wait',
        async () => {
          for (let i = 0; i < offset; i++) await Promise.resolve();
        },
        'wait',
      )
        .addSubFlowChartNext('plain', flowChart('plain', () => undefined, 'plain').build(), 'plain')
        .addFunction(
          'done',
          () => {
            order.push('right');
          },
          'done',
        )
        .build();
      const chart = flowChart('start', () => undefined, 'start')
        .addSelectorFunction('fork', () => ['left', 'right'], 'fork')
        .addSubFlowChartBranch('left', left, 'left')
        .addSubFlowChartBranch('right', right, 'right')
        .end()
        .build();
      await new FlowChartExecutor(chart).run();
      rows.push(order.join(','));
      expect(owner).toBeDefined();
    }
    return rows;
  };
  expect(await table(true)).toEqual(await table(false));
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
