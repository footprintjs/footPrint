import { vi } from 'vitest';

/**
 * Scenario test: Linear chain execution through FlowchartTraverser.
 *
 * Tests the simplest execution pattern: A → B → C
 * Each stage reads from scope, writes to scope, and execution flows linearly.
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

describe('Scenario: Linear Chain', () => {
  it('executes A → B → C in sequence', async () => {
    const stageMap = new Map<string, StageFunction>();
    const order: string[] = [];

    stageMap.set('A', (scope: any) => {
      order.push('A');
      scope.set('step', 'A');
      return 'resultA';
    });
    stageMap.set('B', (scope: any) => {
      order.push('B');
      scope.set('step', 'B');
      return 'resultB';
    });
    stageMap.set('C', (scope: any) => {
      order.push('C');
      scope.set('step', 'C');
      return 'resultC';
    });

    const nodeC: StageNode = { name: 'C', id: 'C' };
    const nodeB: StageNode = { name: 'B', id: 'B', next: nodeC };
    const root: StageNode = { name: 'A', id: 'A', next: nodeB };

    const runtime = new ExecutionRuntime('A', 'A');

    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    // Last stage's output is returned
    expect(result).toBe('resultC');
    // Execution order is correct
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('stops at break in middle of chain', async () => {
    const stageMap = new Map<string, StageFunction>();
    const order: string[] = [];

    stageMap.set('A', (scope: any) => {
      order.push('A');
      return 'resultA';
    });
    stageMap.set('B', (scope: any, breakFn: () => void) => {
      order.push('B');
      breakFn();
      return 'resultB';
    });
    stageMap.set('C', (scope: any) => {
      order.push('C');
      return 'resultC';
    });

    const nodeC: StageNode = { name: 'C', id: 'C' };
    const nodeB: StageNode = { name: 'B', id: 'B', next: nodeC };
    const root: StageNode = { name: 'A', id: 'A', next: nodeB };

    const runtime = new ExecutionRuntime('A', 'A');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    // B returned its value, C never ran
    expect(result).toBe('resultB');
    expect(order).toEqual(['A', 'B']);
  });

  it('propagates errors from stage functions', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('A', () => {
      throw new Error('stage A failed');
    });

    const root: StageNode = { name: 'A', id: 'A' };
    const runtime = new ExecutionRuntime('A', 'A');

    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow('stage A failed');
  });

  it('uses embedded fn when present on node', async () => {
    const embedded = vi.fn().mockReturnValue('embedded-result');

    const root: StageNode = { name: 'A', id: 'A', fn: embedded };
    const runtime = new ExecutionRuntime('A', 'A');

    const traverser = new FlowchartTraverser({
      root,
      stageMap: new Map(),
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();
    expect(result).toBe('embedded-result');
    expect(embedded).toHaveBeenCalledTimes(1);
  });
});
