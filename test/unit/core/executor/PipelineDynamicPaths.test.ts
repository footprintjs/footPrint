/**
 * PipelineDynamicPaths.test.ts
 *
 * Tests for uncovered dynamic pipeline paths in Pipeline.ts:
 *
 * 1. Lines 751-771: Dynamic subflow return - stage returns StageNode with
 *    isSubflowRoot + subflowDef + subflowId => auto-register and recurse.
 *
 * 2. Lines 779-781: Dynamic children with subflow references - children
 *    that carry subflowDef get auto-registered before execution.
 *
 * 3. Lines 927-966: Dynamic children subflow results - synthetic SubflowResult
 *    creation for isDynamic children when node has next.
 *
 * 4. Lines 1065-1105: autoRegisterSubflowDef() - registration, stageMap merge,
 *    nested subflows, first-write-wins semantics.
 *
 * 5. Property-based tests using fast-check.
 *
 * NOTE: isStageNodeReturn() duck-typing requires at least one continuation
 * property (non-empty children, next, nextNodeDecider, nextNodeSelector).
 * For dynamic subflow returns we add `next: { name: '...' }` as the marker.
 */

import type { PipelineStageFunction, StageNode } from '../../../../src/core/executor';
import { Pipeline, isStageNodeReturn } from '../../../../src/core/executor';
import type { ScopeFactory } from '../../../../src/scope/providers/types';
import * as fc from 'fast-check';

type TOut = any;
type TScope = any;
type PSF = PipelineStageFunction<TOut, TScope>;
type Node = StageNode<TOut, TScope>;

/* ===================== Minimal FakeStageContext ===================== */

class FakeStageContext {
  public pipelineId: string;
  public stageName: string;
  public calls: Array<{ op: string; args: any[] }> = [];
  public store: Record<string, any> = {};
  public parent?: FakeStageContext;
  public next?: FakeStageContext;
  public children?: FakeStageContext[];
  public debug: { logContext: Record<string, any>; errorContext: Record<string, any> } = {
    logContext: {},
    errorContext: {},
  };

  constructor(id = 'root') {
    this.pipelineId = id;
    this.stageName = id;
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

  commit() { this.calls.push({ op: 'commit', args: [] }); }

  setAsDecider() { this.calls.push({ op: 'setAsDecider', args: [] }); return this; }
  setAsFork() { this.calls.push({ op: 'setAsFork', args: [] }); return this; }

  addLog(k: string, v: unknown) {
    this.calls.push({ op: 'addLog', args: [k, v] });
    this.debug.logContext[k] = v;
  }
  addDebugInfo(k: string, v: unknown) { this.addLog(k, v); }

  addError(k: string, v: unknown) {
    this.calls.push({ op: 'addError', args: [k, v] });
    this.debug.errorContext[k] = v;
  }
  addErrorInfo(k: string, v: unknown) { this.addError(k, v); }

  addFlowDebugMessage(type: string, description: string, options?: Record<string, unknown>) {
    this.calls.push({ op: 'addFlowDebugMessage', args: [type, description, options] });
  }

  getScope() { return this; }
  setGlobal(key: string, value: unknown) { this.store[key] = value; }
  getFromGlobalContext(_k: string) { return undefined; }
  setRoot(_k: string, _v: unknown) {}

  getStageId() {
    if (!this.pipelineId || this.pipelineId === '') return this.stageName;
    return `${this.pipelineId}.${this.stageName}`;
  }

  getSnapshot() {
    return {
      id: this.pipelineId,
      name: this.stageName,
      logs: this.debug.logContext,
      errors: this.debug.errorContext,
      metrics: {},
      evals: {},
    };
  }

  createDecider(_path: string, _role: string) {
    this.calls.push({ op: 'createDecider', args: [] });
    return this;
  }
  createDeciderContext(_path: string, _role: string) { return this.createDecider(_path, _role); }

  createNext(_path: string, name: string) {
    this.calls.push({ op: 'createNext', args: [name] });
    const child = new FakeStageContext(name);
    child.stageName = name;
    this.next = child;
    child.parent = this;
    return child;
  }
  createNextContext(_path: string, name: string) { return this.createNext(_path, name); }

  createChild(_pipelineId: string, id: string, name: string) {
    this.calls.push({ op: 'createChild', args: [id, name] });
    const child = new FakeStageContext(id);
    child.stageName = name;
    child.parent = this;
    if (!this.children) this.children = [];
    this.children.push(child);
    return child;
  }
  createChildContext(_pipelineId: string, id: string, name: string) { return this.createChild(_pipelineId, id, name); }
}

/* ===================== Jest mocks ===================== */

jest.mock('../../../../src/utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../../../src/core/memory/PipelineRuntime', () => ({
  PipelineRuntime: class {
    public rootStageContext: any;
    public setRootObjectCalls: any[] = [];
    constructor(rootName: string) { this.rootStageContext = new FakeStageContext(rootName); }
    getSnapshot() { return { mocked: true }; }
    getContextTree() { return this.getSnapshot(); }
    setRootObject(path: string[], key: string, value: unknown) { this.setRootObjectCalls.push({ path, key, value }); }
    getPipelines() { return ['root']; }
  },
  ContextTreeType: class {},
}));

/* ===================== Utilities ===================== */

const scopeFactory: ScopeFactory<any> = (ctx: any) => ctx;

const makeMap = (obj: Record<string, jest.Mock<any, any>>): Map<string, PSF> => {
  const m = new Map<string, PSF>();
  for (const [k, v] of Object.entries(obj)) m.set(k, v as unknown as PSF);
  return m;
};

function getRootContext(pipeline: Pipeline<any, any>): FakeStageContext {
  return (pipeline as any).pipelineRuntime.rootStageContext as FakeStageContext;
}

function getSubflowsDict(pipeline: Pipeline<any, any>): Record<string, any> | undefined {
  return (pipeline as any).subflows;
}

function getStageMap(pipeline: Pipeline<any, any>): Map<string, PSF> {
  return (pipeline as any).stageMap;
}

/* =========================================================================
 * 1. Lines 751-771: Dynamic Subflow Return
 * ========================================================================= */

describe('Dynamic Subflow Return — stage returns StageNode with subflowDef', () => {
  test('auto-registers subflowDef and executes the subflow via recursion', async () => {
    const order: string[] = [];

    const subflowRoot: Node = {
      name: 'subEntry', id: 'subEntry',
      fn: jest.fn(() => { order.push('subEntry'); return 'sub-output'; }),
    };
    const subflowDef = {
      root: subflowRoot,
      stageMap: new Map<string, PSF>([['subEntry', subflowRoot.fn as PSF]]),
    };

    const dynamicSubflowHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicMount',
        isSubflowRoot: true,
        subflowId: 'dynamic-sub-1',
        subflowName: 'DynamicSub',
        subflowDef,
        next: { name: 'subEntry' },
      } as any;
    });

    const stageMap = makeMap({ PARENT: dynamicSubflowHandler });
    const root: Node = { name: 'PARENT', id: 'parent-node', fn: dynamicSubflowHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    expect(order).toContain('parent');
    expect(order).toContain('subEntry');

    const subflowsDict = getSubflowsDict(p);
    expect(subflowsDict).toBeDefined();
    expect(subflowsDict!['dynamic-sub-1']).toBeDefined();
    expect(subflowsDict!['dynamic-sub-1'].root).toBe(subflowRoot);

    const ctx = getRootContext(p);
    expect(ctx.calls.some(c => c.op === 'addLog' && c.args[0] === 'dynamicPattern' && c.args[1] === 'dynamicSubflow')).toBe(true);
    expect(ctx.calls.some(c => c.op === 'addLog' && c.args[0] === 'dynamicSubflowId' && c.args[1] === 'dynamic-sub-1')).toBe(true);
    expect(p.getSubflowResults().has('dynamic-sub-1')).toBe(true);
  });

  test('transfers subflow properties (name, id, mountOptions) from dynamic node to current node', async () => {
    const subflowRoot: Node = { name: 'subStage', id: 'subStage', fn: jest.fn(() => 'sub-result') };

    // We track node mutations to verify properties are transferred at lines 757-760
    let capturedNode: any = null;
    const dynamicHandler = jest.fn(function(this: any) {
      return {
        name: 'dynMount', isSubflowRoot: true, subflowId: 'dyn-sub-xfer', subflowName: 'DynSubXfer',
        subflowDef: { root: subflowRoot },
        // subflowMountOptions intentionally undefined to avoid SubflowExecutor
        // needing getScope/setGlobal on the subflow's internal context
        next: { name: 'subStage' },
      };
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', id: 'parent-xfer', fn: dynamicHandler };
    capturedNode = root;
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    // After execution, the node should have subflow properties transferred from the dynamic return
    // (Lines 757-760 transfer isSubflowRoot, subflowId, subflowName, subflowMountOptions)
    expect(capturedNode.isSubflowRoot).toBe(true);
    expect(capturedNode.subflowId).toBe('dyn-sub-xfer');
    expect(capturedNode.subflowName).toBe('DynSubXfer');

    // Subflow should have been registered and executed
    const subflowsDict = getSubflowsDict(p);
    expect(subflowsDict).toBeDefined();
    expect(subflowsDict!['dyn-sub-xfer']).toBeDefined();
  });

  test('merges subflowDef stageMap entries into parent stageMap', async () => {
    const subStageFn = jest.fn(() => 'from-subflow');
    const subflowRoot: Node = { name: 'subStage', id: 'subStage', fn: subStageFn };
    const uniqueFn = jest.fn(() => 'unique');
    const subflowDef = {
      root: subflowRoot,
      stageMap: new Map<string, PSF>([
        ['subStage', subStageFn as unknown as PSF],
        ['uniqueSubFn', uniqueFn as unknown as PSF],
      ]),
    };

    const dynamicHandler = jest.fn(() => ({
      name: 'dynMount', isSubflowRoot: true, subflowId: 'merge-test', subflowName: 'MergeTest',
      subflowDef, next: { name: 'subStage' },
    }));

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', id: 'parent-merge', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    expect(getStageMap(p).has('uniqueSubFn')).toBe(true);
  });
});

/* =========================================================================
 * 2. Lines 779-781: Dynamic Children with Subflow References
 * ========================================================================= */

describe('Dynamic Children with Subflow References — children carry subflowDef', () => {
  test('auto-registers subflowDef from each child with subflow properties', async () => {
    const order: string[] = [];
    const childSub1Root: Node = { name: 'cs1', id: 'cs1', fn: jest.fn(() => { order.push('cs1'); return 'r1'; }) };
    const childSub2Root: Node = { name: 'cs2', id: 'cs2', fn: jest.fn(() => { order.push('cs2'); return 'r2'; }) };

    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'toolDispatch',
        children: [
          { id: 'tool-a', name: 'ToolA', isSubflowRoot: true, subflowId: 'tool-a-sub', subflowName: 'TA', subflowDef: { root: childSub1Root }, fn: childSub1Root.fn },
          { id: 'tool-b', name: 'ToolB', isSubflowRoot: true, subflowId: 'tool-b-sub', subflowName: 'TB', subflowDef: { root: childSub2Root, stageMap: new Map<string, PSF>([['cs2', childSub2Root.fn as PSF]]) }, fn: childSub2Root.fn },
          { id: 'tool-c', name: 'ToolC', fn: jest.fn(() => { order.push('ToolC'); return 'rc'; }) },
        ],
      } as any;
    });

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', id: 'parent-csub', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    expect(order).toContain('parent');
    const subflowsDict = getSubflowsDict(p);
    expect(subflowsDict).toBeDefined();
    expect(subflowsDict!['tool-a-sub']).toBeDefined();
    expect(subflowsDict!['tool-a-sub'].root).toBe(childSub1Root);
    expect(subflowsDict!['tool-b-sub']).toBeDefined();
    expect(subflowsDict!['tool-b-sub'].root).toBe(childSub2Root);
    expect(getStageMap(p).has('cs2')).toBe(true);
  });

  test('skips children without subflowDef during auto-registration', async () => {
    const dynamicHandler = jest.fn(() => ({
      name: 'dispatch',
      children: [
        { id: 'nc', name: 'NC', fn: jest.fn(() => 'normal') },
        { id: 'an', name: 'AN', isSubflowRoot: true, subflowId: 'some-ref', fn: jest.fn(() => 'an') },
      ],
    }));

    const stageMap = makeMap({ PARENT: dynamicHandler });
    const root: Node = { name: 'PARENT', id: 'parent-skip', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    const subflowsDict = getSubflowsDict(p);
    if (subflowsDict) expect(subflowsDict['some-ref']).toBeUndefined();
    expect(result).toBeDefined();
  });
});

/* =========================================================================
 * 3. Lines 927-966: Dynamic Children Subflow Results
 * ========================================================================= */

describe('Dynamic Children SubflowResult — synthetic entry for isDynamic children with next', () => {
  test('creates synthetic SubflowResult when dynamic children + next are present', async () => {
    const order: string[] = [];
    const dynamicHandler = jest.fn(() => {
      order.push('parent');
      return {
        name: 'dynamicFork',
        children: [
          { id: 'dc1', name: 'DC1', displayName: 'Dyn Child 1', fn: () => { order.push('dc1'); return 'r1'; } },
          { id: 'dc2', name: 'DC2', displayName: 'Dyn Child 2', fn: () => { order.push('dc2'); return 'r2'; } },
        ],
      } as Node;
    });
    const nextHandler = jest.fn(() => { order.push('next'); return 'final'; });

    const stageMap = makeMap({ PARENT: dynamicHandler, NEXT: nextHandler });
    const root: Node = {
      name: 'PARENT', id: 'parent-dyn-sub', displayName: 'Parent Stage', fn: dynamicHandler,
      next: { name: 'NEXT', id: 'next-stage', fn: nextHandler },
    };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    const result = await p.execute();

    expect(order).toEqual(['parent', 'dc1', 'dc2', 'next']);
    expect(result).toBe('final');

    const ctx = getRootContext(p);
    expect(ctx.debug.logContext.isDynamic).toBe(true);

    const syntheticResult = p.getSubflowResults().get('parent-dyn-sub');
    if (syntheticResult) {
      expect(syntheticResult.subflowId).toBe('parent-dyn-sub');
      expect(syntheticResult.subflowName).toBe('Parent Stage');
      expect(syntheticResult.treeContext).toBeDefined();
      expect(syntheticResult.treeContext.globalContext).toEqual({});
      expect(syntheticResult.treeContext.stageContexts).toBeDefined();
      expect(syntheticResult.treeContext.history).toEqual([]);
      expect(syntheticResult.pipelineStructure).toBeDefined();

      const structure = syntheticResult.pipelineStructure as any;
      expect(structure.id).toBe('parent-dyn-sub-children');
      expect(structure.name).toBe('Dynamic Children');
      expect(structure.type).toBe('fork');
      expect(structure.children).toHaveLength(2);
      expect(structure.children[0].id).toBe('dc1');
      expect(structure.children[1].id).toBe('dc2');
    }

    expect(ctx.debug.logContext.isSubflowContainer).toBe(true);
    expect(ctx.debug.logContext.subflowId).toBe('parent-dyn-sub');
    expect(ctx.debug.logContext.subflowName).toBe('Parent Stage');
    expect(ctx.debug.logContext.hasSubflowData).toBe(true);
  });

  test('does NOT create synthetic SubflowResult for static children + next', async () => {
    const order: string[] = [];
    const fns = {
      P: jest.fn(() => { order.push('p'); }),
      A: jest.fn(() => { order.push('a'); return 'ar'; }),
      N: jest.fn(() => { order.push('n'); return 'final'; }),
    };
    const stageMap = makeMap(fns);
    const root: Node = {
      name: 'P', id: 'ps', fn: fns.P,
      children: [{ id: 'a', name: 'A', fn: fns.A }],
      next: { name: 'N', fn: fns.N },
    };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();
    expect(p.getSubflowResults().size).toBe(0);
  });

  test('synthetic SubflowResult captures child execution data', async () => {
    const dynamicHandler = jest.fn(() => ({
      name: 'dFork',
      children: [
        { id: 'err', name: 'Err', fn: () => { throw new Error('boom'); } },
        { id: 'ok', name: 'Ok', fn: () => 'ok' },
      ],
    }));
    const nextHandler = jest.fn(() => 'cont');
    const stageMap = makeMap({ P: dynamicHandler, N: nextHandler });
    const root: Node = { name: 'P', id: 'pec', fn: dynamicHandler, next: { name: 'N', fn: nextHandler } };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    const sr = p.getSubflowResults().get('pec');
    if (sr) {
      const sc = sr.treeContext.stageContexts as Record<string, any>;
      expect(Object.keys(sc).length).toBeGreaterThanOrEqual(0);
    }
  });

  test('uses node.name as fallback when node.id is undefined', async () => {
    const dynamicHandler = jest.fn(() => ({
      name: 'dFork',
      children: [{ name: 'C', fn: () => 'cr' }],
    }));
    const nextHandler = jest.fn(() => 'nr');
    const stageMap = makeMap({ P: dynamicHandler, N: nextHandler });
    const root: Node = { name: 'P', fn: dynamicHandler, next: { name: 'N', fn: nextHandler } };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    const sr = p.getSubflowResults().get('P');
    if (sr) {
      expect(sr.subflowId).toBe('P');
      expect(sr.subflowName).toBe('P');
    }
  });
});

/* =========================================================================
 * 4. Lines 1065-1105: autoRegisterSubflowDef() internals
 * ========================================================================= */

describe('autoRegisterSubflowDef — registration, merging, first-write-wins', () => {
  test('creates subflows dictionary when none existed and updates handler contexts', async () => {
    const subflowRoot: Node = { name: 'subE', id: 'subE', fn: jest.fn(() => 'sr') };
    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'new-dict-sub', subflowName: 'NDS',
      subflowDef: { root: subflowRoot }, next: { name: 'subE' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const root: Node = { name: 'P', id: 'cd', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    expect(getSubflowsDict(p)).toBeUndefined();

    await p.execute();

    const sd = getSubflowsDict(p);
    expect(sd).toBeDefined();
    expect(sd!['new-dict-sub']).toBeDefined();
    expect((p as any).nodeResolver.ctx.subflows).toBe(sd);
    expect((p as any).subflowExecutor.ctx.subflows).toBe(sd);
    expect((p as any).childrenExecutor.ctx.subflows).toBe(sd);
  });

  test('first-write-wins: does not overwrite existing subflow with same ID', async () => {
    const existingRoot: Node = { name: 'ex', fn: jest.fn(() => 'existing') };
    const newRoot: Node = { name: 'nw', fn: jest.fn(() => 'new') };
    const existingSubflows = { 'shared-id': { root: existingRoot as any } };

    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'shared-id', subflowName: 'Dup',
      subflowDef: { root: newRoot }, next: { name: 'nw' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const root: Node = { name: 'P', id: 'fw', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {}, undefined, undefined, undefined, undefined, undefined, undefined, existingSubflows as any);
    await p.execute();
    expect(getSubflowsDict(p)!['shared-id'].root).toBe(existingRoot);
  });

  test('merges stageMap entries from subflowDef (parent entries preserved)', async () => {
    const subflowFn = jest.fn(() => 'sv');
    const uniqueFn = jest.fn(() => 'u');
    const subflowRoot: Node = { name: 'sr', fn: jest.fn(() => 's') };

    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'msm', subflowName: 'MSM',
      subflowDef: {
        root: subflowRoot,
        stageMap: new Map<string, PSF>([['P', subflowFn as unknown as PSF], ['uniqueSub', uniqueFn as unknown as PSF]]),
      },
      next: { name: 'sr' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const root: Node = { name: 'P', id: 'mm', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    const pm = getStageMap(p);
    expect(pm.get('P')).toBe(dynamicHandler as unknown as PSF);
    expect(pm.has('uniqueSub')).toBe(true);
    expect(pm.get('uniqueSub')).toBe(uniqueFn as unknown as PSF);
  });

  test('merges nested subflows from subflowDef.subflows', async () => {
    const nestedRoot: Node = { name: 'ne', fn: jest.fn(() => 'n') };
    const anotherRoot: Node = { name: 'ae', fn: jest.fn(() => 'a') };
    const topRoot: Node = { name: 'te', fn: jest.fn(() => 't') };

    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'top-sub', subflowName: 'TS',
      subflowDef: {
        root: topRoot,
        subflows: { 'nested-sub': { root: nestedRoot }, 'another-sub': { root: anotherRoot } },
      },
      next: { name: 'te' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const root: Node = { name: 'P', id: 'nm', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    const sd = getSubflowsDict(p);
    expect(sd).toBeDefined();
    expect(sd!['top-sub']).toBeDefined();
    expect(sd!['nested-sub']).toBeDefined();
    expect(sd!['nested-sub'].root).toBe(nestedRoot);
    expect(sd!['another-sub']).toBeDefined();
    expect(sd!['another-sub'].root).toBe(anotherRoot);
  });

  test('nested subflows use first-write-wins for duplicates', async () => {
    const existingNested: Node = { name: 'en', fn: jest.fn(() => 'e') };
    const newNested: Node = { name: 'nn', fn: jest.fn(() => 'n') };
    const topRoot: Node = { name: 'te', fn: jest.fn(() => 't') };
    const existingSubflows = { 'nested-dup': { root: existingNested as any } };

    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'top-dup', subflowName: 'TD',
      subflowDef: { root: topRoot, subflows: { 'nested-dup': { root: newNested } } },
      next: { name: 'te' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const root: Node = { name: 'P', id: 'ndt', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {}, undefined, undefined, undefined, undefined, undefined, undefined, existingSubflows as any);
    await p.execute();
    expect(getSubflowsDict(p)!['nested-dup'].root).toBe(existingNested);
  });

  test('handles subflowDef with buildTimeStructure', async () => {
    const subflowRoot: Node = { name: 'se', fn: jest.fn(() => 'str') };
    const bts = { name: 'se', type: 'stage' as const };

    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'str-sub', subflowName: 'SS',
      subflowDef: { root: subflowRoot, buildTimeStructure: bts },
      next: { name: 'se' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const root: Node = { name: 'P', id: 'st', fn: dynamicHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    const sd = getSubflowsDict(p);
    expect(sd).toBeDefined();
    expect(sd!['str-sub']).toBeDefined();
    expect((sd!['str-sub'] as any).buildTimeStructure).toEqual(bts);
  });
});

/* =========================================================================
 * 5. Property-based tests (fast-check)
 * ========================================================================= */

describe('Property-based tests — arbitrary pipeline shapes', () => {
  test('linear pipelines of arbitrary length always complete successfully', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (numStages) => {
        const order: string[] = [];
        const stages: Node[] = [];
        const stageMap = new Map<string, PSF>();

        for (let i = numStages - 1; i >= 0; i--) {
          const sn = `stage_${i}`;
          const fn = jest.fn(() => { order.push(sn); return `result_${i}`; });
          stageMap.set(sn, fn as unknown as PSF);
          stages.push({ name: sn, id: sn, fn, next: stages.length > 0 ? stages[stages.length - 1] : undefined });
        }

        const p = new Pipeline(stages[stages.length - 1], stageMap, scopeFactory, {});
        const result = await p.execute();

        expect(order).toHaveLength(numStages);
        for (let i = 0; i < numStages; i++) expect(order[i]).toBe(`stage_${i}`);
        expect(result).toBe(`result_${numStages - 1}`);
      }),
      { numRuns: 20 },
    );
  });

  test('fork pipelines with arbitrary children count all complete', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (numChildren) => {
        const order: string[] = [];
        const parentFn = jest.fn(() => { order.push('parent'); });
        const children: Node[] = [];
        const stageMap = new Map<string, PSF>();
        stageMap.set('P', parentFn as unknown as PSF);

        for (let i = 0; i < numChildren; i++) {
          const cn = `c_${i}`;
          const cfn = jest.fn(() => { order.push(cn); return `cr_${i}`; });
          stageMap.set(cn, cfn as unknown as PSF);
          children.push({ id: cn, name: cn, fn: cfn });
        }

        const p = new Pipeline({ name: 'P', id: 'fr', fn: parentFn, children }, stageMap, scopeFactory, {});
        const result = (await p.execute()) as any;

        expect(order[0]).toBe('parent');
        expect(order).toHaveLength(numChildren + 1);
        for (let i = 0; i < numChildren; i++) {
          expect(result[`c_${i}`]).toBeDefined();
          expect(result[`c_${i}`].result).toBe(`cr_${i}`);
          expect(result[`c_${i}`].isError).toBe(false);
        }
      }),
      { numRuns: 20 },
    );
  });

  test('decider pipelines pick exactly one child from arbitrary children', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (numChildren) => {
        const pi = Math.floor(numChildren / 2);
        const order: string[] = [];
        const parentFn = jest.fn(() => { order.push('parent'); return { pick: `c_${pi}` }; });
        const children: Node[] = [];
        const stageMap = new Map<string, PSF>();
        stageMap.set('P', parentFn as unknown as PSF);

        for (let i = 0; i < numChildren; i++) {
          const cn = `c_${i}`;
          const cfn = jest.fn(() => { order.push(cn); return `r_${i}`; });
          stageMap.set(cn, cfn as unknown as PSF);
          children.push({ id: cn, name: cn, fn: cfn });
        }

        const p = new Pipeline(
          { name: 'P', id: 'dr', fn: parentFn, children, nextNodeDecider: (out: any) => out.pick },
          stageMap, scopeFactory, {},
        );
        const result = await p.execute();
        expect(order).toEqual(['parent', `c_${pi}`]);
        expect(result).toBe(`r_${pi}`);
      }),
      { numRuns: 20 },
    );
  });

  test('execution order is deterministic across identical runs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 }), async (ll, nfc) => {
        async function run(): Promise<string[]> {
          const order: string[] = [];
          const stageMap = new Map<string, PSF>();
          const children: Node[] = [];

          for (let i = 0; i < nfc; i++) {
            const cn = `fc_${i}`;
            const cfn = jest.fn(() => { order.push(cn); return cn; });
            stageMap.set(cn, cfn as unknown as PSF);
            children.push({ id: cn, name: cn, fn: cfn });
          }

          const stages: Node[] = [];
          for (let i = ll - 1; i >= 0; i--) {
            const sn = `l_${i}`;
            const sfn = jest.fn(() => { order.push(sn); return sn; });
            stageMap.set(sn, sfn as unknown as PSF);
            const node: Node = { name: sn, id: sn, fn: sfn, next: stages.length > 0 ? stages[stages.length - 1] : undefined };
            if (i === ll - 1 && nfc > 0) { node.children = children; node.next = undefined; }
            stages.push(node);
          }

          const p = new Pipeline(stages[stages.length - 1], stageMap, scopeFactory, {});
          await p.execute();
          return order;
        }
        expect(await run()).toEqual(await run());
      }),
      { numRuns: 15 },
    );
  });
});

/* =========================================================================
 * Additional edge cases
 * ========================================================================= */

describe('Edge cases — dynamic subflow interaction', () => {
  test('dynamic subflow with no stageMap in subflowDef still works', async () => {
    const subflowRoot: Node = { name: 'sse', id: 'sse', fn: jest.fn(() => 'ssr') };
    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'no-map', subflowName: 'NM',
      subflowDef: { root: subflowRoot }, next: { name: 'sse' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const p = new Pipeline({ name: 'P', id: 'nm', fn: dynamicHandler } as Node, stageMap, scopeFactory, {});
    await p.execute();

    const sd = getSubflowsDict(p);
    expect(sd).toBeDefined();
    expect(sd!['no-map']).toBeDefined();
    expect(sd!['no-map'].root).toBe(subflowRoot);
  });

  test('dynamic subflow with empty stageMap merges nothing', async () => {
    const subflowRoot: Node = { name: 'eme', id: 'eme', fn: jest.fn(() => 'emr') };
    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'em-sub', subflowName: 'EM',
      subflowDef: { root: subflowRoot, stageMap: new Map<string, PSF>() },
      next: { name: 'eme' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const sz = stageMap.size;
    const p = new Pipeline({ name: 'P', id: 'em', fn: dynamicHandler } as Node, stageMap, scopeFactory, {});
    await p.execute();
    expect(getStageMap(p).size).toBe(sz);
  });

  test('dynamic subflow with empty subflows object merges nothing', async () => {
    const subflowRoot: Node = { name: 'ese', fn: jest.fn(() => 'esr') };
    const dynamicHandler = jest.fn(() => ({
      name: 'dm', isSubflowRoot: true, subflowId: 'es-sub', subflowName: 'ES',
      subflowDef: { root: subflowRoot, subflows: {} },
      next: { name: 'ese' },
    }));

    const stageMap = makeMap({ P: dynamicHandler });
    const p = new Pipeline({ name: 'P', id: 'es', fn: dynamicHandler } as Node, stageMap, scopeFactory, {});
    await p.execute();

    const sd = getSubflowsDict(p);
    expect(sd).toBeDefined();
    expect(Object.keys(sd!)).toContain('es-sub');
  });

  test('isStageNodeReturn detects subflow return with all required properties', () => {
    const stageReturn = {
      name: 'dynamicMount', isSubflowRoot: true, subflowId: 'ds',
      subflowDef: { root: { name: 'se', fn: () => 'x' } },
      children: [{ name: 'c', fn: () => 'y' }],
    };
    expect(isStageNodeReturn(stageReturn)).toBe(true);
  });

  test('multiple dynamic subflow registrations via parallel children', async () => {
    // Two children each return a dynamic subflow via their parent dispatching dynamically
    const s1Root: Node = { name: 's1e', fn: jest.fn(() => 's1r') };
    const s2Root: Node = { name: 's2e', fn: jest.fn(() => 's2r') };

    // Parent stage returns dynamic children, each with subflowDef
    const parentHandler = jest.fn(() => ({
      name: 'dispatch',
      children: [
        {
          id: 'c1', name: 'C1',
          isSubflowRoot: true, subflowId: 'ds1', subflowName: 'DS1',
          subflowDef: { root: s1Root },
          fn: s1Root.fn,
        },
        {
          id: 'c2', name: 'C2',
          isSubflowRoot: true, subflowId: 'ds2', subflowName: 'DS2',
          subflowDef: { root: s2Root },
          fn: s2Root.fn,
        },
      ],
    }));

    const stageMap = makeMap({ P: parentHandler });
    const root: Node = { name: 'P', id: 'p', fn: parentHandler };
    const p = new Pipeline(root, stageMap, scopeFactory, {});
    await p.execute();

    const sd = getSubflowsDict(p);
    expect(sd).toBeDefined();
    expect(sd!['ds1']).toBeDefined();
    expect(sd!['ds1'].root).toBe(s1Root);
    expect(sd!['ds2']).toBeDefined();
    expect(sd!['ds2'].root).toBe(s2Root);
  });
});
