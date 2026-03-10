import { vi } from 'vitest';

/**
 * Boundary test: Validation errors for invalid node configurations.
 *
 * Tests that the traverser fails fast with clear errors for:
 * - Nodes with no fn, no children, no decider
 * - Decider nodes without children
 * - Selector nodes without children
 */
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger } from '../../../../src/lib/engine/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

const silentLogger: ILogger = {
  info: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

function simpleScopeFactory() {
  return { get: () => undefined, set: () => {} };
}

function makeTraverser(root: StageNode) {
  return new FlowchartTraverser({
    root,
    stageMap: new Map(),
    scopeFactory: simpleScopeFactory,
    executionRuntime: new ExecutionRuntime(root.name),
    scopeProtectionMode: 'off',
    logger: silentLogger,
  });
}

describe('Boundary: Validation Errors', () => {
  it('throws for node with no fn, no children, no decider', async () => {
    const root: StageNode = { name: 'empty' };
    const traverser = makeTraverser(root);

    await expect(traverser.execute()).rejects.toThrow('must define');
  });

  it('throws for decider node without children', async () => {
    const stageMap = new Map();
    stageMap.set('decider', () => 'branch');

    const root: StageNode = { name: 'decider', deciderFn: true };
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: new ExecutionRuntime('decider'),
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow('Decider node needs to have children');
  });

  it('throws for selector node without children', async () => {
    const stageMap = new Map();
    stageMap.set('selector', () => ['a']);

    const root: StageNode = { name: 'selector', selectorFn: true };
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: new ExecutionRuntime('selector'),
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    await expect(traverser.execute()).rejects.toThrow('Selector node needs to have children');
  });

  it('leaf node with fn but no continuation returns output', async () => {
    const stageMap = new Map();
    stageMap.set('leaf', () => 'leaf-output');

    const root: StageNode = { name: 'leaf' };
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: new ExecutionRuntime('leaf'),
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();
    expect(result).toBe('leaf-output');
  });
});
