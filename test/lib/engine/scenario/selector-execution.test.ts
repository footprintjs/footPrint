import { vi } from 'vitest';

/**
 * Scenario test: Selector execution — scope-based multi-choice filtered fan-out.
 *
 * Covers SelectorHandler.handleScopeBased:
 * - Select multiple children by ID
 * - Select single child
 * - Select none (skip all)
 * - Invalid ID throws
 * - Narrative captures selection
 * - Break in selector stops execution
 * - Error in selector stage propagates
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

function simpleScopeFactory(context: any) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

function buildSelectorTree(
  selectorFn: StageFunction,
  children: StageNode[],
  stageMap: Map<string, StageFunction>,
): StageNode {
  const root: StageNode = {
    name: 'selector',
    id: 'selector',
    selectorFn: true,
    fn: selectorFn,
    children,
  };
  stageMap.set('selector', selectorFn);
  return root;
}

describe('Scenario: Selector Execution (scope-based)', () => {
  it('selects multiple children by ID and runs them in parallel', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const emailFn = () => {
      order.push('email');
      return 'email-sent';
    };
    const smsFn = () => {
      order.push('sms');
      return 'sms-sent';
    };
    const pushFn = () => {
      order.push('push');
      return 'push-sent';
    };

    stageMap.set('email', emailFn);
    stageMap.set('sms', smsFn);
    stageMap.set('push', pushFn);

    const children: StageNode[] = [
      { name: 'email', id: 'email', fn: emailFn },
      { name: 'sms', id: 'sms', fn: smsFn },
      { name: 'push', id: 'push', fn: pushFn },
    ];

    const selectorFn = () => ['email', 'push']; // skip sms
    const root = buildSelectorTree(selectorFn, children, stageMap);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(order).toContain('email');
    expect(order).toContain('push');
    expect(order).not.toContain('sms');
  });

  it('selects a single child', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const aFn = () => {
      order.push('A');
      return 'A-done';
    };
    const bFn = () => {
      order.push('B');
      return 'B-done';
    };
    stageMap.set('A', aFn);
    stageMap.set('B', bFn);

    const children: StageNode[] = [
      { name: 'A', id: 'a', fn: aFn },
      { name: 'B', id: 'b', fn: bFn },
    ];

    const selectorFn = () => 'b'; // single string coerced to array
    const root = buildSelectorTree(selectorFn, children, stageMap);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await traverser.execute();

    expect(order).toEqual(['B']);
  });

  it('selects none — returns empty result', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const aFn = () => {
      order.push('A');
    };
    stageMap.set('A', aFn);

    const children: StageNode[] = [{ name: 'A', id: 'a', fn: aFn }];

    const selectorFn = () => []; // select nothing
    const root = buildSelectorTree(selectorFn, children, stageMap);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(order).toEqual([]);
    expect(result).toEqual({});
  });

  it('throws when selector returns unknown child ID', async () => {
    const stageMap = new Map<string, StageFunction>();
    const aFn = () => {};
    stageMap.set('A', aFn);

    const children: StageNode[] = [{ name: 'A', id: 'a', fn: aFn }];

    const selectorFn = () => ['nonexistent'];
    const root = buildSelectorTree(selectorFn, children, stageMap);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow('unknown child IDs');
  });

  it('error in selector stage function propagates', async () => {
    const stageMap = new Map<string, StageFunction>();

    const children: StageNode[] = [{ name: 'A', id: 'a', fn: () => {} }];

    const selectorFn = () => {
      throw new Error('selector-crash');
    };
    const root = buildSelectorTree(selectorFn, children, stageMap);
    stageMap.set('A', () => {});

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow('selector-crash');
  });

  it('break in selector stops execution after commit', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const selectorFn = (_scope: any, breakFn: () => void) => {
      order.push('selector');
      breakFn();
      return ['a'];
    };

    const aFn = () => {
      order.push('A');
    };
    stageMap.set('A', aFn);

    const children: StageNode[] = [{ name: 'A', id: 'a', fn: aFn }];
    const root = buildSelectorTree(selectorFn, children, stageMap);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await traverser.execute();

    expect(order).toEqual(['selector']);
    // A should not run because break was called
    expect(order).not.toContain('A');
  });

  it('narrative captures selector selection', async () => {
    const stageMap = new Map<string, StageFunction>();

    const emailFn = () => 'email-sent';
    const smsFn = () => 'sms-sent';
    stageMap.set('email', emailFn);
    stageMap.set('sms', smsFn);

    const children: StageNode[] = [
      { name: 'email', id: 'email', fn: emailFn, displayName: 'Email' },
      { name: 'sms', id: 'sms', fn: smsFn, displayName: 'SMS' },
    ];

    const selectorFn = () => ['email'];
    const root = buildSelectorTree(selectorFn, children, stageMap);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      narrativeEnabled: true,
    });

    await traverser.execute();

    const narrative = traverser.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    // Should mention the selection
    expect(narrative.some((s) => s.includes('selected') || s.includes('Email'))).toBe(true);
  });

  it('selector followed by next node continues execution', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const aFn = () => {
      order.push('A');
    };
    const bFn = () => {
      order.push('B');
    };
    const afterFn = () => {
      order.push('after');
      return 'final';
    };
    stageMap.set('A', aFn);
    stageMap.set('B', bFn);
    stageMap.set('after', afterFn);

    const children: StageNode[] = [
      { name: 'A', id: 'a', fn: aFn },
      { name: 'B', id: 'b', fn: bFn },
    ];

    const afterNode: StageNode = { name: 'after', fn: afterFn };

    const selectorFn = () => ['a'];
    const root: StageNode = {
      name: 'selector',
      id: 'selector',
      selectorFn: true,
      fn: selectorFn,
      children,
      next: afterNode,
    };
    stageMap.set('selector', selectorFn);

    const runtime = new ExecutionRuntime('selector', 'selector');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(order).toContain('A');
    expect(order).not.toContain('B');
    expect(order).toContain('after');
    expect(result).toBe('final');
  });
});
