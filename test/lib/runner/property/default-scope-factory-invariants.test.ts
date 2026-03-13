/**
 * Property / invariant tests for the default scopeFactory.
 *
 * These tests verify invariants that must hold regardless of
 * whether the consumer provides a scopeFactory or not.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { ScopeFacade } from '../../../../src/lib/scope';

describe('FlowChartExecutor — default scopeFactory (property)', () => {
  it('every stage receives a scope with setValue/getValue (with or without factory)', async () => {
    const methods: string[][] = [];

    const chart = flowChart(
      'A',
      (scope: ScopeFacade) => {
        methods.push(Object.getOwnPropertyNames(Object.getPrototypeOf(scope)));
      },
      'a',
    )
      .addFunction(
        'B',
        (scope: ScopeFacade) => {
          methods.push(Object.getOwnPropertyNames(Object.getPrototypeOf(scope)));
        },
        'b',
      )
      .build();

    // Without factory
    await new FlowChartExecutor(chart).run();
    expect(methods.length).toBe(2);
    for (const m of methods) {
      expect(m).toContain('setValue');
      expect(m).toContain('getValue');
    }
  });

  it('multiple runs with default factory produce independent state', async () => {
    let runCount = 0;
    const chart = flowChart(
      'counter',
      (scope: ScopeFacade) => {
        runCount++;
        scope.setValue('run', runCount);
      },
      'counter',
    ).build();

    const executor = new FlowChartExecutor(chart);

    await executor.run();
    const snap1 = executor.getSnapshot();
    expect(snap1.sharedState.run).toBe(1);

    await executor.run();
    const snap2 = executor.getSnapshot();
    expect(snap2.sharedState.run).toBe(2);
  });

  it('default factory scope tracks writes for narrative recording', async () => {
    const chart = flowChart(
      'write',
      (scope: ScopeFacade) => {
        scope.setValue('a', 1);
        scope.setValue('b', 2);
        scope.setValue('c', 3);
      },
      'write',
    )
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const narrative = executor.getNarrative();
    // Each setValue should produce a Write step
    const writeSteps = narrative.filter((s) => s.includes('Write'));
    expect(writeSteps.length).toBe(3);
  });

  it('default factory and explicit factory both support updateValue', async () => {
    const buildChart = () =>
      flowChart(
        'init',
        (scope: ScopeFacade) => {
          scope.setValue('config', { a: 1, b: 2 });
        },
        'init',
      )
        .addFunction(
          'merge',
          (scope: ScopeFacade) => {
            scope.updateValue('config', { b: 99, c: 3 });
            return scope.getValue('config');
          },
          'merge',
        )
        .build();

    // Default
    const r1 = await new FlowChartExecutor(buildChart()).run();
    // Explicit
    const factory = (ctx: any, name: string) => new ScopeFacade(ctx, name);
    const r2 = await new FlowChartExecutor(buildChart(), factory).run();

    expect(r1).toEqual(r2);
    expect(r1).toEqual({ a: 1, b: 99, c: 3 });
  });
});
