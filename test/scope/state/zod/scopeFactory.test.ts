import { z } from 'zod';
import { createScopeProxyFromZod } from '../../../../src/scope/state/zod';
import type { StageContextLike } from '../../../../src/scope/core/types';

class FakeCtx implements StageContextLike {
    pipelineId = 'pipe-zod';
    store: Record<string, unknown> = {};
    calls: Array<{ op: string; args: any[] }> = [];

    getValue(path: string[], key?: string) {
        const k = key ? [...path, key].join('.') : path.join('.');
        this.calls.push({ op: 'getValue', args: [path, key] });
        return this.store[k];
    }
    setObject(path: string[], key: string, value: unknown) {
        const k = key ? [...path, key].join('.') : path.join('.');
        this.calls.push({ op: 'setObject', args: [path, key, value] });
        this.store[k] = value;
    }
    updateObject(path: string[], key: string, value: unknown) {
        const k = key ? [...path, key].join('.') : path.join('.');
        this.calls.push({ op: 'updateObject', args: [path, key, value] });
        const cur = (this.store[k] as any) ?? {};
        this.store[k] = { ...cur, ...(value as object) };
    }

    addDebugInfo() {}
    addErrorInfo() {}
    getFromGlobalContext() { return undefined; }
    setRoot() {}
}

describe('zod/scopeFactory', () => {
    const Schema = z.object({
        chat: z.object({
            prompt: z.string().optional(),
        }).default({}),
        tags: z.array(z.string()).default([]),
        kv: z.record(z.string(), z.number()).default({}),
        metrics: z.object({
            tokens: z.number().int().optional(),
        }).default({}),
    });

    test('scalar/object/array/record: read & write with strict=deny', () => {
        const ctx = new FakeCtx();
        const scope = createScopeProxyFromZod(ctx, Schema, 'deny');

        // scalar set → setObject
        scope.chat.prompt.set('hello');
        expect(ctx.store['chat.prompt']).toBe('hello');

        // array push → setObject with whole array
        scope.tags.push('a');
        scope.tags.push('b');
        expect(ctx.store['tags']).toEqual(['a', 'b']);

        // record at(k).set → setObject on dynamic key
        scope.kv.at('foo').set(123);
        expect(ctx.store['kv.foo']).toBe(123);

        // record merge → updateObject at parent key
        scope.kv.merge({ bar: 7 });
        expect(ctx.store['kv']).toEqual({ bar: 7 });

        // exists/get helpers
        expect(scope.chat.exists()).toBe(true);
        expect(scope.chat.prompt.exists()).toBe(true);
        expect(scope.tags.exists()).toBe(true);
        expect(scope.kv.exists()).toBe(true);
    });

    test('validation: deny throws, warn skips write, off allows write', () => {
        const S = z.object({ n: z.number().int() });

        // deny → throw
        const ctxD = new FakeCtx();
        const sD = createScopeProxyFromZod(ctxD, S, 'deny');
        expect(() => sD.n.set('bad' as any)).toThrow();

        // warn → no throw, no write
        const ctxW = new FakeCtx();
        const sW = createScopeProxyFromZod(ctxW, S, 'warn');
        sW.n.set('bad' as any);
        expect(ctxW.store['n']).toBeUndefined();

        // off → no throw, write happens
        const ctxO = new FakeCtx();
        const sO = createScopeProxyFromZod(ctxO, S, 'off');
        sO.n.set('bad' as any);
        expect(ctxO.store['n']).toBe('bad');
    });

    test('unknown field access throws a helpful error', () => {
        const ctx = new FakeCtx();
        const scope = createScopeProxyFromZod(ctx, Schema, 'deny');
        expect(() => (scope as any).nope).toThrow(/Unknown field 'nope'/i);
    });
});
