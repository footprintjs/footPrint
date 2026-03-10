import { vi } from 'vitest';

/**
 * Scenario test: Fork pattern — parallel children execution.
 *
 * Tests the pattern: Parent → [ChildA, ChildB, ChildC] (parallel)
 * All children execute via Promise.allSettled and results are aggregated.
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

describe('Scenario: Fork Pattern', () => {
  it('executes all children in parallel and returns bundle', async () => {
    const stageMap = new Map<string, StageFunction>();
    const order: string[] = [];

    stageMap.set('parent', (scope: any) => {
      order.push('parent');
      return 'parentResult';
    });
    stageMap.set('childA', (scope: any) => {
      order.push('childA');
      return 'resultA';
    });
    stageMap.set('childB', (scope: any) => {
      order.push('childB');
      return 'resultB';
    });

    const childA: StageNode = { name: 'childA', id: 'childA' };
    const childB: StageNode = { name: 'childB', id: 'childB' };
    const root: StageNode = { name: 'parent', id: 'parent', children: [childA, childB] };

    const runtime = new ExecutionRuntime('parent');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    // Parent ran first
    expect(order[0]).toBe('parent');
    // Both children ran
    expect(order).toContain('childA');
    expect(order).toContain('childB');

    // Result is a bundle: { childId: { id, result, isError } }
    expect(result).toHaveProperty('childA');
    expect(result).toHaveProperty('childB');
    expect(result.childA.result).toBe('resultA');
    expect(result.childA.isError).toBe(false);
    expect(result.childB.result).toBe('resultB');
  });

  it('fork-only node without stage function executes children', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('childA', () => 'resultA');
    stageMap.set('childB', () => 'resultB');

    const childA: StageNode = { name: 'childA', id: 'childA' };
    const childB: StageNode = { name: 'childB', id: 'childB' };
    const root: StageNode = { name: 'fork', id: 'fork', children: [childA, childB] };

    const runtime = new ExecutionRuntime('fork');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(result.childA.result).toBe('resultA');
    expect(result.childB.result).toBe('resultB');
  });

  it('captures child errors without failing siblings', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('good', () => 'ok');
    stageMap.set('bad', () => {
      throw new Error('child failed');
    });

    const good: StageNode = { name: 'good', id: 'good' };
    const bad: StageNode = { name: 'bad', id: 'bad' };
    const root: StageNode = { name: 'fork', id: 'fork', children: [good, bad] };

    const runtime = new ExecutionRuntime('fork');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(result.good.result).toBe('ok');
    expect(result.good.isError).toBe(false);
    expect(result.bad.isError).toBe(true);
    expect(result.bad.result).toBeInstanceOf(Error);
  });
});
