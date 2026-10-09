/**
 * Direct-scope regression for the Zod wrapper boundary.
 *
 * The May 2026 unwrap fix intentionally stopped at arrays, but identified
 * wrappers only by Zod 3 typeName. Structure must work with both real Zod
 * exports, while writes keep the original wrapped schema's validation.
 * A real StageContext keeps nested record/object writes observable together;
 * no executor or fabricated Zod internals are involved.
 */
import { SharedMemory } from 'foottrace/write';
import { z as z3 } from 'zod/v3';
import { z as z4 } from 'zod/v4';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';
import type { StrictMode } from '../../../../src/lib/scope/providers/types.js';
import {
  type ZodSchema,
  getArrayElementType,
  getObjectShape,
  getRecordValueType,
  unwrap,
} from '../../../../src/lib/scope/state/zod/utils/validateHelper.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

const versions = [
  { version: 'Zod 3', api: z3 },
  { version: 'Zod 4', api: z4 },
];
const wrappers = [
  { wrapper: 'optional', wrap: (schema: any, _fallback: unknown) => schema.optional(), empty: undefined },
  { wrapper: 'nullable', wrap: (schema: any, _fallback: unknown) => schema.nullable(), empty: null },
  { wrapper: 'default', wrap: (schema: any, fallback: unknown) => schema.default(fallback), empty: undefined },
];

function directScope(schema: any, strict: StrictMode = 'deny') {
  const ctx = new StageContext('zod-compat', 'write', 'write', new SharedMemory());
  const scope = defineScopeFromZod(schema, { strict })(ctx, 'write');
  return { ctx, scope };
}

describe.each(versions)('$version direct scope wrappers', ({ api }) => {
  // Both are the installed package's real public APIs; their constructor
  // signatures differ, so this fixture does not pretend one is the other.
  const z: any = api;

  describe.each(wrappers)('$wrapper container', ({ wrap, empty }) => {
    it('exposes array push and validates the resulting array before writing', () => {
      const { ctx, scope } = directScope(z.object({ holdings: wrap(z.array(z.string()).max(2), []) }));
      expect(typeof scope.holdings.push).toBe('function');
      scope.holdings.set(['bond']);
      scope.holdings.push('equity');
      expect(scope.holdings.get()).toEqual(['bond', 'equity']);
      expect(() => scope.holdings.push(42)).toThrow(api.ZodError);
      expect(() => scope.holdings.push('cash')).toThrow(api.ZodError);
      expect(() => scope.holdings.set(['bond', 42])).toThrow(api.ZodError);
      expect(ctx.getValue([], 'holdings')).toEqual(['bond', 'equity']);
    });

    it('exposes record operations and validates whole and dynamic-key writes', () => {
      const { ctx, scope } = directScope(z.object({ balances: wrap(z.record(z.string(), z.number()), {}) }));
      expect(typeof scope.balances.at).toBe('function');
      expect(typeof scope.balances.merge).toBe('function');
      scope.balances.set({ cash: 10 });
      scope.balances.merge({ bond: 20 });
      scope.balances.at('cash').set(12);
      expect(scope.balances.keys().sort()).toEqual(['bond', 'cash']);
      expect(scope.balances.get()).toEqual({ cash: 12, bond: 20 });
      expect(() => scope.balances.merge({ bad: 'not a number' })).toThrow(api.ZodError);
      expect(() => scope.balances.at('cash').set('not a number')).toThrow(api.ZodError);
      expect(() => scope.balances.set({ cash: 'not a number' })).toThrow(api.ZodError);
      expect(ctx.getValue([], 'balances')).toEqual({ cash: 12, bond: 20 });
    });

    it('exposes nested object fields without turning them into unvalidated writes', () => {
      const account = z.object({ cash: z.number().nonnegative(), holdings: z.array(z.string()) });
      const { ctx, scope } = directScope(z.object({ account: wrap(account, { cash: 0, holdings: [] }) }));
      expect(scope.account.cash).toBeDefined();
      scope.account.cash.set(12);
      scope.account.holdings.push('bond');
      expect(scope.account.get()).toEqual({ cash: 12, holdings: ['bond'] });
      expect(() => scope.account.cash.set(-1)).toThrow(api.ZodError);
      expect(() => scope.account.holdings.push(42)).toThrow(api.ZodError);
      expect(ctx.getValue([], 'account')).toEqual({ cash: 12, holdings: ['bond'] });
    });

    it('retains wrapper acceptance when setting an array', () => {
      const { scope } = directScope(z.object({ holdings: wrap(z.array(z.string()), ['fallback']) }));
      scope.holdings.set(['bond']);
      expect(() => scope.holdings.set(empty)).not.toThrow();
      // Scope writes validate inputs; they do not replace them with parsed
      // output (including a default). Keep that existing boundary unchanged.
      expect(scope.holdings.get()).toBe(empty);
      scope.holdings.push('equity');
      expect(scope.holdings.get()).toEqual(['equity']);
    });

    it('retains wrapper acceptance when setting a record', () => {
      const { scope } = directScope(z.object({ balances: wrap(z.record(z.string(), z.number()), { cash: 0 }) }));
      scope.balances.set({ cash: 10 });
      expect(() => scope.balances.set(empty)).not.toThrow();
      expect(scope.balances.get()).toBe(empty);
      scope.balances.merge({ bond: 20 });
      expect(scope.balances.get()).toEqual({ bond: 20 });
    });

    it('retains scalar wrapper validation rather than validating only its base', () => {
      const { scope } = directScope(z.object({ cash: wrap(z.number().nonnegative(), 0) }));
      expect(() => scope.cash.set(empty)).not.toThrow();
      expect(scope.cash.get()).toBe(empty);
      expect(() => scope.cash.set(-1)).toThrow(api.ZodError);
      expect(scope.cash.get()).toBe(empty);
    });
  });

  it('keeps ordinary containers operational without unwrapping an array into its element', () => {
    const { scope } = directScope(
      z.object({
        holdings: z.array(z.string()),
        balances: z.record(z.string(), z.number()),
        account: z.object({ cash: z.number() }),
      }),
    );
    scope.holdings.push('bond');
    scope.balances.at('cash').set(12);
    scope.account.cash.set(10);
    expect(scope.holdings.get()).toEqual(['bond']);
    expect(scope.balances.get()).toEqual({ cash: 12 });
    expect(scope.account.get()).toEqual({ cash: 10 });
  });

  it('keeps array refinements on the original schema while exposing array operations', () => {
    const holdings = z
      .array(z.string())
      .refine((items: string[]) => !items.includes('blocked'), 'blocked holding')
      .optional();
    const { scope } = directScope(z.object({ holdings }));
    expect(typeof scope.holdings.push).toBe('function');
    scope.holdings.push('bond');
    expect(() => scope.holdings.push('blocked')).toThrow(api.ZodError);
    expect(scope.holdings.get()).toEqual(['bond']);
  });

  it('drops invalid wrapped writes and records an error in warn mode', () => {
    const { ctx, scope } = directScope(z.object({ holdings: z.array(z.string()).optional() }), 'warn');
    scope.holdings.push('bond');
    expect(() => scope.holdings.push(42)).not.toThrow();
    expect(scope.holdings.get()).toEqual(['bond']);
    expect(ctx.debug.errorContext.schema).toBeDefined();
  });

  it('still bypasses validation in off mode without losing container operations', () => {
    const { ctx, scope } = directScope(z.object({ holdings: z.array(z.string()).optional() }), 'off');
    scope.holdings.push(42);
    expect(scope.holdings.get()).toEqual([42]);
    expect(ctx.debug.errorContext).toEqual({});
  });

  it.each(['readonly', 'catch', 'brand', 'lazy', 'pipeline'])('keeps the existing %s wrapper structure', (kind) => {
    const array = z.array(z.string());
    const wrapped =
      kind === 'lazy'
        ? z.lazy(() => array)
        : kind === 'pipeline'
        ? array.pipe(z.array(z.string()).max(1))
        : kind === 'catch'
        ? array.catch([])
        : array[kind]();
    const { scope } = directScope(z.object({ holdings: wrapped }));
    scope.holdings.push('bond');
    expect(scope.holdings.get()).toEqual(['bond']);
    if (kind === 'pipeline') {
      expect(() => scope.holdings.push('equity')).toThrow(api.ZodError);
      expect(scope.holdings.get()).toEqual(['bond']);
    }
  });

  it('reads exact structural slots without peeling arrays into elements', () => {
    const value = z.number();
    const array = z.array(value);
    const record = z.record(z.string(), value);
    const object = z.object({ value });
    expect(unwrap(array)).toBe(array);
    expect(unwrap(array.optional().nullable().default([]))).toBe(array);
    expect(getArrayElementType(array)).toBe(value);
    expect(getRecordValueType(record)).toBe(value);
    expect(getObjectShape(object).value).toBe(value);
  });
});

it('accepts concrete schemas from both versions through the structural type', () => {
  const schemas: ZodSchema[] = [z3.object({ cash: z3.number() }), z4.object({ cash: z4.number() })];
  for (const schema of schemas) {
    const { scope } = directScope(schema);
    scope.cash.set(12);
    expect(scope.cash.get()).toBe(12);
  }
});

describe.each([
  {
    version: 'Zod 3',
    schema: z3.object({ holdings: z3.array(z3.string()).optional(), count: z3.number() }),
    error: z3.ZodError,
  },
  {
    version: 'Zod 4',
    schema: z4.object({ holdings: z4.array(z4.string()).optional(), count: z4.number() }),
    error: z4.ZodError,
  },
])('$version public factory', ({ schema, error }) => {
  it('accepts its concrete schema type and executes wrapped writes across stages', async () => {
    // No cast or any-typed fixture at the public schema boundary.
    const scopeFactory = defineScopeFromZod(schema, { strict: 'deny' });
    type PortfolioScope = {
      holdings: { push(value: unknown): void; get(): string[] };
      count: { set(value: number): void };
    };
    const chart = flowChart<unknown, PortfolioScope>(
      'Seed',
      (scope) => {
        scope.holdings.push('bond');
        expect(() => scope.holdings.push(42)).toThrow(error);
      },
      'seed',
    )
      .addFunction(
        'Count',
        (scope) => {
          expect(scope.holdings.get()).toEqual(['bond']);
          scope.count.set(scope.holdings.get().length);
        },
        'count',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { scopeFactory });
    await executor.run();
    expect(executor.getSnapshot().sharedState).toMatchObject({ holdings: ['bond'], count: 1 });
  });
});

describe('Zod 4 wrapper additions', () => {
  it('exposes prefault array operations while preserving input validation', () => {
    const { scope } = directScope(z4.object({ holdings: z4.array(z4.string()).prefault([]) }));
    scope.holdings.set(undefined);
    scope.holdings.push('bond');
    expect(() => scope.holdings.push(42)).toThrow(z4.ZodError);
    expect(scope.holdings.get()).toEqual(['bond']);
  });

  it('keeps nonoptional refusal while exposing its underlying container', () => {
    const { scope } = directScope(z4.object({ holdings: z4.array(z4.string()).optional().nonoptional() }));
    scope.holdings.push('bond');
    expect(() => scope.holdings.set(undefined)).toThrow(z4.ZodError);
    expect(scope.holdings.get()).toEqual(['bond']);
  });
});
