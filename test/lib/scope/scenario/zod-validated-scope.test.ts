import { z } from 'zod';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import type { StageContextLike } from '../../../../src/lib/scope/providers/types';
import { defineScopeFromZod } from '../../../../src/lib/scope/state/zod/defineScopeFromZod';
import { defineScopeSchema, isScopeSchema } from '../../../../src/lib/scope/state/zod/schema/builder';
import { createScopeProxyFromZod } from '../../../../src/lib/scope/state/zod/scopeFactory';

function makeCtxLike(): StageContextLike {
  const store: Record<string, unknown> = {};
  return {
    getValue(path: string[], key?: string): unknown {
      const fullKey = [...path, key].filter(Boolean).join('.');
      return store[fullKey];
    },
    setObject(path: string[], key: string, value: unknown): void {
      const fullKey = [...path, key].filter(Boolean).join('.');
      store[fullKey] = value;
    },
    updateObject(path: string[], key: string, value: unknown): void {
      const fullKey = [...path, key].filter(Boolean).join('.');
      const existing = store[fullKey];
      store[fullKey] = typeof existing === 'object' && existing ? { ...(existing as any), ...(value as any) } : value;
    },
    addLog() {},
    addError() {},
    pipelineId: 'p1',
  };
}

describe('Scenario: Zod-validated scope', () => {
  it('defineScopeSchema creates a branded schema', () => {
    const schema = defineScopeSchema({
      name: z.string(),
      age: z.number(),
    });
    expect(isScopeSchema(schema)).toBe(true);
  });

  it('isScopeSchema rejects plain Zod schemas', () => {
    const plain = z.object({ name: z.string() });
    expect(isScopeSchema(plain)).toBe(false);
  });

  it('createScopeProxyFromZod creates a proxy with get/set', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    proxy.name.set('Alice');
    expect(proxy.name.get()).toBe('Alice');

    proxy.count.set(42);
    expect(proxy.count.get()).toBe(42);
  });

  it('createScopeProxyFromZod validates writes in deny mode', () => {
    const schema = z.object({
      name: z.string(),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'deny');

    expect(() => proxy.name.set(42 as any)).toThrow();
  });

  it('createScopeProxyFromZod rejects unknown fields', () => {
    const schema = z.object({
      name: z.string(),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(() => (proxy as any).unknown).toThrow(/Unknown field/);
  });

  it('defineScopeFromZod creates a ScopeFactory', () => {
    const schema = z.object({
      name: z.string(),
    });
    const factory = defineScopeFromZod(schema);
    const ctx = makeCtxLike();
    const scope = factory(ctx, 'test');

    // Has BaseState-compatible methods
    expect(typeof scope.addDebugInfo).toBe('function');
    expect(typeof scope.getReadOnlyValues).toBe('function');
  });

  it('proxy handles nested objects', () => {
    const schema = z.object({
      config: z.object({
        retries: z.number(),
        timeout: z.number(),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    proxy.config.retries.set(3);
    expect(proxy.config.retries.get()).toBe(3);
  });

  it('proxy handles arrays', () => {
    const schema = z.object({
      items: z.array(z.string()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    proxy.items.set(['a', 'b']);
    expect(proxy.items.get()).toEqual(['a', 'b']);

    proxy.items.push('c');
    expect(proxy.items.get()).toEqual(['a', 'b', 'c']);
  });

  it('proxy handles records', () => {
    const schema = z.object({
      metadata: z.record(z.string()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'off');

    proxy.metadata.set({ env: 'prod' });
    expect(proxy.metadata.get()).toEqual({ env: 'prod' });

    // at() creates a sub-proxy that reads at a deeper path
    const envProxy = proxy.metadata.at('env');
    envProxy.set('staging');
    expect(envProxy.get()).toBe('staging');
  });

  it('throws TypeError for non-Zod input', () => {
    expect(() => createScopeProxyFromZod({} as any, {} as any)).toThrow(TypeError);
  });
});
