/**
 * A time limit already reached leaves no time (P2 addendum #9) — the runner's reading, whatever the clock says.
 *
 * WHY: a host timer can fire a millisecond before the clock reaches the deadline. The run's signal has then aborted
 * at the deadline, but `deadline − now` still reads a little time left — and the decision used to say `retry`,
 * then cut the series at the wait. The time left is now at most 0 once the signal aborted at a time limit.
 *
 * Test types: Unit (a fake clock that still reads before the deadline when the deadline's abort lands).
 */
import { describe, expect, it } from 'vitest';

import { deadlineReason } from '../../../../src/lib/attempt/deadline.js';
import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptContext, AttemptRecord } from '../../../../src/lib/attempt/types.js';

const hang = (_n: number, t: AttemptContext) =>
  new Promise<never>((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason)));

describe('a reached time limit leaves no time', () => {
  it('the deadline’s abort lands while the clock reads 10 ms early: stop no-time-left, time left 0', async () => {
    let clock = 0;
    const run = new AbortController();
    const records: AttemptRecord[] = [];
    const pending = runAttempts(
      hang,
      { attempts: 3 },
      {
        series: 's#0',
        signal: run.signal,
        deadline: 1_000,
        now: () => clock,
        raced: false,
        onAttempt: (record) => records.push(record),
      },
    );
    clock = 990; // the timer fired early: the clock has not reached the deadline
    run.abort(deadlineReason('the run passed its deadline'));
    await expect(pending).rejects.toThrow('the run passed its deadline');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'timeout', next: 'stop', reason: 'no-time-left', timeLeftMs: 0 });
  });

  it('a CANCELLATION is not a time limit: the clock’s time left stands, and the series stops aborted', async () => {
    let clock = 0;
    const run = new AbortController();
    const records: AttemptRecord[] = [];
    const pending = runAttempts(
      hang,
      { attempts: 3 },
      {
        series: 's#0',
        signal: run.signal,
        deadline: 1_000,
        now: () => clock,
        onAttempt: (record) => records.push(record),
      },
    );
    clock = 990;
    run.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(records[0]).toMatchObject({ outcome: 'aborted', reason: 'aborted', timeLeftMs: 10 });
  });
});
