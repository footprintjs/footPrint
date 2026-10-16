/** Independent arithmetic oracle over adversarial counts and latencies; projection uses recorded attempts only. */
import fc from 'fast-check';
import { expect, it } from 'vitest';

import { attempts } from '../../../../src/recorders.js';
it('nearest-rank, sums, bounded exemplars and identities match an independent oracle', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 1, max: 10 }),
      (durations, limit) => {
        const rec = attempts({ exemplars: limit });
        durations.forEach((durationMs, index) =>
          rec.onAttempt({
            stageName: 'Step',
            stageId: 'step',
            traversalContext: {
              runId: 'run',
              stageId: 'step',
              runtimeStageId: `step#${index}`,
              stageName: 'Step',
              depth: 0,
            },
            record: {
              series: `step#${index}`,
              kind: 'stage',
              attempt: 1,
              of: 1,
              startedAt: index,
              durationMs,
              outcome: 'ok',
              next: 'done',
              reason: 'succeeded',
              decision: { rules: [], chosen: 'done', default: 'retry' },
            },
          }),
        );
        const stats = rec.byTarget().get('step')!;
        const sorted = [...durations].sort((a, b) => a - b);
        expect(stats.count).toBe(durations.length);
        expect(stats.budgetUsedMs).toBe(durations.reduce((n, v) => n + v, 0));
        expect(stats.latencyMs.p50).toBe(sorted[Math.ceil(sorted.length * 0.5) - 1]);
        expect(stats.latencyMs.p95).toBe(sorted[Math.ceil(sorted.length * 0.95) - 1]);
        expect(stats.exemplars.slowest.length).toBe(Math.min(limit, durations.length));
        for (const ref of stats.exemplars.slowest) {
          const index = Number(/^step#(\d+)@1$/.exec(ref.id)![1]);
          expect(ref.durationMs).toBe(durations[index]);
          expect(ref.runId).toBe('run');
        }
      },
    ),
    { numRuns: 100 },
  );
});
