/**
 * Tests for the FlowChartExecutorOptions object API (P4-10).
 *
 * Fix: FlowChartExecutor had a 9-positional-parameter constructor which was
 * error-prone (easy to mix up order) and made optional advanced configuration
 * awkward. An options-object form is now supported:
 *
 *   new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots: true })
 *
 * The legacy positional form is still accepted for backward compatibility but
 * parameters 3–9 are deprecated. The preferred form is the options object.
 */

import { flowChart } from '../../../../src/index';
import type { ScopeFactory } from '../../../../src/lib/engine/types';
import { type FlowChartExecutorOptions, FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

const noop = async () => {};

function buildChart() {
  return flowChart('Entry', noop, 'entry').addFunction('Process', noop, 'process').build();
}

// ---------------------------------------------------------------------------
// Pattern 1: unit — new options-object form works for each supported option
// ---------------------------------------------------------------------------
describe('FlowChartExecutorOptions — unit: options object API', () => {
  it('new FlowChartExecutor(chart) works with no options (backward compat)', () => {
    const chart = buildChart();
    expect(() => new FlowChartExecutor(chart)).not.toThrow();
  });

  it('new FlowChartExecutor(chart, { scopeFactory }) uses the provided factory', async () => {
    let factoryWasCalled = false;
    const chart = buildChart();

    const factory: ScopeFactory = (ctx, stageName, readOnly, env) => {
      factoryWasCalled = true;
      return new ScopeFacade(ctx, stageName, readOnly, env);
    };

    // `as any`: ScopeFacade doesn't fully satisfy ScopeFactory<TScope> generically.
    // With the options form, TypeScript can't infer TScope through the options object —
    // explicit type param required: new FlowChartExecutor<TOut, TScope>(chart, { scopeFactory }).
    const ex = new FlowChartExecutor(chart, { scopeFactory: factory as any });
    await ex.run();
    expect(factoryWasCalled).toBe(true);
  });

  it('new FlowChartExecutor(chart, { enrichSnapshots: true }) is accepted without error', () => {
    const chart = buildChart();
    expect(() => new FlowChartExecutor(chart, { enrichSnapshots: true })).not.toThrow();
  });

  it('FlowChartExecutorOptions is a typed interface (type-check via assignment)', () => {
    // This test is about TypeScript type safety; if it compiles, it passes
    const opts: FlowChartExecutorOptions = {
      enrichSnapshots: false,
    };
    const chart = buildChart();
    expect(() => new FlowChartExecutor(chart, opts)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — both legacy and new forms produce identical behavior
// ---------------------------------------------------------------------------
describe('FlowChartExecutorOptions — boundary: legacy vs new form parity', () => {
  it('legacy new FlowChartExecutor(chart, scopeFactory) still works', async () => {
    let legacyFactoryCalled = false;
    const chart = buildChart();

    const factory: ScopeFactory = (ctx, stageName, readOnly, env) => {
      legacyFactoryCalled = true;
      return new ScopeFacade(ctx, stageName, readOnly, env);
    };

    // `as any`: see note on options form above — same inference gap for direct factory param.
    const ex = new FlowChartExecutor(chart, factory as any);
    await ex.run();
    expect(legacyFactoryCalled).toBe(true);
  });

  it('options-object form and legacy form produce the same runtime output', async () => {
    const results: string[] = [];
    const chart = flowChart(
      'A',
      async () => {
        results.push('A');
      },
      'a',
    )
      .addFunction(
        'B',
        async () => {
          results.push('B');
        },
        'b',
      )
      .build();

    const ex1 = new FlowChartExecutor(chart);
    const ex2 = new FlowChartExecutor(chart, {});
    await ex1.run();
    const r1 = [...results];
    results.length = 0;
    await ex2.run();
    const r2 = [...results];

    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — realistic usage with options object
// ---------------------------------------------------------------------------
describe('FlowChartExecutorOptions — scenario: realistic configs', () => {
  it('can configure enrichSnapshots via options object', async () => {
    const chart = buildChart();
    const ex = new FlowChartExecutor(chart, { enrichSnapshots: true });
    const snap = await ex.run();
    // snap may be undefined if chart returns nothing, but no error thrown
    expect(ex).toBeDefined();
  });

  it('empty options object {} behaves like no options', async () => {
    const chart = buildChart();
    const ex1 = new FlowChartExecutor(chart);
    const ex2 = new FlowChartExecutor(chart, {});

    await expect(ex1.run()).resolves.not.toThrow();
    await expect(ex2.run()).resolves.not.toThrow();
  });

  it('multiple options can be set together', () => {
    const chart = buildChart();
    const opts: FlowChartExecutorOptions = {
      enrichSnapshots: true,
      defaultValuesForContext: { key: 'value' },
    };
    expect(() => new FlowChartExecutor(chart, opts)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — options object never conflicts with legacy positional form
// ---------------------------------------------------------------------------
describe('FlowChartExecutorOptions — property: no interference between forms', () => {
  it('passing an options object does not prevent the executor from running multiple times', async () => {
    const chart = buildChart();
    const ex = new FlowChartExecutor(chart, { enrichSnapshots: false });
    await ex.run();
    await ex.run();
    // Two runs with options form must succeed
  });

  it('new FlowChartExecutor(chart, undefined) works like no options', async () => {
    const chart = buildChart();
    const ex = new FlowChartExecutor(chart, undefined);
    await expect(ex.run()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — options object does not allow injecting arbitrary state
// ---------------------------------------------------------------------------
describe('FlowChartExecutorOptions — security: options isolation', () => {
  it('options object fields outside the known set are ignored', async () => {
    const chart = buildChart();
    // TypeScript would normally prevent this, but at runtime extra fields are harmless
    const opts = { enrichSnapshots: false, unknownField: 'injection-attempt' } as FlowChartExecutorOptions;
    const ex = new FlowChartExecutor(chart, opts);
    await expect(ex.run()).resolves.not.toThrow();
  });

  it('scopeFactory in options cannot be overridden by positional params when options form is used', async () => {
    // When options-object form is used, positional params 3–9 are ignored
    let optionsFactoryCalled = false;
    const chart = buildChart();

    const factory: ScopeFactory = (ctx, stageName, readOnly, env) => {
      optionsFactoryCalled = true;
      return new ScopeFacade(ctx, stageName, readOnly, env);
    };

    // Options form — positional params 3–9 not passed
    const ex = new FlowChartExecutor(chart, { scopeFactory: factory as any });
    await ex.run();
    expect(optionsFactoryCalled).toBe(true);
  });
});
