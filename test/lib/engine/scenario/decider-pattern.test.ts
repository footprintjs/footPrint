/**
 * Scenario test: Decider pattern — conditional branching.
 *
 * Tests scope-based decider (addDeciderFunction pattern):
 * DeciderNode → fn returns branch ID → chosen child executes.
 */

import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { StageFunction, ILogger } from '../../../../src/lib/engine/types';

const silentLogger: ILogger = {
  info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

function simpleScopeFactory(context: any) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

describe('Scenario: Decider Pattern', () => {
  it('scope-based decider routes to correct branch', async () => {
    const stageMap = new Map<string, StageFunction>();
    const order: string[] = [];

    // Decider fn reads from scope and returns branch ID
    stageMap.set('decider', (scope: any) => {
      order.push('decider');
      return 'approve'; // branch ID
    });
    stageMap.set('approve', (scope: any) => {
      order.push('approve');
      return 'approved!';
    });
    stageMap.set('reject', (scope: any) => {
      order.push('reject');
      return 'rejected!';
    });

    const approve: StageNode = { name: 'approve', id: 'approve' };
    const reject: StageNode = { name: 'reject', id: 'reject' };
    const root: StageNode = {
      name: 'decider', id: 'decider',
      deciderFn: true,
      children: [approve, reject],
    };

    const runtime = new ExecutionRuntime('decider');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(result).toBe('approved!');
    expect(order).toEqual(['decider', 'approve']);
    // Reject branch never ran
    expect(order).not.toContain('reject');
  });

  it('scope-based decider falls back to default branch', async () => {
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('decider', () => 'unknown-branch');
    stageMap.set('fallback', () => 'fallback-result');

    const fallback: StageNode = { name: 'fallback', id: 'default' }; // id = 'default'
    const root: StageNode = {
      name: 'decider', id: 'decider',
      deciderFn: true,
      children: [fallback],
    };

    const runtime = new ExecutionRuntime('decider');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();
    expect(result).toBe('fallback-result');
  });

  it('scope-based decider throws when no match and no default', async () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('decider', () => 'nonexistent');
    stageMap.set('approve', () => 'approved');

    const root: StageNode = {
      name: 'decider', id: 'decider',
      deciderFn: true,
      children: [{ name: 'approve', id: 'approve' }],
    };

    const runtime = new ExecutionRuntime('decider');
    const traverser = new FlowchartTraverser({
      root, stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow("doesn't match any child");
  });
});
