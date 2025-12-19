import * as fc from 'fast-check';
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

describe('Property: zod rejects invalid writes', () => {
  it('string field rejects non-string values in deny mode', () => {
    fc.assert(
      fc.property(
        fc.anything().filter((v) => typeof v !== 'string'),
        (invalidValue) => {
          const schema = z.object({ name: z.string() });
          const ctx = makeCtxLike();
          const proxy = createScopeProxyFromZod(ctx, schema, 'deny');

          try {
            proxy.name.set(invalidValue);
            return false; // Should have thrown
          } catch {
            return true; // Correctly rejected
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('number field accepts numbers in deny mode', () => {
    fc.assert(
      fc.property(fc.integer(), (num) => {
        const schema = z.object({ count: z.number() });
        const ctx = makeCtxLike();
        const proxy = createScopeProxyFromZod(ctx, schema, 'deny');

        proxy.count.set(num);
        return proxy.count.get() === num;
      }),
      { numRuns: 30 },
    );
  });

  it('warn mode does not throw on invalid values', () => {
    fc.assert(
      fc.property(fc.integer(), (num) => {
        const schema = z.object({ name: z.string() });
        const ctx = makeCtxLike();
        const proxy = createScopeProxyFromZod(ctx, schema, 'warn');

        // Should not throw (warn mode)
        proxy.name.set(num as any);
        return true;
      }),
      { numRuns: 20 },
    );
  });

  it('off mode accepts anything', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const schema = z.object({ data: z.string() });
        const ctx = makeCtxLike();
        const proxy = createScopeProxyFromZod(ctx, schema, 'off');

        proxy.data.set(value);
        return true;
      }),
      { numRuns: 20 },
    );
  });
});
