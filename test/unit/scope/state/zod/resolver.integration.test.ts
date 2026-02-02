import { z } from 'zod';

// core resolver/registry
import { registerScopeResolver, toScopeFactory } from '../../../../../src/scope/providers/resolve';
import type { StageContextLike } from '../../../../../src/scope/providers/types';
// zod plugin
import { ZodScopeResolver } from '../../../../../src/scope/state/zod/resolver';
import { defineScopeSchema } from '../../../../../src/scope/state/zod/schema/builder';

class FakeCtx implements StageContextLike {
  pipelineId = 'pipe-zod-int';
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

  addLog = jest.fn();
  addError = jest.fn();
  getFromGlobalContext() {
    return undefined;
  }

  setRoot() {}
}

describe('zod/resolver → toScopeFactory integration', () => {
  beforeAll(() => {
    // install the zod resolver once for these tests
    registerScopeResolver(ZodScopeResolver);
  });

  test('Zod schema → scope via toScopeFactory (BaseState-compat + field ops)', () => {
    const Schema = defineScopeSchema({
      chat: z
        .object({
          prompt: z.string().optional(),
          query: z.string().optional(),
        })
        .default({}),
      tags: z.array(z.string()).default([]),
      kv: z.record(z.string(), z.number()).default({}), // explicit string keys for v4 stability
    });

    // strict=deny to assert validation runs
    const scopeFactory = toScopeFactory<any>(Schema, { zod: { strict: 'deny' } });

    const ctx = new FakeCtx();
    const scope = scopeFactory(ctx, 'INIT', { ro: 1 });

    // BaseState-compatible helpers exist and forward
    scope.addDebugInfo('k', 1);
    expect(ctx.addLog).toHaveBeenCalledWith('k', 1);
    expect(scope.getPipelineId()).toBe('pipe-zod-int');
    expect(scope.getReadOnlyValues()).toEqual({ ro: 1 });

    // scalar write
    scope.chat.prompt.set('hello');
    expect(ctx.store['chat.prompt']).toBe('hello');

    // object exists() should be true because one of its children is set
    expect(scope.chat.exists()).toBe(true);
    expect(scope.chat.prompt.exists()).toBe(true);

    // array push
    scope.tags.push('a');
    scope.tags.push('b');
    expect(ctx.store.tags).toEqual(['a', 'b']);

    // record at(k).set and merge
    scope.kv.at('foo').set(123);
    expect(ctx.store['kv.foo']).toBe(123);

    scope.kv.merge({ bar: 7 });
    expect(ctx.store.kv).toEqual({ bar: 7 }); // parent merge semantics
  });

  test('validation: strict=deny throws on bad write', () => {
    const Schema = defineScopeSchema({
      metrics: z.object({ tokens: z.number().int().optional() }).default({}),
    });
    const factory = toScopeFactory<any>(Schema, { zod: { strict: 'deny' } });

    const ctx = new FakeCtx();
    const scope = factory(ctx, 'INIT');
    expect(() => scope.metrics.tokens.set('oops' as any)).toThrow();
  });
});
