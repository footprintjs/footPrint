/**
 * recorder/attemptSeries.ts — the one row predicate every built-in recorder shares, and the per-series tally that
 * rebuilds the runner's `AttemptSummary` from `onAttempt` records (P1c).
 *
 * Test types: Unit (the predicate per reason, attempt, timeout and lone attempt; `gaveUp`; the subflow read off an id) · Property (for a
 * random series ending, the book's summary deep-equals the execution tree's) · Boundary (a series cut during its
 * wait has no summary; a first attempt that paused or was aborted is not evidence).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../src/advanced.js';
import type { AttemptRecord } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import {
  AttemptSeriesBook,
  gaveUp,
  isRetryEvidence,
  subflowOfAttempt,
} from '../../../src/lib/recorder/attemptSeries.js';

function record(over: Partial<AttemptRecord>): AttemptRecord {
  return {
    series: 's#1',
    kind: 'stage',
    attempt: 1,
    of: 3,
    startedAt: 0,
    durationMs: 1,
    outcome: 'failed',
    category: 'unknown',
    decision: { chosen: 'retry', rules: [] } as unknown as AttemptRecord['decision'],
    next: 'retry',
    reason: 'retryable',
    ...over,
  };
}

describe('isRetryEvidence — a series that retried or gave up', () => {
  it('only a STAGE’s series: a call’s or an observed attempt is never a per-stage row (P2)', () => {
    for (const kind of ['call', 'observed'] as const) {
      expect(isRetryEvidence(record({ kind, series: 's#1@1.1', attempt: 2 }))).toBe(false);
      expect(isRetryEvidence(record({ kind, series: 's#1@1.1', outcome: 'timeout' }))).toBe(false);
    }
    expect(isRetryEvidence(record({ attempt: 2 }))).toBe(true);
  });

  it('a first attempt that ended the series quietly is not evidence', () => {
    expect(isRetryEvidence(record({ outcome: 'ok', next: 'done', reason: 'succeeded', category: undefined }))).toBe(
      false,
    );
    expect(isRetryEvidence(record({ outcome: 'paused', next: 'stop', reason: 'paused', category: undefined }))).toBe(
      false,
    );
    expect(isRetryEvidence(record({ outcome: 'aborted', next: 'stop', reason: 'aborted' }))).toBe(false);
  });

  it('a retry, any later attempt and every give-up reason are', () => {
    expect(isRetryEvidence(record({}))).toBe(true);
    expect(isRetryEvidence(record({ attempt: 2, outcome: 'ok', next: 'done', reason: 'succeeded' }))).toBe(true);
    for (const reason of ['exhausted', 'declined', 'no-time-left'] as const) {
      expect(isRetryEvidence(record({ next: 'stop', reason }))).toBe(true);
      expect(gaveUp(record({ next: 'stop', reason }))).toBe(true);
    }
    expect(gaveUp(record({ attempt: 2, next: 'stop', reason: 'aborted' }))).toBe(false);
  });

  it('a timeout is evidence, a lone one too; a lone attempt (of: 1) that merely failed is not (P1b)', () => {
    const lone = { of: 1, next: 'stop' as const, reason: 'exhausted' as const };
    expect(isRetryEvidence(record({ ...lone, outcome: 'timeout', category: 'timeout' }))).toBe(true);
    expect(isRetryEvidence(record({ ...lone, outcome: 'failed' }))).toBe(false);
    expect(isRetryEvidence(record({ of: 5, next: 'stop', reason: 'no-time-left' }))).toBe(true);
    expect(isRetryEvidence(record({ outcome: 'timeout', next: 'retry' }))).toBe(true);
  });
});

describe('subflowOfAttempt — read off the execution id', () => {
  it('top level, one subflow, nested', () => {
    expect(subflowOfAttempt({ record: record({ series: 'fetch#3' }) })).toBeUndefined();
    expect(subflowOfAttempt({ record: record({ series: 'sf-pay/charge#4' }) })).toBe('sf-pay');
    expect(
      subflowOfAttempt({
        record: record({ series: 'ignored#1' }),
        traversalContext: { runtimeStageId: 'sf-a/sf-b/charge#9' },
      }),
    ).toBe('sf-a/sf-b');
  });
});

describe('AttemptSeriesBook', () => {
  it('a series cut during its wait keeps its attempts and has no summary', () => {
    const book = new AttemptSeriesBook();
    const state = book.add(record({}));
    expect(state).toEqual({ series: 's#1', attempts: [{ series: 's#1', attempt: 1 }] });
    expect(book.add(record({ outcome: 'ok', next: 'done', reason: 'succeeded', series: 'other#2' }))).toBeUndefined();
  });

  it('property: the summary rebuilt from the records equals the execution tree’s', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        async (attempts, fails, decline) => {
          let calls = 0;
          const chart = flowChart<Record<string, unknown>>('Seed', () => undefined, 'seed')
            .addListOfFunction([
              {
                id: 'work',
                name: 'Work',
                fn: () => {
                  calls += 1;
                  if (calls <= fails) throw Object.assign(new Error('x'), { status: decline ? 400 : 503 });
                },
                retry: { attempts, retryOn: (e) => (e as { status: number }).status !== 400 },
              },
            ])
            .build();
          const executor = new FlowChartExecutor(chart);
          const book = new AttemptSeriesBook();
          let last: ReturnType<AttemptSeriesBook['add']>;
          executor.attachFlowRecorder({ id: 'book', onAttempt: (e) => (last = book.add(e.record) ?? last) });
          await executor.run();
          const tree = executor.getSnapshot().executionTree as StageSnapshot;
          const work = tree.children?.find((c) => c.id === 'work');
          const expected = work?.attemptSummary;
          const quiet = fails === 0; // succeeded first time: no evidence, no summary in the book
          expect(last?.summary).toEqual(quiet ? undefined : expected);
        },
      ),
      { numRuns: 40 },
    );
  });
});
