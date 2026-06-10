/**
 * RFC-001 Block 9 — observerStats on RuntimeSnapshot + honest backpressure
 * accounting (forced drops show true counters and visible seq gaps;
 * 'block' shows inline deliveries and zero loss).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

function burstChart(writes: number) {
  return flowChart<Loose>(
    'Burst',
    async (scope) => {
      for (let i = 0; i < writes; i++) scope.$setValue(`k${i}`, i);
    },
    'burst',
  ).build();
}

describe('Block 9 — observerStats', () => {
  it('is ABSENT from the snapshot when no deferred observer was ever attached (zero-cost discipline)', async () => {
    const executor = new FlowChartExecutor(burstChart(3));
    executor.attachScopeRecorder({ id: 'inline', onWrite: () => undefined }); // inline only
    await executor.run();
    expect(executor.getSnapshot().observerStats).toBeUndefined();
  });

  it('exposes the full A4 shape + terminalStranded once a deferred observer attaches', async () => {
    const executor = new FlowChartExecutor(burstChart(5));
    executor.attachScopeRecorder({ id: 'watcher', onWrite: () => undefined }, { delivery: 'deferred' });
    await executor.run();
    const stats = executor.getSnapshot().observerStats!;
    expect(stats).toMatchObject({
      depth: 0, // post terminal flush, nothing queued
      drops: 0,
      inlineDeliveries: 0,
      inflight: 0,
      terminalStranded: 0,
    });
    expect(typeof stats.flushes).toBe('number');
    expect(stats.flushes).toBeGreaterThan(0);
    expect(typeof stats.budgetExhausted).toBe('number');
    expect(typeof stats.p95FlushMs).toBe('number');
    expect(stats.perListener.watcher).toMatchObject({ events: 5 });
    expect(typeof stats.perListener.watcher.totalMs).toBe('number');
    expect(typeof stats.perListener.watcher.lastFlushMs).toBe('number');
  });

  it('forced drops: a tiny queue under a single-stage burst shows TRUE drop counters and seq gaps', async () => {
    const WRITES = 50;
    const MAX_QUEUE = 4;
    const executor = new FlowChartExecutor(burstChart(WRITES));
    // The single stage bursts 50 captures in one sync slice — the first
    // flush checkpoint can only come after the stage, so the ring saturates.
    executor.attachScopeRecorder(
      { id: 'lossy', onWrite: () => undefined },
      {
        delivery: 'deferred',
        maxQueue: MAX_QUEUE,
        overflow: 'drop-oldest',
      },
    );
    // Track seq gaps via a second view into the same queue: the envelope is
    // not exposed to recorder hooks, so read drops from stats and verify
    // delivery count complements them.
    let delivered = 0;
    executor.attachScopeRecorder({ id: 'counter', onWrite: () => (delivered += 1) }, { delivery: 'deferred' });
    await executor.run();
    const stats = executor.getSnapshot().observerStats!;
    expect(stats.drops).toBeGreaterThan(0);
    // Conservation: every onWrite event was either delivered or counted lost.
    expect(delivered + stats.drops).toBe(WRITES);
    expect(delivered).toBeLessThanOrEqual(MAX_QUEUE + 1); // ring bound honored
    expect(stats.depth).toBe(0); // nothing silently stuck
  });

  it("'block' overflow: zero loss, refusals delivered synchronously inline and counted", async () => {
    const WRITES = 30;
    let delivered = 0;
    const executor = new FlowChartExecutor(burstChart(WRITES));
    executor.attachScopeRecorder(
      { id: 'no-loss', onWrite: () => (delivered += 1) },
      {
        delivery: 'deferred',
        maxQueue: 2,
        overflow: 'block',
      },
    );
    await executor.run();
    const stats = executor.getSnapshot().observerStats!;
    expect(stats.drops).toBe(0);
    expect(stats.inlineDeliveries).toBeGreaterThan(0);
    expect(delivered).toBe(WRITES); // every event arrived (some inline)
  });

  it('budget exhaustion is counted when a slow listener exceeds flushBudgetMs', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        for (let i = 0; i < 8; i++) scope.$setValue(`k${i}`, i);
      },
      'seed',
    )
      .addFunction('Next', async () => undefined, 'next')
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      {
        id: 'slow',
        onWrite: () => {
          const start = Date.now();
          while (Date.now() - start < 3) {
            /* burn past the 1ms budget */
          }
        },
      },
      { delivery: 'deferred', flushBudgetMs: 1 },
    );
    await executor.run();
    const stats = executor.getSnapshot().observerStats!;
    expect(stats.budgetExhausted).toBeGreaterThan(0);
    expect(stats.perListener.slow.totalMs).toBeGreaterThan(0); // A2: name the hog
  });
});
