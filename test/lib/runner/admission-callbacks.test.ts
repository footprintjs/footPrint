import { describe, expect, it } from 'vitest';

import type { PausableHandler, RunOptions, TypedScope } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

type Outcome = { status: 'fulfilled' } | { status: 'rejected'; error: unknown };

function observed(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ status: 'fulfilled' }),
    (error: unknown) => ({ status: 'rejected', error }),
  );
}

describe('native admission precedes caller callbacks', () => {
  it.each(['schema', 'input getter', 'env getter', 'recorder clear'] as const)(
    'refuses a second run from %s without starting another stage',
    async (callback) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let attempted = false;
      let intruder: Promise<Outcome> | undefined;
      let stages = 0;
      const reenter = () => {
        if (attempted) return;
        attempted = true;
        intruder = observed(executor.run({ input: { label: 'intruder' } }));
      };
      const chart = flowChart<{ done?: boolean }>(
        'work',
        async (scope) => {
          stages += 1;
          await gate;
          scope.done = true;
        },
        'work',
      )
        .contract({
          input: {
            parse(value: unknown) {
              if (callback === 'schema') reenter();
              return value;
            },
          },
        })
        .build();
      const executor: FlowChartExecutor = new FlowChartExecutor(chart);
      if (callback === 'recorder clear') executor.attachFlowRecorder({ id: 'reentry', clear: reenter });
      const options: RunOptions = { input: { label: 'owner' } };
      if (callback === 'input getter')
        Object.defineProperty(options, 'input', {
          get() {
            reenter();
            return { label: 'owner' };
          },
        });
      if (callback === 'env getter')
        Object.defineProperty(options, 'env', {
          get() {
            reenter();
            return undefined;
          },
        });

      const first = executor.run(options);
      release();
      expect(await observed(first)).toEqual({ status: 'fulfilled' });
      expect(attempted).toBe(true);
      const result = await intruder!;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error).toMatchObject({ code: 'ERR_RUN_IN_FLIGHT' });
      expect(stages).toBe(1);
      expect(executor.getSnapshot().sharedState.done).toBe(true);
      // A refused intruder must not release the original admission or wedge its successor.
      expect(await observed(executor.run())).toEqual({ status: 'fulfilled' });
      expect(stages).toBe(2);
    },
  );

  it('refuses run reentry from the native resume notification', async () => {
    let resumed = 0;
    const handler: PausableHandler<TypedScope<{ answer?: string }>> = {
      execute: async () => ({ question: 'continue?' }),
      resume: async (scope, input) => {
        resumed += 1;
        scope.answer = String(input);
      },
    };
    const executor = new FlowChartExecutor(flowChart('approve', handler, 'approve').build());
    expect(await observed(executor.run())).toEqual({ status: 'fulfilled' });
    const checkpoint = executor.getCheckpoint()!;
    let intruder: Promise<Outcome> | undefined;
    executor.attachFlowRecorder({
      id: 'resume-reentry',
      onResume: () => {
        intruder = observed(executor.run());
      },
    });

    expect(await observed(executor.resume(checkpoint, 'approved'))).toEqual({ status: 'fulfilled' });
    expect(intruder).toBeDefined();
    const result = await intruder!;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.error).toMatchObject({ code: 'ERR_RUN_IN_FLIGHT' });
    expect(resumed).toBe(1);
    expect(executor.getSnapshot().sharedState.answer).toBe('approved');
  });
});
