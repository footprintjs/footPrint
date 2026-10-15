/**
 * `formatting/sentences.ts · attemptSentence` — the one English body of an attempt line, shared by the combined
 * narrative and the flow-only `NarrativeFlowRecorder` (design §5), and `formatDuration`, its one way to say a
 * duration.
 *
 * Test types: Unit (each outcome × each decision; the cause with and without a category) · Boundary (durations
 * across the ms → s edge; a record with no ceiling, no error, no delay).
 */
import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../../../src/lib/attempt/types.js';
import { attemptSentence, formatDuration } from '../../../../../src/lib/engine/narrative/formatting/sentences.js';

const EVIDENCE = { rules: [], chosen: 'retry', default: 'retry', defaultLabel: 'retryable' };

function record(fields: Partial<AttemptRecord>): AttemptRecord {
  return {
    series: 's#1',
    kind: 'stage',
    attempt: 1,
    of: 3,
    startedAt: 0,
    durationMs: 812,
    outcome: 'failed',
    decision: EVIDENCE,
    next: 'retry',
    reason: 'retryable',
    ...fields,
  };
}

describe('attemptSentence', () => {
  it('a failure that is retried — the cause, the category, the wait', () => {
    const line = attemptSentence(
      'Charge card',
      record({ category: 'rate-limited', delayMs: 4_000, error: { message: '429 Too Many Requests' } }),
    );
    expect(line).toBe(
      'Attempt 1 of 3 at Charge card failed in 812ms (rate-limited: 429 Too Many Requests), retrying in 4s.',
    );
  });

  it('an unknown category is left out of the cause; no wait reads "immediately"', () => {
    expect(attemptSentence('Fetch', record({ category: 'unknown', delayMs: 0, error: { message: 'boom' } }))).toBe(
      'Attempt 1 of 3 at Fetch failed in 812ms (boom), retrying immediately.',
    );
  });

  it('success', () => {
    expect(
      attemptSentence(
        'Fetch',
        record({ attempt: 3, outcome: 'ok', next: 'done', reason: 'succeeded', durationMs: 31 }),
      ),
    ).toBe('Attempt 3 of 3 at Fetch succeeded in 31ms.');
  });

  it.each([
    ['exhausted', '; stopped: no attempts left.'],
    ['declined', '; stopped: retryOn declined.'],
  ] as const)('a stop, %s', (reason, tail) => {
    const line = attemptSentence(
      'Charge',
      record({ attempt: 3, next: 'stop', reason, category: 'permanent', error: { message: 'card declined' } }),
    );
    expect(line).toBe(`Attempt 3 of 3 at Charge failed in 812ms (permanent: card declined)${tail}`);
  });

  it('a stop for want of time names the wait it could not afford', () => {
    const line = attemptSentence(
      'Charge',
      record({ next: 'stop', reason: 'no-time-left', delayMs: 2_000, error: { message: 'x' } }),
    );
    expect(line).toBe('Attempt 1 of 3 at Charge failed in 812ms (x); stopped: no time left (next wait 2s).');
  });

  it('a timeout, an abort and a pause say so in their own words', () => {
    expect(attemptSentence('Fetch', record({ outcome: 'timeout', category: 'timeout', durationMs: 40_000 }))).toBe(
      'Attempt 1 of 3 at Fetch timed out after 40s, retrying immediately.',
    );
    expect(
      attemptSentence(
        'Fetch',
        record({
          outcome: 'aborted',
          next: 'stop',
          reason: 'aborted',
          category: 'unknown',
          error: { message: 'cancelled' },
        }),
      ),
    ).toBe('Attempt 1 of 3 at Fetch was aborted after 812ms (cancelled).');
    expect(attemptSentence('Gate', record({ outcome: 'paused', next: 'stop', reason: 'paused', durationMs: 2 }))).toBe(
      'Attempt 1 of 3 at Gate paused after 2ms.',
    );
  });

  it('a record with no ceiling reads "Attempt n"', () => {
    const { of: _of, ...noCeiling } = record({ outcome: 'ok', next: 'done', reason: 'succeeded' });
    expect(attemptSentence('Probe', noCeiling as AttemptRecord)).toBe('Attempt 1 at Probe succeeded in 812ms.');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [31, '31ms'],
    [999, '999ms'],
    [1_000, '1s'],
    [1_500, '1.5s'],
    [40_000, '40s'],
    [120_000, '120s'],
  ])('%d → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
