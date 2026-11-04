import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowchartCheckpoint, PausableHandler, RunSlot, TypedScope } from '../../../src/index.js';
import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['resume', { maxDepth: 0 }],
  ['resume', { maxIterations: 0 }],
  ['run', { maxDepth: 0 }],
  ['run', { maxIterations: 0 }],
] as const)(
  '%s option refusal leaves a fresh executor able to restore checkpoint state (%j)',
  async (entry, options) => {
    const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
      execute: async () => ({ question: 'continue?' }),
      resume: async (scope) => {
        scope.after = 1;
      },
    };
    const chart = flowChart(
      'seed',
      (scope) => {
        scope.kept = 'yes';
      },
      'seed',
    )
      .addPausableFunction('pause', handler, 'pause')
      .build();
    const paused = new FlowChartExecutor(chart);
    await paused.run();
    const checkpoint = paused.getCheckpoint()!;
    const retry = new FlowChartExecutor(chart);
    const control = new FlowChartExecutor(chart);
    await expect(entry === 'run' ? retry.run(options) : retry.resume(checkpoint, 'yes', options)).rejects.toThrow(
      /max(?:Depth|Iterations) must be >= 1/,
    );
    await retry.resume(checkpoint, 'yes');
    await control.resume(checkpoint, 'yes');
    expect(retry.getSnapshot().sharedState).toEqual(control.getSnapshot().sharedState);
    expect(retry.getSnapshot().sharedState).toEqual({ kept: 'yes', after: 1 });
  },
);

it.each(['fresh resume', 'same resume', 'same run'] as const)(
  '%s setup refusal retains the checkpoint and seeded state for retry',
  async (shape) => {
    let refuse = false;
    const failure = new Error('setup refused once');
    const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
      execute: async () => ({ question: 'continue?' }),
      resume: async (scope) => {
        scope.after = 1;
      },
    };
    const chart = flowChart(
      'seed',
      (scope) => {
        scope.kept = 'yes';
      },
      'seed',
    )
      .addPausableFunction('pause', handler, 'pause')
      .build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'setup-retry',
      componentSetup: () => {
        if (refuse) {
          refuse = false;
          throw failure;
        }
        return {};
      },
    });
    owner.slot('component');
    const original = new FlowChartExecutor(chart);
    await original.run();
    const checkpoint = original.getCheckpoint()!;
    const executor = shape === 'fresh resume' ? new FlowChartExecutor(chart) : original;
    const before = executor.getCheckpoint();
    refuse = true;
    await expect(shape === 'same run' ? executor.run() : executor.resume(checkpoint, 'yes')).rejects.toBe(failure);
    expect(executor.getCheckpoint()).toEqual(before);
    await executor.resume(checkpoint, 'yes');
    expect(executor.getSnapshot().sharedState).toEqual({ kept: 'yes', after: 1 });
  },
);

function pausingChart() {
  const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
    execute: async () => ({ question: 'continue?' }),
    resume: async () => 'answer',
  };
  return flowChart('pause', handler, 'pause').build();
}

describe('component observations and finalization over native resume', () => {
  it.each(['same', 'fresh'] as const)(
    'routes executor-made resume only to the admitted root on %s restore',
    async (mode) => {
      const observations: string[][] = [];
      const ends: string[] = [];
      const chart = pausingChart();
      const owner = createRunLifecycle(chart, {
        runnerId: 'resume-observer',
        componentSetup: (component) => {
          const events: string[] = [];
          observations.push(events);
          component.onFinalize((end) => {
            ends.push(end.kind);
          });
          return { recorder: { id: 'same-recorder-id', onResume: (event) => events.push(String(event.channel)) } };
        },
      });
      owner.slot('component');
      await owner.withRun((run) => run.execute({ kind: 'run' }));
      const continuation = owner.continuation()!;
      const checkpoint = JSON.parse(JSON.stringify(continuation.checkpoint()));
      await owner.withRun((run) =>
        run.execute(
          mode === 'same'
            ? { kind: 'resume', mode, continuation, input: 'yes' }
            : { kind: 'resume', mode, checkpoint, input: 'yes' },
        ),
      );
      expect(observations).toEqual([[], ['flow', 'scope']]);
      expect(ends).toEqual(['paused', 'completed']);
    },
  );

  it.each(['same', 'fresh'] as const)(
    'opens a fresh mounted component but does not invent child resume events on %s restore',
    async (mode) => {
      const entries: object[] = [];
      const ends: string[] = [];
      const resumes: unknown[] = [];

      const child = pausingChart();
      const childOwner = createRunLifecycle(child, {
        runnerId: 'mounted-pause',
        componentSetup: (component) => {
          entries.push(component.local(slot, () => ({})));
          component.onFinalize((end) => {
            ends.push(end.kind);
          });
          return { recorder: { id: 'child', onResume: (event) => resumes.push(event) } };
        },
      });
      const slot: RunSlot<object> = childOwner.slot('component');
      const chart = flowChart('parent', () => undefined, 'parent')
        .addSubFlowChartNext('child', child, 'child')
        .build();
      const parent = createRunLifecycle(chart, { runnerId: 'parent-pause' });
      await parent.withRun((run) => run.execute({ kind: 'run' }));
      const continuation = parent.continuation()!;
      const checkpoint = JSON.parse(JSON.stringify(continuation.checkpoint()));
      await parent.withRun((run) =>
        run.execute(
          mode === 'same'
            ? { kind: 'resume', mode, continuation, input: 'yes' }
            : { kind: 'resume', mode, checkpoint, input: 'yes' },
        ),
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]).not.toBe(entries[1]);
      expect(ends).toEqual(['paused', 'completed']);
      expect(resumes).toEqual([]);
    },
  );

  it('keeps the earlier body failure while joining all cleanup callbacks', async () => {
    const bodyFailure = new Error('body-failure');
    const cleanupFailure = new Error('cleanup-failure');
    const calls: string[] = [];
    const chart = flowChart(
      'body',
      () => {
        throw bodyFailure;
      },
      'body',
    ).build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'failure-precedence',
      componentSetup: (component) => {
        component.onFinalize((end) => {
          calls.push('first:' + end.kind);
        });
        component.onFinalize((end) => {
          calls.push('second:' + end.kind);
          throw cleanupFailure;
        });
        return {};
      },
    });
    owner.slot('component');
    await expect(owner.withRun((run) => run.execute({ kind: 'run' }))).rejects.toBe(bodyFailure);
    expect(calls).toEqual(['second:failed', 'first:failed']);
  });

  it('preserves format2 checkpoint bytes after normalizing only each actual native run ID', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const baseline = new FlowChartExecutor(pausingChart());
    await baseline.run();
    const original = baseline.getCheckpoint()!;
    const chart = pausingChart();

    const owner = createRunLifecycle(chart, {
      runnerId: 'checkpoint-byte-control',
      componentSetup: (component) => {
        component.set(slot, { marker: 'PRIVATE-COMPONENT-CONTROL', callback: () => undefined });
        component.onFinalize(() => undefined);
        return { recorder: { id: 'private-recorder', onPause: () => undefined } };
      },
    });
    const slot: RunSlot<unknown> = owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    const candidate = owner.continuation()!.checkpoint();
    const normalize = (checkpoint: typeof original) => {
      const runId = checkpoint.pausedExecution!.runId;
      expect(runId).toBeTypeOf('string');
      return JSON.stringify(checkpoint).split(runId).join('<actual-native-run-id>');
    };
    expect(candidate.checkpointVersion).toBe(2);
    expect(normalize(candidate)).toBe(normalize(original));
    expect(JSON.stringify(candidate)).not.toContain('PRIVATE-COMPONENT-CONTROL');
    // Actual one-run checkpoint from accepted native7c source, not a current-WIP comparison only.
    const accepted = JSON.parse(
      readFileSync(resolve(__dirname, 'fixtures/component-setup-7c.checkpoint.json'), 'utf8'),
    ) as FlowchartCheckpoint;
    expect(normalize(candidate)).toBe(normalize(accepted));
  });
});
