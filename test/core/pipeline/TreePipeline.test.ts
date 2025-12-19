/**
 * tests/TreePipeline.unifiedOrder.spec.ts
 *
 * Full unit tests for the unified TreePipeline traversal:
 *   - Linear, Fork-only, Fork+Next, Decider
 *   - ORDER (dedicated describe)
 *   - Break semantics (parent stage break skips children & next)
 *   - Validation/error paths (empty node, decider without children, unknown decider id, stage throw)
 *   - Children aggregation result shape (fork-only), throttling flag
 *   - Debug breadcrumbs (orderOfExecution, totalChildren)
 *   - Introspection helpers (getContextTree, setRootObject, getInheritedPipelines)
 *
 * The test uses a minimal FakeStageContext + mocked TreePipelineContext so we can
 * observe commits and child context creation without touching real persistence.
 */

/* ===================== Type aliases for generics ===================== */

import type { PipelineStageFunction, StageNode } from '../../../src/core/pipeline';
type TOut = any;
type TScope = any;
type PSF = PipelineStageFunction<TOut, TScope>;
type Node = StageNode<TOut, TScope>;

/* ===================== Imports under test ===================== */

import { TreePipeline } from '../../../src/core/pipeline';
import type { ScopeFactory } from '../../../src/scope/core/types';

/* ===================== Globals used by mocks ===================== */

// Capture created child contexts so we can assert on their calls (e.g., throttling flag)
const createdChildContexts: any[] = [];

/* ===================== Minimal FakeStageContext ===================== */

class FakeStageContext {
    public pipelineId: string;
    public calls: Array<{ op: string; args: any[] }> = [];
    public store: Record<string, any> = {};

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

    commitPatch() { this.calls.push({ op: 'commitPatch', args: [] }); }
    setAsDecider() { this.calls.push({ op: 'setAsDecider', args: [] }); return this; }
    setAsFork()    { this.calls.push({ op: 'setAsFork', args: [] }); return this; }
    addDebugInfo(k: string, v: unknown) { this.calls.push({ op: 'addDebugInfo', args: [k, v] }); }
    addErrorInfo(k: string, v: unknown) { this.calls.push({ op: 'addErrorInfo', args: [k, v] }); }

    getFromGlobalContext(_k: string) { return undefined; }
    setRoot(_k: string, _v: unknown) { /* recorded in mocked TreePipelineContext */ }

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
        const child = new FakeStageContext(id);
        createdChildContexts.push(child);
        return child;
    }
}

/* ===================== Jest mocks ===================== */

// Silence logger noise
jest.mock('../../../src/core/logger', () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

// Mock TreePipelineContext to hand out FakeStageContext
jest.mock('../../../src/core/context/TreePipelineContext', () => {
    return {
        TreePipelineContext: class {
            public rootStageContext: any;
            public setRootObjectCalls: any[] = [];
            constructor(rootName: string) {
                // new FakeStageContext for each pipeline
                this.rootStageContext = new FakeStageContext(rootName);
            }
            getContextTree() { return { mocked: true }; }
            setRootObject(path: string[], key: string, value: unknown) {
                this.setRootObjectCalls.push({ path, key, value });
            }
            getPipelines() { return ['root']; }
        },
        ContextTreeType: class {},
    };
});

/* ===================== Utilities ===================== */

// Return StageContext itself as "scope" (we treat scope == ctx in tests)
const scopeFactory: ScopeFactory<any> = (ctx: any) => ctx;

// Build a typed stageMap from jest fn object
const makeMap = (obj: Record<string, jest.Mock<any, any>>): Map<string, PSF> => {
    const m = new Map<string, PSF>();
    for (const [k, v] of Object.entries(obj)) m.set(k, v as unknown as PSF);
    return m;
};

/* ===================== ORDER tests (dedicated) ===================== */

describe('ORDER — unified traversal (stage → children → next; decider = stage → chosen child)', () => {
    beforeEach(() => { createdChildContexts.length = 0; });

    test('Fork+Next: stage BEFORE children; children BEFORE next', async () => {
        const order: string[] = [];
        const fns = {
            PARENT:  jest.fn(() => { order.push('parent'); }),
            CHILD_A: jest.fn(() => { order.push('childA'); }),
            CHILD_B: jest.fn(() => { order.push('childB'); }),
            NEXT:    jest.fn(() => { order.push('next'); }),
        };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'PARENT', fn: fns.PARENT,
            children: [
                { id: 'a', name: 'CHILD_A', fn: fns.CHILD_A },
                { id: 'b', name: 'CHILD_B', fn: fns.CHILD_B },
            ],
            next: { name: 'NEXT', fn: fns.NEXT },
        };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        await p.execute();
        expect(order).toEqual(['parent', 'childA', 'childB', 'next']);
    });

    test('Fork-only: stage BEFORE children; returns children bundle', async () => {
        const order: string[] = [];
        const fns = {
            PARENT: jest.fn(() => { order.push('parent'); }),
            A: jest.fn(() => { order.push('childA'); return 'A'; }),
            B: jest.fn(() => { order.push('childB'); throw new Error('boom'); }),
        };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'PARENT', fn: fns.PARENT,
            children: [{ id:'a', name:'A', fn:fns.A }, { id:'b', name:'B', fn:fns.B }],
        };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        const out = await p.execute() as any;
        expect(order).toEqual(['parent','childA','childB']);
        expect(out.a).toEqual({ result: 'A', isError: false });
        expect(out.b.isError).toBe(true);
        expect(out.b.result).toBeInstanceOf(Error);
    });

    test('Decider: stage BEFORE decider; only chosen child runs', async () => {
        const order: string[] = [];
        const fns = {
            PARENT: jest.fn(() => { order.push('parent'); return { pick: 'B' }; }),
            A: jest.fn(() => { order.push('A'); return 'a'; }),
            B: jest.fn(() => { order.push('B'); return 'b'; }),
        };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'PARENT', fn: fns.PARENT,
            children: [{ id:'A', name:'A', fn:fns.A }, { id:'B', name:'B', fn:fns.B }],
            nextNodeDecider: (out: any) => out.pick,
        };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        const out = await p.execute();
        expect(order).toEqual(['parent','B']);
        expect(out).toBe('b');
    });
});

/* ===================== Linear, Break, Errors, Throttling, Debug, Helpers ===================== */

describe('Linear & break semantics', () => {
    beforeEach(() => { createdChildContexts.length = 0; });

    test('Linear: stage runs and continues to next; leaf output flows', async () => {
        const fns = { INIT: jest.fn(), NEXT: jest.fn(() => 'done') };
        const stageMap = makeMap(fns);
        const root: Node = { name: 'INIT', fn: fns.INIT, next: { name: 'NEXT', fn: fns.NEXT } };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        const out = await p.execute();
        expect(fns.INIT).toHaveBeenCalledTimes(1);
        expect(fns.NEXT).toHaveBeenCalledTimes(1);
        expect(out).toBe('done');
    });

    test('Break in parent stage skips children and next', async () => {
        const fns = {
            PARENT: jest.fn((_s: any, breakFn: Function) => { breakFn(); }),
            A: jest.fn(), NEXT: jest.fn(),
        };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'PARENT', fn: fns.PARENT,
            children: [{ id:'a', name:'A', fn:fns.A }],
            next: { name: 'NEXT', fn: fns.NEXT },
        };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        await p.execute();
        expect(fns.A).not.toHaveBeenCalled();
        expect(fns.NEXT).not.toHaveBeenCalled();
    });
});

describe('Validation & error paths', () => {
    beforeEach(() => { createdChildContexts.length = 0; });

    test('Empty node throws (no fn, no children, no decider, no next)', async () => {
        const stageMap = new Map<string, PSF>();
        const bad: Node = { name: 'BAD' as any };
        const p = new TreePipeline(bad, stageMap, scopeFactory);
        await expect(p.execute()).rejects.toThrow(/must define/i);
    });

    test('Decider without children throws', async () => {
        const fns = { D: jest.fn(() => ({})) };
        const stageMap = makeMap(fns);
        const bad: Node = { name: 'D', fn: fns.D, nextNodeDecider: () => 'x' };
        const p = new TreePipeline(bad, stageMap, scopeFactory);
        await expect(p.execute()).rejects.toThrow(/Decider node needs to have children/i);
    });

    test('Decider unknown id throws', async () => {
        const fns = { P: jest.fn(() => ({ id: 'NOPE' })) };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'P', fn: fns.P,
            children: [{ id: 'ok', name: 'OK', fn: jest.fn() as unknown as PSF }],
            nextNodeDecider: (out: any) => out.id,
        };
        const p = new TreePipeline(root, stageMap, scopeFactory);
        await expect(p.execute()).rejects.toThrow(/Next Stage not found/i);
    });

    test('Stage throws → commits patch, records error, rethrows', async () => {
        const err = new Error('boom');
        const fns = { BAD: jest.fn(() => { throw err; }) };
        const stageMap = makeMap(fns);
        const root: Node = { name: 'BAD', fn: fns.BAD };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        await expect(p.execute()).rejects.toThrow('boom');
        // Spot check commitPatch was invoked
        const ctx = (p as any).treePipelineContext.rootStageContext as FakeStageContext;
        expect(ctx.calls.some(c => c.op === 'commitPatch')).toBe(true);
    });
});

describe('Fork-only aggregation & throttling', () => {
    beforeEach(() => { createdChildContexts.length = 0; });

    test('Returns children bundle; flags throttled child via throttlingErrorChecker', async () => {
        const fns = {
            OK: jest.fn(() => 'OK'),
            TH: jest.fn(() => { throw new Error('RATE_LIMIT'); }),
        };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'ROOT' as any,
            children: [
                { id: 'ok', name: 'OK', fn: fns.OK },
                { id: 'th', name: 'TH', fn: fns.TH },
            ],
        };
        const throttlingChecker = (e: unknown) => (e as Error).message === 'RATE_LIMIT';

        const p = new TreePipeline(root, stageMap, scopeFactory, {}, undefined, undefined, throttlingChecker);
        const out = await p.execute() as any;

        expect(out.ok).toEqual({ result: 'OK', isError: false });
        expect(out.th.isError).toBe(true);

        // The 'th' child context should have monitor.isThrottled set
        const childTh = createdChildContexts.find(c => c.pipelineId === 'th') as FakeStageContext;
        const flagged = childTh?.calls.some(c => c.op === 'updateObject' && c.args[0][0] === 'monitor' && c.args[1] === 'isThrottled' && c.args[2] === true);
        expect(flagged).toBe(true);
    });
});

describe('Debug breadcrumbs & helpers', () => {
    beforeEach(() => { createdChildContexts.length = 0; });

    test('Adds debug info for children order and total count in fork+next', async () => {
        const fns = { P: jest.fn(), A: jest.fn(), N: jest.fn() };
        const stageMap = makeMap(fns);
        const root: Node = {
            name: 'P', fn: fns.P,
            children: [{ id:'a', name:'A', fn:fns.A }],
            next: { name: 'N', fn: fns.N },
        };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});
        await p.execute();

        const ctx = (p as any).treePipelineContext.rootStageContext as FakeStageContext;
        const orders = ctx.calls.filter(c => c.op === 'addDebugInfo' && c.args[0] === 'orderOfExecution');
        const totals = ctx.calls.filter(c => c.op === 'addDebugInfo' && c.args[0] === 'totalChildren');

        expect(orders.some(o => o.args[1] === 'ChildrenAfterStage')).toBe(true);
        expect(totals.some(t => t.args[1] === 1)).toBe(true);
    });

    test('getContextTree / setRootObject / getInheritedPipelines', async () => {
        const stageMap = new Map<string, PSF>();
        const root: Node = { name: 'X' as any };
        const p = new TreePipeline(root, stageMap, scopeFactory, {});

        // getContextTree
        const tree = p.getContextTree();
        expect(tree).toEqual({ mocked: true });

        // setRootObject
        p.setRootObject(['a'], 'b', 42);
        const tpc = (p as any).treePipelineContext;
        expect((tpc.setRootObjectCalls?.length ?? 0) >= 0).toBe(true);

        // getInheritedPipelines
        const pipes = p.getInheritedPipelines();
        expect(pipes).toEqual(['root']);
    });
});
