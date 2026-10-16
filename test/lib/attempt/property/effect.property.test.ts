/**
 * Side-effect safety — PROPERTY tests (design §3.3, packet P3), over random series on a real chart.
 *
 * For any sequence of attempt results on a touching stage (an answer; a failure the adapter declared harmless —
 * `effect: 'none'`; a failure it did not), and any ceiling:
 *   1. every record's `effect` is a function of that attempt alone — `ok → applied`, a declared-harmless failure →
 *      `none`, anything else → `unknown` — and every record names the system and the same recorded key;
 *   2. the stage fails with `UnknownEffectError` EXACTLY when it ends without an answer and ANY attempt left the
 *      effect unknown, with the last attempt's own error as its `cause`; otherwise it ends as it would without
 *      `touches` (the value, or the attempt's own error) — an unknown outcome is never reported as failed or ok;
 *   3. the key rule runs once per execution, whatever the number of attempts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import { flowChart, FlowChartExecutor, UnknownEffectError } from '../../../../src/index.js';

type S = Record<string, unknown>;
type Step = 'ok' | 'none' | 'unknown';

describe('effect — properties', () => {
  it('records, the stop error and the key rule follow the law for any series', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Step>('ok', 'none', 'unknown'), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 5 }),
        async (steps, ceiling) => {
          let calls = 0;
          let keyCalls = 0;
          const thrown: Error[] = [];
          const chart = flowChart<S>(
            'Charge',
            () => {
              const step = steps[Math.min(calls, steps.length - 1)];
              calls += 1;
              if (step === 'ok') return;
              const error = Object.assign(new Error(`attempt ${calls}`), step === 'none' ? { effect: 'none' } : {});
              thrown.push(error);
              throw error;
            },
            'charge',
          )
            .touches('stripe', {
              idempotencyKey: () => {
                keyCalls += 1;
                return 'order-1';
              },
            })
            .retry({ attempts: ceiling })
            .build();
          const executor = new FlowChartExecutor(chart);
          let rejection: unknown;
          await executor.run().catch((e: unknown) => (rejection = e));
          const records = (executor.getSnapshot().executionTree as StageSnapshot).attempts ?? [];

          expect(keyCalls).toBe(1);
          records.forEach((record, i) => {
            const step = steps[Math.min(i, steps.length - 1)];
            expect(record.effect).toBe(step === 'ok' ? 'applied' : step);
            expect(record.system).toBe('stripe');
            expect(record.idempotencyKey).toBe('order-1');
          });
          const last = records[records.length - 1];
          const anyUnknown = records.some((r) => r.effect === 'unknown');
          if (last.effect !== 'applied' && anyUnknown) {
            expect(rejection).toBeInstanceOf(UnknownEffectError);
            expect((rejection as Error).cause).toBe(thrown[thrown.length - 1]);
            expect((rejection as UnknownEffectError).attempts).toBe(records.length);
          } else if (last.effect === 'none') {
            expect(rejection).toBe(thrown[thrown.length - 1]);
          } else {
            expect(rejection).toBeUndefined();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
