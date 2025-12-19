/**
 * Scenario test: Subflow execution — isolated recursive execution with I/O mapping.
 *
 * Covers SubflowExecutor: input mapping, output mapping, nested subflows,
 * error handling, and narrative entry/exit.
 */

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import type { StageContext } from '../../../../src/lib/memory';

const noopScope = (ctx: StageContext) => ({ ctx });

function makeScopeFactory() {
  return (ctx: StageContext, stageName: string) => ({
    ctx,
    stageName,
    setValue: (key: string, value: unknown) => ctx.setGlobal(key, value),
    getValue: (key: string) => ctx.getGlobal(key),
  });
}

describe('Scenario: Subflow Execution', () => {
  it('executes a subflow via decider branch', async () => {
    const order: string[] = [];

    const subChart = flowChart('sub-entry', (scope: any) => {
      order.push('sub-entry');
      return 'sub-result';
    }).build();

    const chart = flowChart('start', (scope: any) => { order.push('start'); })
      .addDeciderFunction('router', async () => {
        order.push('router');
        return 'sub';
      })
        .addSubFlowChartBranch('sub', subChart, 'SubFlow')
        .addFunctionBranch('other', 'other', () => { order.push('other'); })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    expect(order).toContain('start');
    expect(order).toContain('router');
    expect(order).toContain('sub-entry');
    expect(order).not.toContain('other');

    const subResults = executor.getSubflowResults();
    expect(subResults.size).toBeGreaterThan(0);
  });

  it('subflow has isolated state from parent', async () => {
    const scopeFactory = makeScopeFactory();

    const subChart = flowChart('sub-write', (scope: any) => {
      scope.setValue('subOnly', 'from-sub');
      return 'sub-done';
    }).build();

    const chart = flowChart('parent-write', (scope: any) => {
      scope.setValue('parentData', 'hello');
    })
      .addDeciderFunction('route', async () => 'sub')
        .addSubFlowChartBranch('sub', subChart, 'SubFlow', {
          // inputMapper receives getScope() result — plain Record<string, unknown>
          inputMapper: (parentScope: any) => ({
            parentData: parentScope.parentData,
          }),
        })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const snapshot = executor.getSnapshot();
    // Parent state should NOT have subOnly
    expect(snapshot.sharedState.subOnly).toBeUndefined();
    // Parent state should have parentData
    expect(snapshot.sharedState.parentData).toBe('hello');
  });

  it('subflow with output mapping writes results back to parent', async () => {
    const scopeFactory = makeScopeFactory();

    const subChart = flowChart('compute', (scope: any) => {
      scope.setValue('result', 42);
      return 42;
    }).build();

    const chart = flowChart('init', (scope: any) => {
      scope.setValue('x', 10);
    })
      .addDeciderFunction('route', async () => 'sub')
        .addSubFlowChartBranch('sub', subChart, 'Compute', {
          // outputMapper receives (subflowOutput, parentScope) — 2 args
          outputMapper: (output: any, _parentScope: any) => {
            return { computeResult: output };
          },
        })
      .end()
      .addFunction('verify', (scope: any) => {
        return scope.getValue('computeResult');
      })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    const result = await executor.run();

    expect(result).toBe(42);
  });

  it('subflow errors propagate to parent', async () => {
    const subChart = flowChart('boom', () => {
      throw new Error('subflow-error');
    }).build();

    const chart = flowChart('start', () => {})
      .addDeciderFunction('route', async () => 'sub')
        .addSubFlowChartBranch('sub', subChart, 'Boom')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await expect(executor.run()).rejects.toThrow('subflow-error');
  });

  it('subflow narrative captures entry and exit', async () => {
    const subChart = flowChart('sub-stage', () => {}).build();

    const chart = flowChart('start', () => {})
      .addDeciderFunction('route', async () => 'sub')
        .addSubFlowChartBranch('sub', subChart, 'MySubFlow')
      .end()
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.some(s => s.includes('MySubFlow'))).toBe(true);
  });

  it('subflow result is stored with correct structure', async () => {
    const subChart = flowChart('inner', () => 'inner-done').build();

    const chart = flowChart('outer', () => {})
      .addDeciderFunction('decide', async () => 'sf')
        .addSubFlowChartBranch('sf', subChart, 'TestSubflow')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const results = executor.getSubflowResults();
    expect(results.size).toBe(1);

    const sfResult = results.get('sf');
    expect(sfResult).toBeDefined();
    expect(sfResult!.subflowId).toBe('sf');
    expect(sfResult!.subflowName).toBe('TestSubflow');
    expect(sfResult!.treeContext).toBeDefined();
    expect(sfResult!.treeContext.globalContext).toBeDefined();
    expect(sfResult!.treeContext.stageContexts).toBeDefined();
    expect(sfResult!.treeContext.history).toBeDefined();
  });
});
