/**
 * Scenario tests for the default scopeFactory.
 *
 * End-to-end scenarios verifying that the full pipeline works
 * identically with and without an explicit scopeFactory.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { ScopeFacade } from '../../../../src/lib/scope';

describe('FlowChartExecutor — default scopeFactory (scenario)', () => {
  it('narrative works with default scopeFactory', async () => {
    const chart = flowChart(
      'init',
      (scope: any) => {
        scope.status = 'started';
      },
      'init',
    )
      .addFunction(
        'finish',
        (scope: any) => {
          scope.status = 'done';
        },
        'finish',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    // Default scopeFactory supports attachRecorder, so combined narrative includes writes
    expect(narrative.some((s) => s.includes('Write'))).toBe(true);
    expect(narrative.some((s) => s.includes('status'))).toBe(true);
  });

  it('default factory produces same results as explicit ScopeFacade factory', async () => {
    // Build chart for TypedScope (default factory via flowChart())
    const typedChart = flowChart(
      'write',
      (scope: any) => {
        scope.name = 'Alice';
        scope.score = 95;
      },
      'write',
    )
      .addFunction(
        'read',
        (scope: any) => {
          const name = scope.name;
          const score = scope.score;
          return `${name}:${score}`;
        },
        'read',
      )
      .build();

    // Build chart for ScopeFacade (explicit factory — uses setValue/getValue)
    const facadeChart = flowChart(
      'write',
      (scope: any) => {
        scope.setValue('name', 'Alice');
        scope.setValue('score', 95);
      },
      'write',
    )
      .addFunction(
        'read',
        (scope: any) => {
          const name = scope.getValue('name');
          const score = scope.getValue('score');
          return `${name}:${score}`;
        },
        'read',
      )
      .build();

    // Without scopeFactory (default — TypedScope)
    const exec1 = new FlowChartExecutor(typedChart);
    exec1.enableNarrative();
    const result1 = await exec1.run();
    const narrative1 = exec1.getNarrative();

    // With explicit scopeFactory (ScopeFacade)
    const explicitFactory = (ctx: any, stageName: string) => new ScopeFacade(ctx, stageName);
    const exec2 = new FlowChartExecutor(facadeChart, explicitFactory);
    exec2.enableNarrative();
    const result2 = await exec2.run();
    const narrative2 = exec2.getNarrative();

    expect(result1).toBe(result2);
    expect(narrative1.length).toBe(narrative2.length);
  });

  it('redaction policy works with default scopeFactory', async () => {
    const chart = flowChart(
      'ingest',
      (scope: any) => {
        scope.ssn = '123-45-6789';
        scope.name = 'Bob';
      },
      'ingest',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const report = executor.getRedactionReport();
    expect(report.redactedKeys).toContain('ssn');
  });

  it('snapshot captures state with default scopeFactory', async () => {
    const chart = flowChart(
      'init',
      (scope: any) => {
        scope.counter = 42;
      },
      'init',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.counter).toBe(42);
  });

  it('decider branching works with default scopeFactory', async () => {
    const chart = flowChart(
      'check',
      (scope: any) => {
        scope.tier = 'premium';
      },
      'check',
    )
      .addDeciderFunction(
        'route',
        (scope: any) => {
          return scope.tier === 'premium' ? 'fast' : 'slow';
        },
        'route',
      )
      .addFunctionBranch('fast', 'FastPath', (scope: any) => {
        scope.result = 'express';
      })
      .addFunctionBranch('slow', 'SlowPath', (scope: any) => {
        scope.result = 'standard';
      })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.result).toBe('express');
  });
});
