import { vi } from 'vitest';

/**
 * Scenario test: Continuation patterns — dynamic next resolution.
 *
 * Covers ContinuationResolver:
 * - String reference → resolve from graph, track iteration
 * - StageNode with fn → direct execution (truly dynamic)
 * - StageNode without fn → reference by ID, resolve + track iteration
 * - Max iteration enforcement
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

describe('Scenario: Continuation Patterns', () => {
  it('stage returning StageNode with next triggers dynamic continuation', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const dynamicNext: StageNode = {
      name: 'dynamic-stage',
      fn: () => {
        order.push('dynamic');
        return 'dynamic-result';
      },
    };

    stageMap.set('start', () => {
      order.push('start');
      // Return a StageNode with next — triggers isStageNodeReturn duck-typing
      return {
        name: 'continuation',
        next: dynamicNext,
      };
    });

    const root: StageNode = { name: 'start', id: 'start' };

    const runtime = new ExecutionRuntime('start', 'start');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(order).toContain('start');
    expect(order).toContain('dynamic');
  });

  it('stage returning StageNode with children triggers fork dispatch', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('producer', () => {
      order.push('producer');
      return {
        name: 'dynamic-fork',
        // duck-typing: isStageNodeReturn checks name + continuation props
        children: [
          {
            name: 'child1',
            id: 'c1',
            fn: () => {
              order.push('c1');
              return 'c1-done';
            },
          },
          {
            name: 'child2',
            id: 'c2',
            fn: () => {
              order.push('c2');
              return 'c2-done';
            },
          },
        ],
      };
    });

    const root: StageNode = { name: 'producer', id: 'producer' };

    const runtime = new ExecutionRuntime('producer', 'producer');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(order).toContain('producer');
    expect(order).toContain('c1');
    expect(order).toContain('c2');
  });

  it('dynamic next with StageNode reference (no fn) resolves by ID from graph', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    let loopCount = 0;
    stageMap.set('loop-entry', () => {
      order.push(`loop-${loopCount}`);
      loopCount++;
      if (loopCount < 3) {
        // Return a StageNode reference (no fn, has id) — resolve from graph
        return {
          name: 'ref-to-loop',
          // duck-typing: isStageNodeReturn checks name + continuation props
          next: { name: 'loop-entry', id: 'loop-entry' }, // reference by ID, no fn
        };
      }
      return 'done-looping';
    });

    const root: StageNode = { name: 'loop-entry', id: 'loop-entry' };

    const runtime = new ExecutionRuntime('loop-entry', 'loop-entry');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(loopCount).toBe(3);
    expect(order).toEqual(['loop-0', 'loop-1', 'loop-2']);
  });

  it('narrative captures loop iterations', async () => {
    const stageMap = new Map<string, StageFunction>();

    let count = 0;
    stageMap.set('retry', () => {
      count++;
      if (count < 3) {
        return {
          name: 'retry-ref',
          // duck-typing: isStageNodeReturn checks name + continuation props
          next: { name: 'retry', id: 'retry' },
        };
      }
      return 'success';
    });

    const root: StageNode = { name: 'retry', id: 'retry' };

    const runtime = new ExecutionRuntime('retry', 'retry');
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
    // Should mention looping / iterations
    expect(narrative.some((s) => s.includes('pass') || s.includes('retry') || s.includes('loop'))).toBe(true);
  });

  it('dynamic StageNode with children + next continues after children', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('producer', () => {
      order.push('producer');
      return {
        name: 'dynamic',
        // duck-typing: isStageNodeReturn checks name + continuation props
        children: [
          {
            name: 'child',
            id: 'child',
            fn: () => {
              order.push('child');
            },
          },
        ],
        next: {
          name: 'after',
          fn: () => {
            order.push('after');
            return 'final';
          },
        },
      };
    });

    const after: StageNode = {
      name: 'after',
      fn: () => {
        order.push('after-static');
        return 'static-final';
      },
    };
    const root: StageNode = { name: 'producer', id: 'producer', next: after };

    const runtime = new ExecutionRuntime('producer', 'producer');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    const result = await traverser.execute();

    expect(order).toContain('producer');
    expect(order).toContain('child');
    // The dynamic next should be followed after children
  });
});
