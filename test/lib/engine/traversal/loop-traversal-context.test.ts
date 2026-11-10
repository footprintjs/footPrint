/**
 * Every loop edge stamps `onLoop` with the stage's traversal context.
 *
 * Before the fix two loop sites left it out: a decider's own `loopTo` (the
 * decider's `next` is a loop stub) and a dynamic next returned by a stage.
 * On those paths `onLoop` reached recorders with `traversalContext`
 * undefined — no runId, no correlation.
 */
import { describe, expect, it } from 'vitest';

import type { FlowLoopEvent } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

function loopEvents(executor: FlowChartExecutor): FlowLoopEvent[] {
  const events: FlowLoopEvent[] = [];
  executor.attachFlowRecorder({ id: 'loops', onLoop: (event) => events.push(event) });
  return events;
}

describe('onLoop carries the traversal context on every loop edge', () => {
  it("a decider's own loopTo", async () => {
    let n = 0;
    const chart = flowChart<any>('Seed', () => {}, 'seed')
      .addFunction(
        'Tick',
        () => {
          n++;
        },
        'tick',
      )
      .addDeciderFunction('Check', () => (n < 2 ? 'again' : 'done'), 'check')
      .addFunctionBranch('again', 'Again', () => {})
      .addFunctionBranch('done', 'Done', () => {})
      .end()
      .loopTo('tick')
      .build();
    const executor = new FlowChartExecutor(chart);
    const events = loopEvents(executor);
    await executor.run({ maxIterations: 1 }).catch(() => undefined);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.traversalContext?.runId).toEqual(expect.any(String));
      expect(event.traversalContext?.stageId).toBe('check');
    }
  });

  it('a dynamic next returned by a stage', async () => {
    let m = 0;
    const chart = flowChart<any>('Seed', () => {}, 'seed')
      .addFunction(
        'Tick',
        () => {
          m++;
        },
        'tick',
      )
      .addFunction('Dyn', () => (m < 2 ? { name: 'x', next: { name: 'Tick', id: 'tick' } } : undefined), 'dyn')
      .build();
    const executor = new FlowChartExecutor(chart);
    const events = loopEvents(executor);
    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].traversalContext?.runId).toEqual(expect.any(String));
    expect(events[0].traversalContext?.stageId).toBe('dyn');
  });
});
