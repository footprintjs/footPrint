/**
 * `$call` and `observed()` — PROPERTY tests (design §10, packet P2).
 *
 *   1. The call-series invariant, over random failure counts, ceilings and decline points on a real chart: the
 *      records are exactly the attempts the runner made, dense and 1-based, all under ONE series
 *      (`<runtimeStageId>@1.1`); exactly one record does not retry and it is the last; `onAttempt` fires once per
 *      record; the call returns the answer or rejects with the last attempt's own error.
 *   2. The observed-series law, over random report sequences: within a series the reported attempt numbers
 *      strictly grow and share one target and source; a report opens a new series exactly when its number does not
 *      exceed the last one of its target and source.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptRecord, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { ObservedSeriesBook, readObservedReport } from '../../../../src/lib/attempt/observed.js';

type S = Record<string, unknown>;

function expectedSeries(failures: number, attempts: number, declineAt: number) {
  const out: Array<[number, string, string, string]> = [];
  for (let n = 1; ; n++) {
    if (n > failures) return [...out, [n, 'ok', 'done', 'succeeded']];
    if (n >= attempts) return [...out, [n, 'failed', 'stop', 'exhausted']];
    if (n >= declineAt) return [...out, [n, 'failed', 'stop', 'declined']];
    out.push([n, 'failed', 'retry', 'retryable']);
  }
}

async function runCallSeries(failures: number, attempts: number, declineAt: number) {
  let calls = 0;
  let outcome: unknown;
  const chart = flowChart<S>(
    'Stage',
    async (scope: TypedScope<S>) => {
      try {
        outcome = await scope.$call(
          'svc',
          () => {
            calls += 1;
            if (calls <= failures) throw Object.assign(new Error(`boom ${calls}`), { call: calls });
            return `ok ${calls}`;
          },
          { attempts, retryOn: (error) => (error as { call: number }).call < declineAt },
        );
      } catch (error) {
        outcome = error;
      }
    },
    'stage',
  ).build();
  const executor = new FlowChartExecutor(chart);
  const fired: AttemptRecord[] = [];
  executor.attachFlowRecorder({ id: 'p', onAttempt: (e) => fired.push(e.record) });
  await executor.run();
  const stage = executor.getSnapshot().executionTree as StageSnapshot;
  return { records: stage.attempts ?? [], fired, calls, outcome, runtimeStageId: stage.runtimeStageId };
}

describe('the call-series invariant', () => {
  it('records = the attempts made, one series, one non-retry record (the last); hook and result agree', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 7 }),
        async (failures, attempts, declineAt) => {
          const { records, fired, calls, outcome, runtimeStageId } = await runCallSeries(failures, attempts, declineAt);
          const expected = expectedSeries(failures, attempts, declineAt);
          expect(records.map((r) => [r.attempt, r.outcome, r.next, r.reason])).toEqual(expected);
          expect(calls).toBe(expected.length);
          expect(records.length).toBeLessThanOrEqual(attempts);
          expect(records.filter((r) => r.next !== 'retry')).toEqual([records[records.length - 1]]);
          expect(new Set(records.map((r) => r.series))).toEqual(new Set([`${runtimeStageId}@1.1`]));
          expect(records.every((r) => r.kind === 'call' && r.target === 'svc' && r.of === attempts)).toBe(true);
          expect(fired).toEqual(records);
          const last = records[records.length - 1];
          if (last.outcome === 'ok') expect(outcome).toBe(`ok ${calls}`);
          else expect((outcome as Error).message).toBe(`boom ${calls}`);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('the observed-series law', () => {
  const report = fc.record({
    target: fc.constantFrom('stripe', 'openai', 's3'),
    source: fc.constantFrom('sdk', 'proxy'),
    attempt: fc.integer({ min: 1, max: 4 }),
  });

  it('within a series numbers grow under one name; a new series opens exactly when they do not', () => {
    fc.assert(
      fc.property(fc.array(report, { maxLength: 40 }), (reports) => {
        let opened = 0;
        const book = new ObservedSeriesBook(() => `s${++opened}`);
        const last = new Map<string, number>();
        const seriesOf = new Map<string, string>();
        const members = new Map<string, Array<{ name: string; attempt: number }>>();
        for (const r of reports) {
          const name = `${r.source}/${r.target}`;
          const before = opened;
          const series = book.seriesFor(readObservedReport({ ...r, outcome: 'failed', durationMs: 1 }));
          const continues = last.has(name) && r.attempt > last.get(name)!;
          expect(opened > before).toBe(!continues);
          if (continues) expect(series).toBe(seriesOf.get(name));
          last.set(name, r.attempt);
          seriesOf.set(name, series);
          const list = members.get(series) ?? [];
          list.push({ name, attempt: r.attempt });
          members.set(series, list);
        }
        for (const list of members.values()) {
          expect(new Set(list.map((m) => m.name)).size).toBe(1);
          for (let i = 1; i < list.length; i++) expect(list[i].attempt).toBeGreaterThan(list[i - 1].attempt);
        }
      }),
    );
  });
});
