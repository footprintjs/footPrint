/** P7: recorded attempts, logical decisions, bounded exemplars and provider-free cross-run storage. */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import * as recorders from '../../../../src/recorders.js';

const metrics = (options?: any): any => (recorders as any).attempts(options);
describe('attempt metric recorder', () => {
  it('collects native calls including a declined failure and counts exact outcomes', async () => {
    let tries = 0;
    const rec = metrics({ exemplars: 1 });
    const chart = flowChart(
      'Call',
      async (scope) => {
        await scope.$call(
          'mock.read',
          () => {
            if (++tries < 2) throw new Error('temporary');
            return 'ok';
          },
          { attempts: 3 },
        );
      },
      'call',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();
    const stats = rec.byTarget().get('mock.read');
    expect(stats).toMatchObject({ count: 2, retries: 1, seriesRetried: 1, gaveUp: 0, byOutcome: { failed: 1, ok: 1 } });
    expect(stats.byCategory.unknown).toBe(1);
    expect(stats.exemplars.slowest).toHaveLength(1);
    expect(rec.slowest('mock.read', 1)[0]).toMatchObject({
      target: 'mock.read',
      runId: expect.any(String),
      runtimeStageId: 'call#0',
    });
    expect(structuredClone(rec.toSnapshot())).toEqual(rec.toSnapshot());
  });
  it('joins explicit logical decisions without rewriting a physical unknown or counting its stop as gave-up', async () => {
    const rec = metrics();
    let calls = 0;
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addRetryLoop('charge', {
        touches: 'mock.pay',
        idempotencyKey: () => 'key-1',
        retry: { attempts: 3, timeoutMs: 20 },
        attempt: () => {
          calls++;
          throw new Error('lost');
        },
        reconcile: () => 'applied',
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();
    expect(calls).toBe(1);
    expect(rec.byTarget().get('mock.pay')).toMatchObject({ count: 1, effectUnknown: 1, gaveUp: 0, retries: 0 });
    const series = rec.series('charge#1');
    expect(series.attempts.find((row: any) => row.retryLoop?.phase === 'attempt')).toMatchObject({
      outcome: 'failed',
      effect: 'unknown',
      next: 'stop',
    });
    expect(series.decisions[0]).toMatchObject({ next: 'done', effect: 'applied' });
  });
  it('persists a public payload-free row per event and aggregates independent run identities', async () => {
    const store = (recorders as any).memoryStore();
    const rec = metrics({ store });
    const chart = flowChart('Read', (scope) => scope.$call('mock.read', () => 'ok'), 'read').build();
    for (let n = 0; n < 2; n++) {
      const executor = new FlowChartExecutor(chart);
      executor.attachFlowRecorder(rec);
      await executor.run();
    }
    const aggregate = await rec.aggregate({});
    expect(aggregate.byTarget.get('mock.read').count).toBe(2);
    expect(aggregate.byRun.size).toBe(2);
    const rows = await store.read({});
    expect(rows.filter((row: any) => row.kind === 'attempt')).toHaveLength(2);
    rec.clear();
    expect(rec.byTarget().size).toBe(0);
    expect((await rec.aggregate({})).byTarget.get('mock.read').count).toBe(2);
  });
});
