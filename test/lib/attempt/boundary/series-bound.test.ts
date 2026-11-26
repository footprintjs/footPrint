/**
 * The attempt runner's own bound — BOUNDARY. The rule table is what stops a series (rule 4, `exhausted`, at the
 * ceiling). If the table, or the first-match loop that evaluates it, ever breaks so that it keeps deciding `retry`, the
 * runner must FAIL at the ceiling, naming the cause, instead of retrying forever: an endless series of microtasks
 * starves every timer, so not even a test timeout could stop it.
 *
 * Here `decideAttempt` is replaced by one that always says `retry`, a table that never stops.
 *
 * Test type: Boundary.
 */
import { describe, expect, it, vi } from 'vitest';

import { runAttempts } from '../../../../src/lib/attempt/runner.js';

vi.mock('../../../../src/lib/attempt/decision.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/lib/attempt/decision.js')>();
  return {
    ...real,
    decideAttempt: (...args: Parameters<typeof real.decideAttempt>) => ({
      ...real.decideAttempt(...args),
      next: 'retry' as const,
      reason: 'retryable' as const,
    }),
  };
});

describe('runAttempts — bounded by its ceiling, whatever the table decides', () => {
  it('a table that never stops fails at the ceiling, with the cause named, after exactly that many attempts', async () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      // Were the bound gone, this series would never stop: park it on an await, so the test times out and fails
      // instead of starving every timer in a loop of microtasks.
      if (calls > 10) return new Promise<never>(() => undefined);
      throw new Error(`failure ${calls}`);
    };
    await expect(runAttempts(run, { attempts: 3 }, { series: 'bound#0' })).rejects.toThrow(
      "runAttempts: the rule table decided 'retry' at the ceiling of 3 attempts",
    );
    expect(calls).toBe(3);
  });

  it('a success the table will not accept fails the same way: the ceiling holds for any outcome', async () => {
    let calls = 0;
    const run = () => (++calls > 10 ? new Promise<never>(() => undefined) : calls);
    await expect(runAttempts(run, { attempts: 1 }, { series: 'bound#1' })).rejects.toThrow(
      /decided 'retry' at the ceiling of 1 attempts/,
    );
    expect(calls).toBe(1);
  });
});
