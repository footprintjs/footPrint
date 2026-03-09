/**
 * Scenario tests for the default scopeFactory.
 *
 * End-to-end scenarios verifying that the full pipeline works
 * identically with and without an explicit scopeFactory.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { NarrativeRecorder, ScopeFacade } from '../../../../src/lib/scope';

describe('FlowChartExecutor — default scopeFactory (scenario)', () => {
  it('narrative works with default scopeFactory', async () => {
    const chart = flowChart('init', (scope: ScopeFacade) => {
      scope.setValue('status', 'started');
    })
      .addFunction('finish', (scope: ScopeFacade) => {
        scope.setValue('status', 'done');
      })
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    // Default ScopeFacade supports attachRecorder, so combined narrative includes writes
    expect(narrative.some((s) => s.includes('Write'))).toBe(true);
    expect(narrative.some((s) => s.includes('status'))).toBe(true);
  });

  it('default factory produces same results as explicit ScopeFacade factory', async () => {
    const buildChart = () =>
      flowChart('write', (scope: ScopeFacade) => {
        scope.setValue('name', 'Alice');
        scope.setValue('score', 95);
      })
        .addFunction('read', (scope: ScopeFacade) => {
          const name = scope.getValue('name');
          const score = scope.getValue('score');
          return `${name}:${score}`;
        })
        .setEnableNarrative()
        .build();

    // Without scopeFactory (default)
    const exec1 = new FlowChartExecutor(buildChart());
    const result1 = await exec1.run();
    const narrative1 = exec1.getNarrative();

    // With explicit scopeFactory
    const explicitFactory = (ctx: any, stageName: string) => new ScopeFacade(ctx, stageName);
    const exec2 = new FlowChartExecutor(buildChart(), explicitFactory);
    const result2 = await exec2.run();
    const narrative2 = exec2.getNarrative();

    expect(result1).toBe(result2);
    expect(narrative1.length).toBe(narrative2.length);
  });

  it('redaction policy works with default scopeFactory', async () => {
    const chart = flowChart('ingest', (scope: ScopeFacade) => {
      scope.setValue('ssn', '123-45-6789');
      scope.setValue('name', 'Bob');
    }).build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const report = executor.getRedactionReport();
    expect(report.redactedKeys).toContain('ssn');
  });

  it('snapshot captures state with default scopeFactory', async () => {
    const chart = flowChart('init', (scope: ScopeFacade) => {
      scope.setValue('counter', 42);
    }).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.counter).toBe(42);
  });

  it('custom scopeFactory with recorder still works (regression)', async () => {
    const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });
    const customFactory = (ctx: any, stageName: string) => {
      const scope = new ScopeFacade(ctx, stageName);
      scope.attachRecorder(recorder);
      return scope;
    };

    const chart = flowChart('A', (scope: ScopeFacade) => {
      scope.setValue('x', 1);
    }).build();

    const executor = new FlowChartExecutor(chart, customFactory);
    await executor.run();

    expect(recorder.getStageData().size).toBeGreaterThan(0);
  });

  it('decider branching works with default scopeFactory', async () => {
    const chart = flowChart('check', (scope: ScopeFacade) => {
      scope.setValue('tier', 'premium');
    })
      .addDeciderFunction('route', (scope: ScopeFacade) => {
        return scope.getValue('tier') === 'premium' ? 'fast' : 'slow';
      })
      .addFunctionBranch('fast', 'FastPath', (scope: ScopeFacade) => {
        scope.setValue('result', 'express');
      })
      .addFunctionBranch('slow', 'SlowPath', (scope: ScopeFacade) => {
        scope.setValue('result', 'standard');
      })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.result).toBe('express');
  });
});
