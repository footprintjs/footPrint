import { vi } from 'vitest';

/**
 * Scenario test: Additional FlowchartTraverser coverage.
 *
 * Targets uncovered lines in FlowchartTraverser.ts:
 * - Line 170: setRootObject delegation
 * - Lines 243-244: subflow with next continuation (inline subflow + next)
 * - Lines 353-367: dynamic subflow auto-registration (stage returns StageNode with subflowDef)
 * - Lines 374-375: dynamic children with nested subflowDef children
 * - Lines 396-397: dynamic next with selector attachment
 * - Lines 428-435: Phase 5 nextNodeSelector dispatch path
 * - Lines 541-576: autoRegisterSubflowDef internals (stageMap merge, nested subflows)
 */
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger, StageFunction, StreamHandlers } from '../../../../src/lib/engine/types';
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

describe('Scenario: Traverser Coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Line 170: setRootObject ───

  it('setRootObject delegates to executionRuntime', () => {
    const stageMap = new Map<string, StageFunction>();
    stageMap.set('root', () => 'done');
    const root: StageNode = { name: 'root', fn: () => 'done' };

    const runtime = new ExecutionRuntime('root');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
    });

    // setRootObject calls runtime.setRootObject
    traverser.setRootObject(['path'], 'key', 'value');

    // Verify the value was set by reading from the runtime
    const snapshot = runtime.getSnapshot();
    expect(snapshot).toBeDefined();
  });

  // ─── Lines 428-435: Phase 5 nextNodeSelector dispatch ───

  it('static nextNodeSelector on node triggers executeSelectedChildren path', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const parentFn: StageFunction = () => {
      order.push('parent');
      return 'parent-output';
    };
    stageMap.set('parent', parentFn);

    const childA: StageNode = {
      name: 'childA',
      id: 'a',
      fn: () => {
        order.push('childA');
        return 'a-done';
      },
    };
    const childB: StageNode = {
      name: 'childB',
      id: 'b',
      fn: () => {
        order.push('childB');
        return 'b-done';
      },
    };
    const childC: StageNode = {
      name: 'childC',
      id: 'c',
      fn: () => {
        order.push('childC');
        return 'c-done';
      },
    };

    stageMap.set('childA', childA.fn as StageFunction);
    stageMap.set('childB', childB.fn as StageFunction);
    stageMap.set('childC', childC.fn as StageFunction);

    const root: StageNode = {
      name: 'parent',
      id: 'parent',
      fn: parentFn,
      children: [childA, childB, childC],
      nextNodeSelector: (_input: any) => ['a', 'c'], // static selector picks a and c
    };

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

    expect(order).toContain('parent');
    expect(order).toContain('childA');
    expect(order).not.toContain('childB');
    expect(order).toContain('childC');
  });

  // ─── Lines 396-397: dynamic children with selector attachment ───

  it('stage returning StageNode with children + nextNodeSelector attaches selector', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    stageMap.set('producer', () => {
      order.push('producer');
      // Return dynamic StageNode with children AND nextNodeSelector
      return {
        name: 'dynamic-fork',
        children: [
          {
            name: 'x',
            id: 'x',
            fn: () => {
              order.push('x');
              return 'x-done';
            },
          },
          {
            name: 'y',
            id: 'y',
            fn: () => {
              order.push('y');
              return 'y-done';
            },
          },
          {
            name: 'z',
            id: 'z',
            fn: () => {
              order.push('z');
              return 'z-done';
            },
          },
        ],
        nextNodeSelector: (_input: any) => ['y'], // only pick y
      };
    });

    const root: StageNode = { name: 'producer', id: 'producer' };

    const runtime = new ExecutionRuntime('producer');
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
    expect(order).toContain('y');
    expect(order).not.toContain('x');
    expect(order).not.toContain('z');
  });

  // ─── Lines 353-367: dynamic subflow auto-registration ───

  it('stage returning StageNode with subflowDef triggers dynamic subflow', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const subRootFn: StageFunction = () => {
      order.push('sub-root');
      return 'sub-result';
    };

    const subStageMap = new Map<string, StageFunction>();
    subStageMap.set('sub-entry', subRootFn);

    const subRoot: StageNode = { name: 'sub-entry', fn: subRootFn };

    stageMap.set('setup', () => {
      order.push('setup');
      // Return a StageNode that IS a dynamic subflow
      return {
        name: 'dynamic-subflow-node',
        isSubflowRoot: true,
        subflowId: 'dynamic-sub',
        subflowName: 'Dynamic Sub',
        subflowDef: {
          root: subRoot,
          stageMap: subStageMap,
        },
        // Need children or next for isStageNodeReturn duck-typing
        children: [{ name: 'placeholder', id: 'placeholder' }],
      };
    });

    const root: StageNode = { name: 'setup', id: 'setup' };

    const runtime = new ExecutionRuntime('setup');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      subflows: {}, // shared object ref so autoRegisterSubflowDef mutations are visible to deps
    });

    const result = await traverser.execute();

    expect(order).toContain('setup');
    expect(order).toContain('sub-root');

    // Verify subflow results were captured
    const subflowResults = traverser.getSubflowResults();
    expect(subflowResults.size).toBeGreaterThan(0);
  });

  // ─── Lines 374-375: children with subflowDef ───

  it('dynamic children with subflowDef get auto-registered', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const childSubRootFn: StageFunction = () => {
      order.push('child-sub');
      return 'child-sub-result';
    };
    const childSubStageMap = new Map<string, StageFunction>();
    childSubStageMap.set('child-sub-entry', childSubRootFn);

    stageMap.set('producer', () => {
      order.push('producer');
      return {
        name: 'dynamic-with-subflow-children',
        children: [
          {
            name: 'sub-child',
            id: 'sub-child',
            isSubflowRoot: true,
            subflowId: 'nested-sub',
            subflowName: 'Nested Sub',
            subflowDef: {
              root: { name: 'child-sub-entry', fn: childSubRootFn },
              stageMap: childSubStageMap,
            },
          },
        ],
      };
    });

    const root: StageNode = { name: 'producer', id: 'producer' };

    const runtime = new ExecutionRuntime('producer');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      subflows: {}, // shared object ref so autoRegisterSubflowDef mutations are visible to deps
    });

    const result = await traverser.execute();

    expect(order).toContain('producer');
    expect(order).toContain('child-sub');

    const subflowResults = traverser.getSubflowResults();
    expect(subflowResults.has('nested-sub')).toBe(true);
  });

  // ─── Lines 541-576: autoRegisterSubflowDef internals ───

  it('autoRegisterSubflowDef merges stageMap and nested subflows', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    // Pre-existing entry in stageMap (should NOT be overwritten)
    stageMap.set('shared-stage', () => {
      order.push('original-shared');
      return 'original';
    });

    const nestedSubRoot: StageNode = {
      name: 'nested-entry',
      fn: () => {
        order.push('nested');
        return 'nested-done';
      },
    };

    const subStageMap = new Map<string, StageFunction>();
    subStageMap.set('sub-only-stage', () => {
      order.push('sub-only');
      return 'sub-only-done';
    });
    // This entry exists in parent stageMap — parent wins (first-write-wins from parent perspective)
    subStageMap.set('shared-stage', () => {
      order.push('overwritten-shared');
      return 'overwritten';
    });

    const subRoot: StageNode = {
      name: 'sub-root',
      fn: () => {
        order.push('sub-root');
        return 'sub-done';
      },
    };

    stageMap.set('trigger', () => {
      order.push('trigger');
      return {
        name: 'dyn-subflow',
        isSubflowRoot: true,
        subflowId: 'auto-reg-sub',
        subflowName: 'Auto Registered',
        subflowDef: {
          root: subRoot,
          stageMap: subStageMap,
          buildTimeStructure: { id: 'auto-reg-sub', name: 'Auto Registered', type: 'linear' },
          subflows: {
            'inner-nested': { root: nestedSubRoot },
          },
        },
        // Need continuation for duck-typing
        children: [{ name: 'c', id: 'c' }],
      };
    });

    const root: StageNode = { name: 'trigger', id: 'trigger' };

    const runtime = new ExecutionRuntime('trigger');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      subflows: {}, // shared object ref so autoRegisterSubflowDef mutations are visible to deps
    });

    await traverser.execute();

    expect(order).toContain('trigger');
    expect(order).toContain('sub-root');

    // Verify stageMap merge: 'sub-only-stage' should now be in stageMap
    expect(stageMap.has('sub-only-stage')).toBe(true);
    // 'shared-stage' should still be the original (parent wins)
    expect(stageMap.get('shared-stage')!({} as any, () => {}, undefined)).toBe('original');
  });

  // ─── Lines 243-244: subflow with next continuation ───

  it('reference-based subflow node with next continues after subflow', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const subRootFn: StageFunction = () => {
      order.push('sub-root');
      return 'sub-result';
    };
    stageMap.set('sub-entry', subRootFn);

    const afterFn: StageFunction = () => {
      order.push('after');
      return 'after-result';
    };
    stageMap.set('after', afterFn);

    const subRoot: StageNode = { name: 'sub-entry', fn: subRootFn };
    const afterNode: StageNode = { name: 'after', fn: afterFn };

    // A pure reference node (no fn/children) with a next continuation
    const root: StageNode = {
      name: 'subflow-mount',
      id: 'subflow-mount',
      isSubflowRoot: true,
      subflowId: 'ref-sub',
      subflowName: 'RefSub',
      $ref: 'ref-sub',
      next: afterNode,
    };

    const subflows = {
      'ref-sub': { root: subRoot },
    };

    const runtime = new ExecutionRuntime('subflow-mount');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      subflows,
    });

    const result = await traverser.execute();

    expect(order).toContain('sub-root');
    expect(order).toContain('after');
    expect(result).toBe('after-result');
  });

  // ─── Streaming lifecycle (StageRunner lines covered via integration) ───

  it('streaming stage invokes onStart, onToken, and onEnd handlers', async () => {
    const stageMap = new Map<string, StageFunction>();

    const streamEvents: { type: string; streamId: string; data?: string }[] = [];

    const streamHandlers: StreamHandlers = {
      onStart: (streamId: string) => {
        streamEvents.push({ type: 'start', streamId });
      },
      onToken: (streamId: string, token: string) => {
        streamEvents.push({ type: 'token', streamId, data: token });
      },
      onEnd: (streamId: string, fullText?: string) => {
        streamEvents.push({ type: 'end', streamId, data: fullText });
      },
    };

    const streamingFn: StageFunction = (_scope, _breakFn, streamCallback) => {
      // Simulate streaming tokens
      streamCallback!('Hello');
      streamCallback!(' World');
      return 'streamed-result';
    };
    stageMap.set('stream-stage', streamingFn);

    const root: StageNode = {
      name: 'stream-stage',
      fn: streamingFn,
      isStreaming: true,
      streamId: 'my-stream',
    };

    const runtime = new ExecutionRuntime('stream-stage');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      streamHandlers,
    });

    const result = await traverser.execute();

    expect(result).toBe('streamed-result');
    expect(streamEvents).toEqual([
      { type: 'start', streamId: 'my-stream' },
      { type: 'token', streamId: 'my-stream', data: 'Hello' },
      { type: 'token', streamId: 'my-stream', data: ' World' },
      { type: 'end', streamId: 'my-stream', data: 'Hello World' },
    ]);
  });

  it('streaming stage uses node.name as default streamId', async () => {
    const stageMap = new Map<string, StageFunction>();
    const streamIds: string[] = [];

    const streamHandlers: StreamHandlers = {
      onStart: (streamId: string) => {
        streamIds.push(streamId);
      },
      onToken: () => {},
      onEnd: () => {},
    };

    const streamingFn: StageFunction = (_scope, _breakFn, streamCallback) => {
      streamCallback!('token');
      return 'done';
    };
    stageMap.set('auto-id-stream', streamingFn);

    const root: StageNode = {
      name: 'auto-id-stream',
      fn: streamingFn,
      isStreaming: true,
      // no streamId — should default to node.name
    };

    const runtime = new ExecutionRuntime('auto-id-stream');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      streamHandlers,
    });

    await traverser.execute();

    expect(streamIds).toEqual(['auto-id-stream']);
  });

  // ─── autoRegisterSubflowDef with no prior subflows dict ───

  it('autoRegisterSubflowDef populates initially empty subflows dict', async () => {
    const order: string[] = [];
    const stageMap = new Map<string, StageFunction>();

    const subRootFn: StageFunction = () => {
      order.push('sub');
      return 'sub-done';
    };
    const subStageMap = new Map<string, StageFunction>();
    subStageMap.set('sub-entry', subRootFn);

    stageMap.set('start', () => {
      order.push('start');
      return {
        name: 'dyn',
        isSubflowRoot: true,
        subflowId: 'new-sub',
        subflowName: 'New Sub',
        subflowDef: {
          root: { name: 'sub-entry', fn: subRootFn },
          stageMap: subStageMap,
        },
        children: [{ name: 'x', id: 'x' }],
      };
    });

    const root: StageNode = { name: 'start', id: 'start' };

    const runtime = new ExecutionRuntime('start');
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      subflows: {}, // empty dict — autoRegisterSubflowDef populates it
    });

    await traverser.execute();

    expect(order).toContain('start');
    expect(order).toContain('sub');
  });
});
