/**
 * PROPERTY + LOAD — the ordering law holds for any item list and any
 * interleaving, and a wide fan-out stays bounded.
 *
 * Design: docs/design/execution-control.md — Round B test 6, generalized.
 * The single hand-written ordering test proves the law for one arrangement of
 * delays. This proves it for arrangements nobody thought to write down, which
 * is the only way an ordering claim is worth making.
 *
 * Test types: Property (order == items order under random delays) ·
 * Property (truncation is exactly `min(items, maxBranches)`) ·
 * Load (a wide fan-out completes and stays ordered) · Performance (budget).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

interface State {
  items?: number[];
  results?: Array<{ echoed?: number }>;
  [key: string]: unknown;
}

/** Fan out over `items`, each branch sleeping for its own `delays[i]` ms. */
async function fanOut(items: number[], delays: number[], maxBranches: number) {
  const chart = flowChart<State>(
    'Seed',
    (scope) => {
      scope.items = items;
    },
    'seed',
  )
    .addParallelForEach('Fan out', 'fan-out', {
      items: (scope) => scope.items ?? [],
      branch: (item: number, index: number) =>
        flowChart<{ echoed?: number; [key: string]: unknown }>(
          'Echo',
          async (scope) => {
            const delay = delays[index] ?? 0;
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            scope.echoed = item;
          },
          'echo',
        ).build(),
      maxBranches,
      into: 'results',
    })
    .build();

  const executor = new FlowChartExecutor(chart);
  await executor.run();
  return (executor.getSnapshot().sharedState as State).results ?? [];
}

describe('parallelForEach — ordering property', () => {
  it('results[i] is always item i, for any items and any completion interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 0, maxLength: 6 }),
        fc.array(fc.nat({ max: 8 }), { minLength: 6, maxLength: 6 }),
        async (items, delays) => {
          const results = await fanOut(items, delays, 16);
          expect(results.map((r) => r.echoed)).toEqual(items);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('the branch count is exactly min(items.length, maxBranches), always', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 99 }), { maxLength: 8 }),
        fc.integer({ min: 1, max: 8 }),
        async (items, maxBranches) => {
          const results = await fanOut(items, [], maxBranches);
          expect(results).toHaveLength(Math.min(items.length, maxBranches));
          // And the branches that DID run are the FIRST ones, in order.
          expect(results.map((r) => r.echoed)).toEqual(items.slice(0, maxBranches));
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('parallelForEach — load', () => {
  it('120 branches complete, in order, inside a sane budget', async () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    const start = performance.now();
    const results = await fanOut(items, [], 200);
    const elapsed = performance.now() - start;

    expect(results.map((r) => r.echoed)).toEqual(items);
    expect(elapsed).toBeLessThan(5000);
  });

  it('a fan-out capped well below its item count does not pay for the items it skips', async () => {
    const items = Array.from({ length: 5000 }, (_, i) => i);
    const start = performance.now();
    const results = await fanOut(items, [], 3);
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(3);
    // 5000 items, 3 branches: the ceiling is a real ceiling, not a filter
    // applied after building 5000 charts.
    expect(elapsed).toBeLessThan(1000);
  });
});
