/**
 * DynamicChildren.test.ts
 *
 * Unit tests for dynamic children support in TreePipeline.
 * Tests the ability for stage handlers to return StageNode objects
 * for runtime-determined pipeline continuation.
 *
 * Key features tested:
 * - isStageNodeReturn() detection
 * - Dynamic children execution (fork pattern)
 * - Dynamic next execution (linear continuation)
 * - Dynamic decider/selector injection
 * - Context tree capture of dynamic nodes
 */

import type { PipelineStageFunction, StageNode } from '../../../src/core/pipeline';
import { Pipeline, isStageNodeReturn } from '../../../src/core/pipeline';
import type { ScopeFactory } from '../../../src/scope/core/types';

type TOut = any;
type TScope = any;
type PSF = PipelineStageFunction<TOut, TScope>;
type Node = StageNode<TOut, TScope>;

/* ===================== Minimal FakeStageContext ===================== */

class FakeStageContext {
  public pipelineId: string;
  public calls: Array<{ op: string; args: any[] }> = [];
  public store: Record<string, any> = {};
  public debugInfo: Record<string, any> = {};

  constructor(id = 'root') {
    this.pipelineId = id;
  }

  getValue(path: string[], key?: string) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.calls.push({ op: 'getValue', args: [path, key] });
    return this.store[k];
  }

  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.calls.push({ op: 'setObject', args: [path, key, value, shouldRedact] });
    this.store[k] = value;
  }

  updateObject(path: string[], key: string, value: unknown) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.calls.push({ op: 'updateObject', args: [path, key, value] });
    const cur = (this.store[k] as any) ?? {};
    this.store[k] = { ...cur, ...(value as object) };
  }

  commitPatch() {
    this.calls.push({ op: 'commitPatch', args: [] });
  }

  setAsDecider() {
    this.calls.push({ op: 'setAsDecider', args: [] });
    return this;
  }

  setAsFork() {
    this.calls.push({ op: 'setAsFork', args: [] });
    return this;
  }

  addDebugInfo(k: string, v: unknown) {
    this.calls.push({ op: 'addDebugInfo', args: [k, v] });
    this.debugInfo[k] = v;
  }

  addErrorInfo(k: string, v: unknown) {
    this.calls.push({ op: 'addErrorInfo', args: [k, v] });
  }

  addFlowDebugMessage(type: string, description: string, options?: Record<string, unknown>) {
    this.calls.push({ op: 'addFlowDebugMessage', args: [type, description, options] });
  }

  getFromGlobalContext(_k: string) {
    return undefined;
  }

  setRoot(_k: string, _v: unknown) {}

  createDeciderContext(_path: string, _role: string) {
    this.calls.push({ op: 'createDeciderContext', args: [] });
    return this;
  }

  createNextContext(_path: string, name: string) {
    this.calls.push({ op: 'createNextContext', args: [name] });
    return new FakeStageContext(name);
  }

  createChildContext(_pipelineId: string, id: string, name: string) {
    this.calls.push({ op: 'createChildContext', args: [id, name] });
    return new FakeStageContext(id);
  }
}

/* ===================== Jest mocks ===================== */

jest.mock('../../../src/core/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../../src/core/context/PipelineRuntime', () => {
  return {
    PipelineRuntime: class {
      public rootStageContext: any;
      constructor(rootName: string) {
        this.rootStageContext = new FakeStageContext(rootName);
      }
      getContextTree() {
        return { mocked: true };
      }
      setRootObject() {}
      getPipelines() {
        return ['root'];
      }
    },
    ContextTreeType: class {},
  };
});

/* ===================== Utilities ===================== */

const scopeFactory: ScopeFactory<any> = (ctx: any) => ctx;

const makeMap = (obj: Record<string, jest.Mock<any, any>>): Map<string, PSF> => {
  const m = new Map<string, PSF>();
  for (const [k, v] of Object.entries(obj)) m.set(k, v as unknown as PSF);
  return m;
};

/* ===================== isStageNodeReturn Detection Tests ===================== */

describe('isStageNodeReturn — duck-typing detection', () => {
  test('returns false for null/undefined', () => {
    expect(isStageNodeReturn(null)).toBe(false);
    expect(isStageNodeReturn(undefined)).toBe(false);
  });

  test('returns false for primitives', () => {
    expect(isStageNodeReturn('string')).toBe(false);
    expect(isStageNodeReturn(123)).toBe(false);
    expect(isStageNodeReturn(true)).toBe(false);
  });

  test('returns false for objects without name property', () => {
    expect(isStageNodeReturn({})).toBe(false);
    expect(isStageNodeReturn({ children: [] })).toBe(false);
    expect(isStageNodeReturn({ next: {} })).toBe(false);
  });

  test('returns false for objects with name but no continuation', () => {
    expect(isStageNodeReturn({ name: 'test' })).toBe(false);
    expect(isStageNodeReturn({ name: 'test', children: [] })).toBe(false); // empty children
  });

  test('returns true for StageNode with children', () => {
    const node: StageNode = {
      name: 'dynamic',
      children: [{ name: 'child1' }],
    };
    expect(isStageNodeReturn(node)).toBe(true);
  });

  test('returns true for StageNode with next', () => {
    const node: StageNode = {
      name: 'dynamic',
      next: { name: 'nextNode' },
    };
    expect(isStageNodeReturn(node)).toBe(true);
  });

  test('returns true for StageNode with nextNodeDecider', () => {
    const node: StageNode = {
      name: 'dynamic',
      nextNodeDecider: () => 'child1',
    };
    expect(isStageNodeReturn(node)).toBe(true);
  });

  test('returns true for StageNode with nextNodeSelector', () => {
    const node: StageNode = {
      name: 'dynamic',
      nextNodeSelector: () => ['child1', 'child2'],
    };
    expect(isStageNodeReturn(node)).toBe(true);
  });

  test('returns false for proxy objects that throw on property access', () => {
    const throwingProxy = new Proxy({}, {
      get() {
        throw new Error('Cannot access property');
      },
    });
    expect(isStageNodeReturn(throwingProxy)).toBe(false);
  });
});

/* ===================== Dynamic Children Tests ===================== */

describe('Dynamic Children — runtime fork pattern', () => {
  test('stage returning StageNode with children executes those children', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      // Return a StageNode with dynamic children
      return {
        name: 'dynamicResult',
        children: [
          { id: 'dyn1', name: 'DYN_CHILD_1', fn: () => { order.push('dyn1'); return 'result1'; } },
          { id: 'dyn2', name: 'DYN_CHILD_2', fn: () => { order.push('dyn2'); return 'result2'; } },
        ],
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    expect(order).toEqual(['parent', 'dyn1', 'dyn2']);
    expect(result).toHaveProperty('dyn1');
    expect(result).toHaveProperty('dyn2');
    expect(result.dyn1).toEqual({ result: 'result1', isError: false });
    expect(result.dyn2).toEqual({ result: 'result2', isError: false });
  });

  test('dynamic children with next continues to next after children', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicResult',
        children: [
          { id: 'dyn1', name: 'DYN_CHILD', fn: () => { order.push('dyn1'); return 'child-result'; } },
        ],
      } as StageNode;
    });

    const nextHandler = jest.fn(() => {
      order.push('next');
      return 'final';
    });

    const stageMap = makeMap({ PARENT: dynamicHandler, NEXT: nextHandler });
    const root: Node = {
      name: 'PARENT',
      fn: dynamicHandler,
      next: { name: 'NEXT', fn: nextHandler },
    };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    expect(order).toEqual(['parent', 'dyn1', 'next']);
    expect(result).toBe('final');
  });

  test('empty dynamic children array skips child execution', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicResult',
        children: [], // Empty children
      } as StageNode;
    });

    const nextHandler = jest.fn(() => {
      order.push('next');
      return 'final';
    });

    const stageMap = makeMap({ PARENT: dynamicHandler, NEXT: nextHandler });
    const root: Node = {
      name: 'PARENT',
      fn: dynamicHandler,
      next: { name: 'NEXT', fn: nextHandler },
    };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    // Empty children array means isStageNodeReturn returns false
    // So it's treated as regular output, not dynamic continuation
    expect(order).toEqual(['parent', 'next']);
    expect(result).toBe('final');
  });
});

/* ===================== Dynamic Next Tests ===================== */

describe('Dynamic Next — runtime linear continuation', () => {
  test('stage returning StageNode with next executes that next node', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicResult',
        next: {
          name: 'DYNAMIC_NEXT',
          fn: () => { order.push('dynamicNext'); return 'dynamic-result'; },
        },
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    expect(order).toEqual(['parent', 'dynamicNext']);
    expect(result).toBe('dynamic-result');
  });

  test('dynamic next with embedded fn executes directly', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicResult',
        next: {
          name: 'EMBEDDED_NEXT',
          fn: () => { order.push('embedded'); return 'embedded-result'; },
        },
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    expect(order).toEqual(['parent', 'embedded']);
    expect(result).toBe('embedded-result');
  });
});

/* ===================== Dynamic Decider Tests ===================== */

describe('Dynamic Decider — runtime single-choice branching', () => {
  test('stage returning StageNode with children and decider uses decider', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicResult',
        children: [
          { id: 'opt1', name: 'OPT_1', fn: () => { order.push('opt1'); return 'result1'; } },
          { id: 'opt2', name: 'OPT_2', fn: () => { order.push('opt2'); return 'result2'; } },
        ],
        nextNodeDecider: () => 'opt2', // Pick opt2
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    // Only opt2 should execute (decider picks it)
    expect(order).toEqual(['parent', 'opt2']);
    expect(result).toBe('result2');
  });
});

/* ===================== Dynamic Selector Tests ===================== */

describe('Dynamic Selector — runtime multi-choice branching', () => {
  test('stage returning StageNode with children and selector executes selected children', async () => {
    const order: string[] = [];
    
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicResult',
        children: [
          { id: 'tool1', name: 'TOOL_1', fn: () => { order.push('tool1'); return 'r1'; } },
          { id: 'tool2', name: 'TOOL_2', fn: () => { order.push('tool2'); return 'r2'; } },
          { id: 'tool3', name: 'TOOL_3', fn: () => { order.push('tool3'); return 'r3'; } },
        ],
        nextNodeSelector: () => ['tool1', 'tool3'], // Select tool1 and tool3
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    // Only tool1 and tool3 should execute
    expect(order).toContain('parent');
    expect(order).toContain('tool1');
    expect(order).toContain('tool3');
    expect(order).not.toContain('tool2');
    
    expect(result).toHaveProperty('tool1');
    expect(result).toHaveProperty('tool3');
    expect(result).not.toHaveProperty('tool2');
  });
});

/* ===================== Context Debug Info Tests ===================== */

describe('Context Debug Info — dynamic stage metadata', () => {
  test('dynamic children adds debug info for isDynamic and child count', async () => {
    const dynamicHandler = jest.fn(() => {
      return {
        name: 'dynamicResult',
        children: [
          { id: 'c1', name: 'C1', fn: () => 'r1' },
          { id: 'c2', name: 'C2', fn: () => 'r2' },
        ],
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    // Check that debug info was recorded
    const ctx = (p as any).pipelineRuntime.rootStageContext as FakeStageContext;
    const debugCalls = ctx.calls.filter(c => c.op === 'addDebugInfo');
    
    expect(debugCalls.some(c => c.args[0] === 'isDynamic' && c.args[1] === true)).toBe(true);
    expect(debugCalls.some(c => c.args[0] === 'dynamicChildCount' && c.args[1] === 2)).toBe(true);
    expect(debugCalls.some(c => c.args[0] === 'dynamicPattern' && c.args[1] === 'StageNodeReturn')).toBe(true);
  });
});

/* ===================== Error Handling Tests ===================== */

describe('Dynamic Children — error handling', () => {
  test('error in dynamic child is captured in results', async () => {
    const dynamicHandler = jest.fn(() => {
      return {
        name: 'dynamicResult',
        children: [
          { id: 'ok', name: 'OK', fn: () => 'success' },
          { id: 'fail', name: 'FAIL', fn: () => { throw new Error('child error'); } },
        ],
      } as StageNode;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', fn: dynamicHandler };
    
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    expect(result.ok).toEqual({ result: 'success', isError: false });
    expect(result.fail.isError).toBe(true);
    expect(result.fail.result).toBeInstanceOf(Error);
  });
});
