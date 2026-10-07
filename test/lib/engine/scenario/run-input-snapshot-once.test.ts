/**
 * The run input is snapshotted ONCE per run leg, at the leg's start — never at
 * construction (review finding 3, a regression from 9.42.0's B1).
 *
 * `FlowchartTraverser · createDeps` took `snapshotRunInput` when the traverser
 * was CONSTRUCTED. The executor constructs one traverser in its own
 * constructor, so a getter on constructor-provided input (`readOnlyContext`)
 * ran there — a side effect before any run — and again when `run()` built the
 * run's traverser: two copies for one run. The snapshot is now taken at the
 * start of `execute()`: zero reads at construction, exactly one per leg.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

/** An input whose one enumerable getter counts its reads. */
function countingInput() {
  const counter = { reads: 0 };
  const input = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      counter.reads += 1;
      return 'v';
    },
  });
  return { counter, input };
}

describe('the run input snapshot — lazily, once per leg', () => {
  it('constructor-provided input: zero getter reads at construction, exactly one per run', async () => {
    const { counter, input } = countingInput();
    const chart = flowChart<any>(
      'Read',
      (scope) => {
        scope.seen = (scope.$getArgs() as { value: string }).value;
      },
      'read',
    ).build();
    const executor = new FlowChartExecutor(chart, { readOnlyContext: input });
    expect(counter.reads).toBe(0);
    await executor.run();
    expect(counter.reads).toBe(1);
    expect(executor.getSnapshot().sharedState.seen).toBe('v');
    await executor.run();
    expect(counter.reads).toBe(2);
  });

  it('a pause/resume: one read for the run leg, one for the resume leg — none at construction', async () => {
    const { counter, input } = countingInput();
    const chart = flowChart<any>(
      'Read',
      (scope) => {
        scope.first = (scope.$getArgs() as { value: string }).value;
      },
      'read',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'go?' }),
          resume: (scope: any) => {
            scope.second = (scope.$getArgs() as { value: string }).value;
          },
        } as PausableHandler<any>,
        'ask',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { readOnlyContext: input });
    expect(counter.reads).toBe(0);
    await executor.run();
    expect(counter.reads).toBe(1);
    expect(executor.isPaused()).toBe(true);
    await executor.resume(executor.getCheckpoint()!, { ok: true });
    expect(counter.reads).toBe(2);
    expect(executor.getSnapshot().sharedState).toMatchObject({ first: 'v', second: 'v' });
  });

  it('run({ input }) reads the run input once', async () => {
    const { counter, input } = countingInput();
    const chart = flowChart<any>(
      'Read',
      (scope) => {
        scope.seen = (scope.$getArgs() as { value: string }).value;
      },
      'read',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input });
    expect(counter.reads).toBe(1);
  });
});
