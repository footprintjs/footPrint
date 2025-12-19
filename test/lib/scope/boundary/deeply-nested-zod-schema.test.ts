import { z } from 'zod';
import { createScopeProxyFromZod } from '../../../../src/lib/scope/state/zod/scopeFactory';
import type { StageContextLike } from '../../../../src/lib/scope/providers/types';

function makeCtxLike(): StageContextLike {
  const store: Record<string, unknown> = {};
  return {
    getValue(path: string[], key?: string) {
      return store[[...path, key].filter(Boolean).join('.')];
    },
    setObject(path: string[], key: string, value: unknown) {
      store[[...path, key].filter(Boolean).join('.')] = value;
    },
    updateObject(path: string[], key: string, value: unknown) {
      const k = [...path, key].filter(Boolean).join('.');
      const ex = store[k];
      store[k] = typeof ex === 'object' && ex ? { ...ex as any, ...value as any } : value;
    },
    addError() {},
  };
}

describe('Boundary: deeply nested Zod schema', () => {
  it('5-level nested object schema works', () => {
    const schema = z.object({
      level1: z.object({
        level2: z.object({
          level3: z.object({
            level4: z.object({
              level5: z.string(),
            }),
          }),
        }),
      }),
    });

    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    proxy.level1.level2.level3.level4.level5.set('deep');
    expect(proxy.level1.level2.level3.level4.level5.get()).toBe('deep');
  });

  it('object with 20 fields', () => {
    const shape: Record<string, z.ZodString> = {};
    for (let i = 0; i < 20; i++) {
      shape[`field${i}`] = z.string();
    }
    const schema = z.object(shape);
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    for (let i = 0; i < 20; i++) {
      (proxy as any)[`field${i}`].set(`value-${i}`);
    }
    for (let i = 0; i < 20; i++) {
      expect((proxy as any)[`field${i}`].get()).toBe(`value-${i}`);
    }
  });

  it('record with many dynamic keys', () => {
    const schema = z.object({
      data: z.record(z.number()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'off');

    const values: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      values[`key-${i}`] = i;
    }
    proxy.data.set(values);
    expect(proxy.data.get()).toEqual(values);
    expect(proxy.data.keys()).toHaveLength(50);
  });

  it('array with large number of elements', () => {
    const schema = z.object({
      items: z.array(z.number()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    const arr = Array.from({ length: 100 }, (_, i) => i);
    proxy.items.set(arr);
    expect(proxy.items.get()).toEqual(arr);
  });

  it('mixed nested schema: objects + arrays + records', () => {
    const schema = z.object({
      users: z.array(z.string()),
      config: z.object({
        retries: z.number(),
        metadata: z.record(z.string()),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'off');

    proxy.users.set(['Alice', 'Bob']);
    proxy.config.retries.set(3);
    proxy.config.metadata.set({ env: 'prod' });

    expect(proxy.users.get()).toEqual(['Alice', 'Bob']);
    expect(proxy.config.retries.get()).toBe(3);
    expect(proxy.config.metadata.get()).toEqual({ env: 'prod' });
  });
});
