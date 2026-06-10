/**
 * RFC-001 Blocks 6–9 — PERFORMANCE + LOAD tests for the wired deferred tier.
 *
 * Perf: the zero-opt-in path allocates nothing and stays within the same
 * envelope as a bare run; capture is cheap enough that a deferred no-op
 * listener doesn't blow up a hot loop. Load: a 10k-event stream is fully
 * delivered with zero loss under the default queue bound.
 *
 * Budgets are deliberately generous (CI machines vary) — these are
 * regression tripwires, not micro-benchmarks (bench/ owns those).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

function loopChart(iterations: number, writesPerIteration: number) {
  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        const i = scope.$getValue('i') as number;
        for (let w = 0; w < writesPerIteration; w++) scope.$setValue(`k${w}`, i);
        scope.$setValue('i', i + 1);
        if (i + 1 >= iterations) scope.$break();
      },
      'work',
    )
    .loopTo('work')
    .build();
}

describe('Blocks 6–9 — perf + load', () => {
  it('perf: a deferred no-op listener on a 200-iteration loop stays within budget', async () => {
    const executor = new FlowChartExecutor(loopChart(200, 3));
    executor.attachScopeRecorder({ id: 'noop', onWrite: () => undefined }, { delivery: 'deferred' });
    const start = performance.now();
    await executor.run();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2_000); // generous tripwire
    const stats = executor.getSnapshot().observerStats!;
    expect(stats.drops).toBe(0);
    expect(stats.depth).toBe(0);
  });

  it('load: 10k events are fully delivered with zero loss under the default bound', async () => {
    // 500 iterations × (4 writes + 1 read + ...) ≈ well above 10k captures
    // when stage start/end are observed too.
    const ITERATIONS = 500;
    let received = 0;
    const executor = new FlowChartExecutor(loopChart(ITERATIONS, 18));
    executor.attachScopeRecorder(
      {
        id: 'load-sink',
        onWrite: () => (received += 1),
        onStageStart: () => (received += 1),
        onStageEnd: () => (received += 1),
      },
      { delivery: 'deferred' },
    );
    await executor.run();
    const stats = executor.getSnapshot().observerStats!;
    expect(received).toBeGreaterThan(10_000);
    expect(stats.drops).toBe(0); // default 10k bound never saturated (flushes interleave)
    expect(stats.depth).toBe(0); // fully drained at run end
    expect(stats.perListener['load-sink'].events).toBe(received);
  });
});
