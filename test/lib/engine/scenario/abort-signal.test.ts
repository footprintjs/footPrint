/**
 * Scenario test: AbortSignal and timeout support.
 *
 * Tests cooperative cancellation via AbortSignal and timeoutMs.
 */

import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { StageFunction, ILogger, FlowChart } from '../../../../src/lib/engine/types';

const silentLogger: ILogger = {
  info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

function simpleScopeFactory(context: any, stageName: string) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

describe('Scenario: AbortSignal', () => {
  it('aborts execution when signal is already aborted', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('stage1', () => 'result1');

    const root: StageNode = { name: 'stage1' };
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const runtime = new ExecutionRuntime('stage1');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      logger: silentLogger,
      signal: controller.signal,
    });

    await expect(traverser.execute()).rejects.toThrow('cancelled');
  });

  it('aborts between stages when signal fires', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('stage1', () => {
      order.push('stage1');
      controller.abort(new Error('mid-execution abort'));
      return 'result1';
    });
    stageMap.set('stage2', () => {
      order.push('stage2');
      return 'result2';
    });

    const stage2: StageNode = { name: 'stage2' };
    const root: StageNode = { name: 'stage1', next: stage2 };

    const runtime = new ExecutionRuntime('stage1');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      logger: silentLogger,
      signal: controller.signal,
    });

    await expect(traverser.execute()).rejects.toThrow('mid-execution abort');
    expect(order).toEqual(['stage1']);
  });

  it('aborts an async stage mid-flight via signal race', async () => {
    const controller = new AbortController();
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('slowStage', () => {
      return new Promise((resolve) => {
        setTimeout(() => resolve('done'), 5000);
      });
    });

    const root: StageNode = { name: 'slowStage' };
    const runtime = new ExecutionRuntime('slowStage');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      logger: silentLogger,
      signal: controller.signal,
    });

    // Abort after 50ms
    setTimeout(() => controller.abort(new Error('timed out')), 50);

    await expect(traverser.execute()).rejects.toThrow('timed out');
  });
});

describe('Scenario: FlowChartExecutor with RunOptions', () => {
  it('supports timeoutMs option', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('slowStage', () => new Promise((resolve) => setTimeout(() => resolve('done'), 5000)));

    const root: StageNode = { name: 'slowStage' };
    const flowChart: FlowChart = { root, stageMap };

    const executor = new FlowChartExecutor(flowChart, simpleScopeFactory);
    await expect(executor.run({ timeoutMs: 50 })).rejects.toThrow(/timed out/i);
  });

  it('supports signal option', async () => {
    const controller = new AbortController();
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('slowStage', () => new Promise((resolve) => setTimeout(() => resolve('done'), 5000)));

    const root: StageNode = { name: 'slowStage' };
    const flowChart: FlowChart = { root, stageMap };

    const executor = new FlowChartExecutor(flowChart, simpleScopeFactory);
    setTimeout(() => controller.abort(new Error('user cancelled')), 50);

    await expect(executor.run({ signal: controller.signal })).rejects.toThrow('user cancelled');
  });

  it('completes normally when no abort happens', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fast', () => 'quick');

    const root: StageNode = { name: 'fast' };
    const flowChart: FlowChart = { root, stageMap };

    const executor = new FlowChartExecutor(flowChart, simpleScopeFactory);
    const result = await executor.run({ timeoutMs: 5000 });
    expect(result).toBe('quick');
  });
});
