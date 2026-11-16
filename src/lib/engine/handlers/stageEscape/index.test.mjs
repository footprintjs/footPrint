import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../index.js';

it.each(['linear', 'decider', 'selector'])(
  'preserves %s error reporting order, committed writes and rejection',
  async (kind) => {
    const original = new Error('stage body failed');
    const order = [];
    const body = (scope) => {
      scope.beforeFailure = 42;
      throw original;
    };
    const builder = flowChart('Seed', () => {}, 'seed');
    if (kind === 'linear') builder.addFunction('Fail', body, 'fail');
    else if (kind === 'decider')
      builder
        .addDeciderFunction('Fail', body, 'fail')
        .addFunctionBranch('a', 'A', () => {})
        .end();
    else
      builder
        .addSelectorFunction('Fail', body, 'fail')
        .addFunctionBranch('a', 'A', () => {})
        .end();
    const chart = builder.build();
    chart.logger = { info() {}, debug() {}, warn() {}, error: () => order.push('logger') };
    const ex = new FlowChartExecutor(chart, { sink: memorySink() });
    ex.attachFlowRecorder({
      id: 'error-order',
      onError: () => {
        expect(ex.getSnapshot().sharedState.beforeFailure).toBe(42);
        expect(ex.getSnapshot().commitLog.some((bundle) => bundle.runtimeStageId === 'fail#1')).toBe(true);
        order.push('event');
      },
    });
    let rejected;
    try {
      await ex.run();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBe(original);
    expect(order).toEqual(kind === 'linear' ? ['event', 'logger'] : ['logger', 'event']);
  },
);
