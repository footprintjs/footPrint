import { z } from 'zod';

// core types for our FakeCtx
import type { StageContextLike } from '../../../../src/scope/core/types';
import { defineScopeFromZod, defineScopeSchema } from '../../../../src/scope/state/zod';

class FakeCtx implements StageContextLike {
  pipelineId = 'pipe-zod-def';
  store: Record<string, unknown> = {};
  getValue(path: string[], key?: string) {
    const k = key ? [...path, key].join('.') : path.join('.');
    return this.store[k];
  }

  setObject(path: string[], key: string, value: unknown) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.store[k] = value;
  }

  updateObject(path: string[], key: string, value: unknown) {
    const k = key ? [...path, key].join('.') : path.join('.');
    const cur = (this.store[k] as any) ?? {};
    this.store[k] = { ...cur, ...(value as object) };
  }

  addDebugInfo = jest.fn();
  addErrorInfo = jest.fn();
  getFromGlobalContext() {
    return undefined;
  }

  setRoot() {}
}

describe('defineScopeFromZod', () => {
  const Schema = defineScopeSchema({
    chat: z
      .object({
        prompt: z.string().optional(),
        query: z.string().optional(),
      })
      .default({}),

    tags: z.array(z.string()).default([]),

    // explicit string keys for v4 compatibility
    kv: z.record(z.string(), z.number()).default({}),

    metrics: z
      .object({
        tokens: z.number().int().optional(),
      })
      .default({}),
  });

  test('builds a ScopeFactory that is BaseState-compatible and writes through', () => {
    // strict=deny to assert validation really runs
    const scopeFactory = defineScopeFromZod(Schema, { strict: 'deny' });

    const ctx = new FakeCtx();
    const scope = scopeFactory(ctx, 'INIT', { ro: 42 });

    // BaseState-compat helpers exist and forward to ctx
    scope.addDebugInfo('stage', 'INIT');
    expect(ctx.addDebugInfo).toHaveBeenCalledWith('stage', 'INIT');
    expect(scope.getPipelineId()).toBe('pipe-zod-def');
    expect(scope.getReadOnlyValues()).toEqual({ ro: 42 });

    // scalar write
    scope.chat.prompt.set('hello');
    expect(ctx.store['chat.prompt']).toBe('hello');

    // object exists should be true because a child is present
    expect(scope.chat.exists()).toBe(true);
    expect(scope.chat.prompt.exists()).toBe(true);

    // array push
    scope.tags.push('a');
    scope.tags.push('b');
    expect(ctx.store.tags).toEqual(['a', 'b']);

    // record write at dynamic key
    scope.kv.at('foo').set(123);
    expect(ctx.store['kv.foo']).toBe(123);

    // record merge writes at the parent (patch semantics)
    scope.kv.merge({ bar: 7 });
    expect(ctx.store.kv).toEqual({ bar: 7 });
  });

  test('strict=deny throws on invalid writes; strict=warn skips write; strict=off allows write', () => {
    const denyFactory = defineScopeFromZod(defineScopeSchema({ n: z.number().int() }), { strict: 'deny' });
    const warnFactory = defineScopeFromZod(defineScopeSchema({ n: z.number().int() }), { strict: 'warn' });
    const offFactory = defineScopeFromZod(defineScopeSchema({ n: z.number().int() }), { strict: 'off' });

    const ctxD = new FakeCtx();
    const sD = denyFactory(ctxD, 'S');
    expect(() => sD.n.set('bad' as any)).toThrow();

    const ctxW = new FakeCtx();
    const sW = warnFactory(ctxW, 'S');
    sW.n.set('bad' as any);
    expect(ctxW.store.n).toBeUndefined(); // skipped

    const ctxO = new FakeCtx();
    const sO = offFactory(ctxO, 'S');
    sO.n.set('bad' as any);
    expect(ctxO.store.n).toBe('bad'); // allowed
  });

  test('unknown schema field access throws a helpful error', () => {
    const factory = defineScopeFromZod(Schema);
    const scope = factory(new FakeCtx(), 'S');
    expect(() => (scope as any).nope).toThrow(/Unknown field 'nope'/i);
  });
});
