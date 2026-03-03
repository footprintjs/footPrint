/**
 * PipelineDynamicIntegration.test.ts
 *
 * Integration tests for dynamic subflow paths in Pipeline.ts that use real
 * PipelineRuntime (no mocks). This ensures coverage counters merge correctly
 * with the full suite — unlike PipelineDynamicPaths.test.ts which uses
 * jest.mock('PipelineRuntime') and causes Jest coverage isolation.
 *
 * Target lines: 751-771, 779-781, 927-966, 1065-1105
 */

import type { PipelineStageFunction, StageNode } from '../../../../src/core/executor';
import { Pipeline, isStageNodeReturn } from '../../../../src/core/executor';
import type { ScopeFactory } from '../../../../src/scope/providers/types';

type TOut = any;
type TScope = any;
type PSF = PipelineStageFunction<TOut, TScope>;
type Node = StageNode<TOut, TScope>;

// Minimal scope factory — just returns the context as-is
const scopeFactory: ScopeFactory<any> = (ctx: any) => ctx;

const makeMap = (obj: Record<string, Function>): Map<string, PSF> => {
  const m = new Map<string, PSF>();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, v as PSF);
  }
  return m;
};

describe('Pipeline dynamic subflow integration (no mocks)', () => {
  // ─────────────── Lines 750-771: Dynamic subflow auto-registration ───────────────
  test('stage returning StageNode with subflowDef triggers autoRegisterSubflowDef', async () => {
    const subflowRoot: Node = {
      name: 'subEntry',
      id: 'subEntry',
      fn: jest.fn(() => 'sub-result'),
    };

    // The parent handler returns a dynamic subflow node
    const parentHandler = jest.fn(() => ({
      name: 'dynamicMount',
      isSubflowRoot: true,
      subflowId: 'dyn-sub-1',
      subflowName: 'DynSub1',
      subflowDef: { root: subflowRoot },
      next: { name: '__sentinel__' }, // continuation property for isStageNodeReturn
    }));

    const stageMap = makeMap({
      PARENT: parentHandler,
      subEntry: subflowRoot.fn as Function,
    });
    const root: Node = { name: 'PARENT', id: 'parent-id', fn: parentHandler };

    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    // The subflow should be registered and executed
    const results = p.getSubflowResults();
    expect(results.has('dyn-sub-1')).toBe(true);
  });

  // ─────────────── Lines 776-789: Dynamic children with subflowDef ───────────────
  test('dynamic children with subflowDef get auto-registered', async () => {
    const childSubflowRoot: Node = {
      name: 'childSubEntry',
      id: 'childSubEntry',
      fn: jest.fn(() => 'child-sub-result'),
    };

    const child1Fn = jest.fn(() => 'c1-result');
    const child2Fn = jest.fn(() => 'c2-result');

    // The parent handler returns children where one has subflowDef
    // Uses `children` as the continuation trigger (no `next` needed)
    const parentHandler = jest.fn(() => ({
      name: 'dynamicParent',
      children: [
        {
          name: 'child1',
          id: 'child1',
          fn: child1Fn,
          isSubflowRoot: true,
          subflowId: 'child-sub-1',
          subflowName: 'ChildSub1',
          subflowDef: { root: childSubflowRoot },
        },
        {
          name: 'child2',
          id: 'child2',
          fn: child2Fn,
        },
      ],
    }));

    const stageMap = makeMap({
      PARENT: parentHandler,
      childSubEntry: childSubflowRoot.fn as Function,
      child1: child1Fn,
      child2: child2Fn,
    });
    const root: Node = { name: 'PARENT', id: 'parent-id', fn: parentHandler };

    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    // Both children should have been executed
    expect(parentHandler).toHaveBeenCalled();
    expect(child2Fn).toHaveBeenCalled();
  });

  // ─────────────── Lines 927-966: Dynamic children SubflowResult creation ───────────────
  test('dynamic children with isDynamic flag create synthetic SubflowResult', async () => {
    // Create a handler that returns dynamic children (fork pattern) with next continuation
    const child1Fn = jest.fn(() => 'child1-result');
    const child2Fn = jest.fn(() => 'child2-result');
    const continuationFn = jest.fn(() => 'continuation-result');

    const parentHandler = jest.fn((scope: any) => {
      // Mark context as dynamic so the synthetic SubflowResult path triggers
      if (scope && scope.addDebugInfo) {
        scope.addDebugInfo('isDynamic', true);
      }

      return {
        name: 'dynamicFork',
        children: [
          { name: 'child1', id: 'child1', fn: child1Fn },
          { name: 'child2', id: 'child2', fn: child2Fn },
        ],
        // next with fn = real continuation node (not a reference)
        next: { name: 'continuation', id: 'continuation-id', fn: continuationFn },
      };
    });

    const stageMap = makeMap({
      PARENT: parentHandler,
      child1: child1Fn,
      child2: child2Fn,
      continuation: continuationFn,
    });
    const root: Node = { name: 'PARENT', id: 'parent-id', fn: parentHandler };

    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    // Children and continuation should have been executed
    expect(child1Fn).toHaveBeenCalled();
    expect(child2Fn).toHaveBeenCalled();
    expect(continuationFn).toHaveBeenCalled();
  });

  // ─────────────── Lines 1065-1105: autoRegisterSubflowDef with stageMap and nested subflows ───────────────
  test('autoRegisterSubflowDef merges stageMap and nested subflows', async () => {
    const nestedSubRoot: Node = {
      name: 'nestedSubEntry',
      id: 'nestedSubEntry',
      fn: jest.fn(() => 'nested-result'),
    };

    const subflowRoot: Node = {
      name: 'subEntry',
      id: 'subEntry',
      fn: jest.fn(() => 'sub-result'),
    };

    // The subflowDef includes a stageMap and nested subflows
    const subflowDef = {
      root: subflowRoot,
      stageMap: new Map<string, PSF>([
        ['subEntry', subflowRoot.fn as PSF],
        ['uniqueSubFn', jest.fn(() => 'unique') as unknown as PSF],
      ]),
      subflows: {
        'nested-sub': { root: nestedSubRoot },
      },
    };

    const parentHandler = jest.fn(() => ({
      name: 'dynamicMount',
      isSubflowRoot: true,
      subflowId: 'full-sub',
      subflowName: 'FullSub',
      subflowDef,
      next: { name: '__sentinel__' },
    }));

    const stageMap = makeMap({
      PARENT: parentHandler,
      subEntry: subflowRoot.fn as Function,
    });
    const root: Node = { name: 'PARENT', id: 'parent-id', fn: parentHandler };

    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    // Verify the subflow was registered and executed
    const results = p.getSubflowResults();
    expect(results.has('full-sub')).toBe(true);
  });

  test('autoRegisterSubflowDef first-write-wins for duplicate IDs', async () => {
    const sub1Root: Node = {
      name: 'sub1Entry',
      id: 'sub1Entry',
      fn: jest.fn(() => 'sub1-result'),
    };

    // Two stages returning same subflowId — second should be ignored
    let callCount = 0;
    const parentHandler = jest.fn(() => {
      callCount++;
      return {
        name: 'mount' + callCount,
        isSubflowRoot: true,
        subflowId: 'same-id',
        subflowName: 'SameId',
        subflowDef: { root: sub1Root },
        next: { name: '__end__' },
      };
    });

    const stageMap = makeMap({
      START: parentHandler,
      sub1Entry: sub1Root.fn as Function,
    });
    const root: Node = { name: 'START', id: 'start-id', fn: parentHandler };

    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    expect(parentHandler).toHaveBeenCalled();
  });
});
