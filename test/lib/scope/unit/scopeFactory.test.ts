import { z } from 'zod';
import { createScopeProxyFromZod } from '../../../../src/lib/scope/state/zod/scopeFactory';
import type { StageContextLike } from '../../../../src/lib/scope/providers/types';

function makeCtxLike(): StageContextLike & { store: Record<string, unknown> } {
  const store: Record<string, unknown> = {};
  return {
    store,
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
      store[fullKey] = typeof existing === 'object' && existing ? { ...existing as any, ...value as any } : value;
    },
    addLog() {},
    addError() {},
    pipelineId: 'p1',
  };
}

describe('scopeFactory — createScopeProxyFromZod', () => {
  // ── Line 78: scalar exists() ──────────────────────────────────────────

  it('scalar.exists() returns true when value is set', () => {
    const schema = z.object({ name: z.string() });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(proxy.name.exists()).toBe(false);
    proxy.name.set('Alice');
    expect(proxy.name.exists()).toBe(true);
  });

  it('scalar.exists() returns false when value is undefined', () => {
    const schema = z.object({ age: z.number() });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(proxy.age.exists()).toBe(false);
  });

  // ── Lines 103-106: record merge with validation failure ───────────────

  it('record.merge() merges values into existing record', () => {
    const schema = z.object({
      metadata: z.record(z.string()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'off');

    proxy.metadata.set({ a: 'one' });
    proxy.metadata.merge({ b: 'two' });
    // After merge, updateObject should have been called
    expect(ctx.store['metadata']).toEqual({ a: 'one', b: 'two' });
  });

  it('record.merge() skips write when validation fails in warn mode', () => {
    const schema = z.object({
      scores: z.record(z.string(), z.number()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'warn');

    proxy.scores.set({ a: 1 });
    // Merge with invalid value (string instead of number) — should silently fail in warn mode
    proxy.scores.merge({ b: 'not-a-number' as any });
    // The original value should remain unchanged since validation failed
    expect(ctx.store['scores']).toEqual({ a: 1 });
  });

  it('record.merge() throws when validation fails in deny mode', () => {
    const schema = z.object({
      scores: z.record(z.string(), z.number()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'deny');

    proxy.scores.set({ a: 1 });
    expect(() => proxy.scores.merge({ b: 'not-a-number' as any })).toThrow();
  });

  // ── Line 117: record exists() ─────────────────────────────────────────

  it('record.exists() returns true when record is set', () => {
    const schema = z.object({
      tags: z.record(z.string()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'off');

    expect(proxy.tags.exists()).toBe(false);
    proxy.tags.set({ env: 'prod' });
    expect(proxy.tags.exists()).toBe(true);
  });

  it('record.keys() returns keys of the record', () => {
    const schema = z.object({
      tags: z.record(z.string()),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema, 'off');

    proxy.tags.set({ a: '1', b: '2' });
    expect(proxy.tags.keys()).toEqual(['a', 'b']);
  });

  // ── Lines 136-145: object exists() with child field checking ──────────

  it('object.exists() returns true when object value is directly set', () => {
    const schema = z.object({
      config: z.object({
        retries: z.number(),
        timeout: z.number(),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(proxy.config.exists()).toBe(false);

    // Set a child field — exists() should check child keys
    proxy.config.retries.set(3);
    expect(proxy.config.exists()).toBe(true);
  });

  it('object.exists() returns true when a nested child field has a value', () => {
    const schema = z.object({
      settings: z.object({
        debug: z.boolean(),
        verbose: z.boolean(),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    // Neither child set yet
    expect(proxy.settings.exists()).toBe(false);

    // Set one child — should make parent exists() true
    proxy.settings.verbose.set(true);
    expect(proxy.settings.exists()).toBe(true);
  });

  it('object.exists() returns false when no children are set', () => {
    const schema = z.object({
      empty: z.object({
        a: z.string(),
        b: z.number(),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(proxy.empty.exists()).toBe(false);
  });

  // ── readOnly context is attached via ro property ──────────────────────

  it('ro property is set from readOnly parameter', () => {
    const schema = z.object({ name: z.string() });
    const ctx = makeCtxLike();
    const readOnlyData = { apiKey: 'secret' };
    const proxy = createScopeProxyFromZod(ctx, schema, 'warn', readOnlyData);

    expect(proxy.ro).toBe(readOnlyData);
  });

  it('ro property is undefined when readOnly is not provided', () => {
    const schema = z.object({ name: z.string() });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(proxy.ro).toBeUndefined();
  });

  // ── object.get() and object.toJSON() ──────────────────────────────────

  it('object proxy get() reads full object value', () => {
    const schema = z.object({
      config: z.object({
        retries: z.number(),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    // get() on an object proxy reads the value from context
    expect(proxy.config.get()).toBeUndefined();
  });

  it('object proxy toJSON() returns same as get()', () => {
    const schema = z.object({
      data: z.object({
        x: z.number(),
      }),
    });
    const ctx = makeCtxLike();
    const proxy = createScopeProxyFromZod(ctx, schema);

    expect(proxy.data.toJSON()).toBeUndefined();
  });
});
