import { describe, expect, it } from 'vitest';

import { pinnedText, revive } from './bytes.js';

describe('frozen record fixture codec', () => {
  it('restores preserved value kinds and own undefined at every nested depth', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    const value = {
      date,
      invalidDate: new Date(Number.NaN),
      absent: undefined,
      map: new Map([[date, new Set([undefined, 7])]]),
      array: [null, undefined, { valid: true, message: 'ordinary text' }],
    };
    const decoded = revive(JSON.parse(pinnedText(value)));
    expect(decoded).toEqual(value);
    expect(Object.hasOwn(decoded as object, 'absent')).toBe(true);
    expect(revive('«date:not-a-date»')).toEqual(new Date(Number.NaN));
  });

  it('settles what the clock stamps: a time under timestamp / pausedAt / startedAt, a duration under durationMs', () => {
    const settled = JSON.parse(
      pinnedText({ timestamp: 1, pausedAt: 2, attempt: { startedAt: 3, durationMs: 4, startedAtNote: 5 } }),
    );
    expect(settled).toEqual({
      timestamp: '«time»',
      pausedAt: '«time»',
      attempt: { startedAt: '«time»', durationMs: '«ms»', startedAtNote: 5 },
    });
    // Only numbers are settled: a value of another kind under the same name is the record's own.
    expect(JSON.parse(pinnedText({ startedAt: 'never', durationMs: null }))).toEqual({
      startedAt: 'never',
      durationMs: null,
    });
  });

  it('does not mistake ordinary object fields or scalar strings for the tagged container forms', () => {
    const value = { '«map»': 'not an array', '«set»': null, ordinary: 'date:2026-01-02', number: 3 };
    expect(revive(value)).toEqual(value);
    expect(revive(undefined)).toBeUndefined();
  });
});
