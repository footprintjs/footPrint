import { vi } from 'vitest';

/**
 * Scenario test: failFast option on parallel children.
 *
 * Tests that failFast: true causes immediate rejection on first child error,
 * while default behavior (failFast: false) runs all children to completion.
 */
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger, StageFunction } from '../../../../src/lib/engine/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

const silentLogger: ILogger = {
  info: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

function simpleScopeFactory(context: any, stageName: string) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

describe('Scenario: failFast on fork', () => {
  it('default: all children complete even when one throws', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('parent', () => 'parentResult');
    stageMap.set('childA', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('childA');
      throw new Error('childA failed');
    });
    stageMap.set('childB', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push('childB');
      return 'resultB';
    });

    const childA: StageNode = { name: 'childA', id: 'childA' };
    const childB: StageNode = { name: 'childB', id: 'childB' };
    const root: StageNode = { name: 'parent', children: [childA, childB] };

    const runtime = new ExecutionRuntime('parent', 'parent');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      logger: silentLogger,
    });

    const result = (await traverser.execute()) as any;
    // Both children should have run
    expect(order).toContain('childA');
    expect(order).toContain('childB');
    expect(result.childA.isError).toBe(true);
    expect(result.childB.isError).toBe(false);
    expect(result.childB.result).toBe('resultB');
  });

  it('failFast: rejects immediately on first child error', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('parent', () => 'parentResult');
    stageMap.set('childA', async () => {
      order.push('childA');
      throw new Error('childA failed');
    });
    stageMap.set('childB', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push('childB');
      return 'resultB';
    });

    const childA: StageNode = { name: 'childA', id: 'childA' };
    const childB: StageNode = { name: 'childB', id: 'childB' };
    const root: StageNode = { name: 'parent', children: [childA, childB], failFast: true };

    const runtime = new ExecutionRuntime('parent', 'parent');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow('childA failed');
  });

  it('failFast: succeeds when all children pass', async () => {
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('parent', () => 'parentResult');
    stageMap.set('childA', () => 'resultA');
    stageMap.set('childB', () => 'resultB');

    const childA: StageNode = { name: 'childA', id: 'childA' };
    const childB: StageNode = { name: 'childB', id: 'childB' };
    const root: StageNode = { name: 'parent', children: [childA, childB], failFast: true };

    const runtime = new ExecutionRuntime('parent', 'parent');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      logger: silentLogger,
    });

    const result = (await traverser.execute()) as any;
    expect(result.childA.result).toBe('resultA');
    expect(result.childB.result).toBe('resultB');
  });
});
