import { expect, it } from 'vitest';

import type { AttemptCategory } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, UnknownEffectError } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

it('retains unresolved native meaning before a stage-attempt listener changes the wrapper prototype', async () => {
  const transport = Object.assign(new Error('synthetic private transport'), { code: 'ECONNRESET' });
  let wrapper: unknown;
  const wasUnknown: boolean[] = [];
  const historicalCategories: (AttemptCategory | undefined)[] = [];
  const executor = new FlowChartExecutor(
    flowChart(
      'Wrapped call',
      async (scope) => {
        try {
          await scope.$call(
            'synthetic.write',
            () => {
              throw transport;
            },
            undefined,
            { touches: 'synthetic-provider', idempotencyKey: 'synthetic-private-key' },
          );
        } catch (error) {
          wrapper = error;
          throw error;
        }
      },
      'wrapped-call',
    )
      .retry({ attempts: 1, timeoutMs: 1000 })
      .setLogger(silent)
      .build(),
  );
  executor.attachFlowRecorder({
    id: 'change-wrapper-prototype',
    onAttempt: (event) => {
      if (event.record.kind === 'stage' && event.record.next === 'stop') {
        // Assert callback observations later: recorder isolation must not swallow a failing test assertion.
        wasUnknown.push(wrapper instanceof UnknownEffectError);
        historicalCategories.push(event.record.category);
        Object.setPrototypeOf(wrapper as object, Error.prototype);
      }
    },
  });
  let escaped: unknown;
  try {
    await executor.run();
  } catch (error) {
    escaped = error;
  }
  expect(wasUnknown).toEqual([true]);
  expect(historicalCategories).toEqual(['network']);
  expect(escaped).toBe(wrapper);
  expect((escaped as Error).cause).toBe(transport);
  expect(executor.getFailureContext()).toEqual({
    category: 'unknown',
    stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'wrapped-call#0' },
  });
});
