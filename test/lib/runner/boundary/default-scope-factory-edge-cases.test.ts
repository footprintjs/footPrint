/**
 * Boundary / edge-case tests for the default scopeFactory.
 *
 * Tests unusual configurations and edge cases to ensure
 * the default factory handles them correctly.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { ScopeFacade } from '../../../../src/lib/scope';

describe('FlowChartExecutor — default scopeFactory (boundary)', () => {
  it('works with a single-stage chart', async () => {
    const chart = flowChart(
      'only',
      (scope: ScopeFacade) => {
        scope.setValue('result', 'solo');
        return scope.getValue('result');
      },
      'only',
    ).build();

    const result = await new FlowChartExecutor(chart).run();
    expect(result).toBe('solo');
  });

  it('works with a deeply chained chart (10 stages)', async () => {
    let builder = flowChart(
      'stage0',
      (scope: ScopeFacade) => {
        scope.setValue('count', 1);
      },
      'stage0',
    );

    for (let i = 1; i < 10; i++) {
      builder = builder.addFunction(
        `stage${i}`,
        (scope: ScopeFacade) => {
          const count = (scope.getValue('count') as number) + 1;
          scope.setValue('count', count);
        },
        `stage${i}`,
      );
    }

    const chart = builder.build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSnapshot().sharedState.count).toBe(10);
  });

  it('works with fork pattern and default factory', async () => {
    const results: string[] = [];
    const chart = flowChart(
      'root',
      (scope: ScopeFacade) => {
        scope.setValue('started', true);
      },
      'root',
    )
      .addListOfFunction([
        {
          id: 'c1',
          name: 'child1',
          fn: (scope: ScopeFacade) => {
            results.push('child1');
          },
        },
        {
          id: 'c2',
          name: 'child2',
          fn: (scope: ScopeFacade) => {
            results.push('child2');
          },
        },
      ])
      .build();

    await new FlowChartExecutor(chart).run();

    expect(results).toContain('child1');
    expect(results).toContain('child2');
  });

  it('error in stage still commits state with default factory', async () => {
    const chart = flowChart(
      'setup',
      (scope: ScopeFacade) => {
        scope.setValue('before', true);
      },
      'setup',
    )
      .addFunction(
        'boom',
        (scope: ScopeFacade) => {
          scope.setValue('partial', 'written');
          throw new Error('stage error');
        },
        'boom',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('stage error');

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.before).toBe(true);
    expect(snapshot.sharedState.partial).toBe('written');
  });

  it('breakFn works with default factory', async () => {
    const stages: string[] = [];
    const chart = flowChart(
      'A',
      (scope: ScopeFacade, breakFn: () => void) => {
        stages.push('A');
        scope.setValue('stopped', true);
        breakFn();
      },
      'a',
    )
      .addFunction(
        'B',
        () => {
          stages.push('B');
        },
        'b',
      )
      .build();

    await new FlowChartExecutor(chart).run();

    expect(stages).toEqual(['A']);
  });

  it('defaultValuesForContext passed alongside default factory', async () => {
    const chart = flowChart(
      'read',
      (scope: ScopeFacade) => {
        return scope.getValue('preset');
      },
      'read',
    ).build();

    const executor = new FlowChartExecutor(
      chart,
      undefined, // default scopeFactory
      { preset: 'hello' }, // defaultValuesForContext
    );
    const result = await executor.run();

    expect(result).toBe('hello');
  });

  it('enrichSnapshots works with default factory', async () => {
    let capturedSnapshot: any;
    const chart = flowChart(
      'write',
      (scope: ScopeFacade) => {
        scope.setValue('x', 100);
      },
      'write',
    )
      .addTraversalExtractor((snapshot: any) => {
        capturedSnapshot = snapshot;
        return snapshot.node.name;
      })
      .build();

    const executor = new FlowChartExecutor(
      chart,
      undefined, // default scopeFactory
      undefined, // defaultValuesForContext
      undefined, // initialContext
      undefined, // readOnlyContext
      undefined, // throttlingErrorChecker
      undefined, // streamHandlers
      undefined, // scopeProtectionMode
      true, // enrichSnapshots
    );
    await executor.run();

    expect(capturedSnapshot).toBeDefined();
    expect(capturedSnapshot.scopeState).toBeDefined();
    expect(capturedSnapshot.scopeState.x).toBe(100);
  });
});
