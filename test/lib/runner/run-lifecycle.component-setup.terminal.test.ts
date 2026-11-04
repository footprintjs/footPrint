import { expect, it } from 'vitest';

import {
  type FlowchartCheckpoint,
  type PausableHandler,
  type TypedScope,
  createRunLifecycle,
  flowChart,
  FlowChartExecutor,
} from '../../../src/index.js';

it('withdraws SAME continuation after a failed body but permits an explicitly saved FRESH checkpoint', async () => {
  const failure = new Error('body failed');
  const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
    execute: async () => ({ question: 'continue?' }),
    resume: async () => 'answer',
  };
  const ends: string[] = [];
  const owner = createRunLifecycle(flowChart('pause', handler, 'pause').build(), {
    runnerId: 'failed-pause',
    componentSetup: (component) => {
      component.onFinalize((end) => {
        ends.push(end.kind);
      });
      return {};
    },
  });
  owner.slot('component');
  let checkpoint!: FlowchartCheckpoint;
  await expect(
    owner.withRun(async (run) => {
      const result = await run.execute({ kind: 'run' });
      checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(owner.continuation()).toBeUndefined();
  expect(ends).toEqual(['failed']);
  await expect(
    owner.withRun((run) => run.execute({ kind: 'resume', mode: 'fresh', checkpoint, input: 'yes' })),
  ).resolves.toBe('answer');
});

it.each(['raw', 'owned', 'mount'] as const)('%s pause wins over cleanup failure and remains usable', async (shape) => {
  let failCleanup = true;
  const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
    execute: async () => ({ question: 'continue?' }),
    resume: async () => 'answer',
  };
  const child = flowChart('pause', handler, 'pause').build();
  const owner = createRunLifecycle(child, {
    runnerId: 'cleanup-pause',
    componentSetup: (component) => {
      component.onFinalize(() => {
        if (failCleanup) throw new Error('cleanup failed');
      });
      return {};
    },
  });
  owner.slot('component');
  const executor = new FlowChartExecutor(
    shape === 'mount'
      ? flowChart('parent', () => undefined, 'parent')
          .addSubFlowChartNext('child', child, 'child')
          .build()
      : child,
  );
  const run = shape === 'owned' ? owner.withRun((run) => run.execute({ kind: 'run' })) : executor.run();
  const result = await run;
  expect(result).toHaveProperty('paused', true);
  const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;
  failCleanup = false;
  const resumed =
    shape === 'owned'
      ? owner.withRun((run) => run.execute({ kind: 'resume', mode: 'fresh', checkpoint, input: 'yes' }))
      : executor.resume(checkpoint, 'yes');
  await expect(resumed).resolves.toBeDefined();
});

it('gives a raw completed cleanup rejection an honest unknown failure context', async () => {
  const failure = new Error('cleanup failed');
  const chart = flowChart('body', () => 'answer', 'body').build();
  const owner = createRunLifecycle(chart, {
    runnerId: 'cleanup-failure-context',
    componentSetup: (component) => {
      component.onFinalize(() => {
        throw failure;
      });
      return {};
    },
  });
  owner.slot('component');
  const executor = new FlowChartExecutor(chart);
  await expect(executor.run()).rejects.toBe(failure);
  expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
});

it('a foreign raw run does not freeze a lifecycle with no setup', async () => {
  const chart = flowChart('body', () => 'answer', 'body').build();
  const owner = createRunLifecycle(chart, { runnerId: 'no-setup' });
  owner.slot('component');
  await new FlowChartExecutor(chart).run();
  expect(() => owner.slot('leg')).not.toThrow();
});

it('keeps the native terminal kind immutable across cleanup callbacks', async () => {
  const observed: string[] = [];
  const owner = createRunLifecycle(flowChart('body', () => 'answer', 'body').build(), {
    runnerId: 'terminal-fact',
    componentSetup: (component) => {
      component.onFinalize((end) => {
        observed.push(end.kind);
      });
      component.onFinalize((end) => {
        Reflect.set(end, 'kind', 'failed');
      });
      return {};
    },
  });
  owner.slot('component');
  await owner.withRun((run) => run.execute({ kind: 'run' }));
  expect(observed).toEqual(['completed']);
});
