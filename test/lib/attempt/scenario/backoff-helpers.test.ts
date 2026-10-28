/**
 * The backoff builders on a real stage, through the root door (`footprintjs`).
 *
 * A stage declares `retry({ attempts, backoffMs: exponentialBackoff(...), maxBackoffMs })`: it waits the drawn waits,
 * and `onStageRetry` and the execution tree's attempt records carry each one — the trace explains every wait as it was
 * waited. A stated wait read off the error wins. The static time budget still counts a function backoff at the
 * policy's `maxBackoffMs` — the cap stays the policy's.
 *
 * Test types: Scenario (a retried stage waits the schedule; a stated wait wins; the budget's bound) · Integration (the
 * root door hands out the builders beside `attempt`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FlowStageRetryEvent,
  exponentialBackoff,
  flowChart,
  FlowChartExecutor,
  statedWaitFirst,
  timeBudget,
} from '../../../../src/index.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A stage function that throws `error` on its first `fails` calls. */
function flaky(fails: number, error: () => Error) {
  let calls = 0;
  const stage = () => {
    calls += 1;
    if (calls <= fails) throw error();
  };
  return { stage, calls: () => calls };
}

/** Run `chart` to the end on the virtual clock; the retry delays it announced and the time it took. */
async function runOnVirtualClock(chart: ReturnType<ReturnType<typeof flowChart>['build']>) {
  const executor = new FlowChartExecutor(chart);
  const delays: number[] = [];
  executor.attachFlowRecorder({
    id: 'retries',
    onStageRetry: (event: FlowStageRetryEvent) => delays.push(event.delayMs),
  });
  const started = Date.now();
  const run = executor.run();
  await vi.runAllTimersAsync();
  await run;
  return { executor, delays, elapsed: Date.now() - started };
}

describe('a retried stage waits the schedule it declared', () => {
  it('equal jitter: each wait is drawn once, announced, recorded and waited', async () => {
    const { stage, calls } = flaky(2, () => Object.assign(new Error('busy'), { status: 503 }));
    const draws = [0, 1];
    let next = 0;
    const chart = flowChart('Fetch', stage, 'fetch')
      .retry({
        attempts: 3,
        backoffMs: exponentialBackoff({ baseDelayMs: 100, jitter: 'equal', random: () => draws[next++] }),
        maxBackoffMs: 1_000,
      })
      .build();
    const { executor, delays, elapsed } = await runOnVirtualClock(chart);
    expect(calls()).toBe(3);
    // ceilings 100 then 200; r = 0 → c/2, r = 1 → c
    expect(delays).toEqual([50, 200]);
    expect(executor.getSnapshot().executionTree.attempts?.map((a) => a.delayMs)).toEqual([50, 200, undefined]);
    expect(elapsed).toBe(250);
  });

  it('a stated wait read off the error wins over the schedule, capped by maxBackoffMs', async () => {
    const { stage } = flaky(2, () => Object.assign(new Error('throttled'), { status: 429, retryAfterMs: 60_000 }));
    const retryAfterMs = (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs;
    const chart = flowChart('Quote', stage, 'quote')
      .retry({
        attempts: 3,
        backoffMs: statedWaitFirst(retryAfterMs, exponentialBackoff({ baseDelayMs: 10 })),
        maxBackoffMs: 400,
      })
      .build();
    const { delays, elapsed } = await runOnVirtualClock(chart);
    expect(delays).toEqual([400, 400]);
    expect(elapsed).toBe(800);
  });
});

describe('the time budget counts a function backoff at the policy cap', () => {
  it('attempts × timeoutMs plus one maxBackoffMs per wait — the builder is never called', () => {
    const random = vi.fn(() => 0.5);
    const chart = flowChart('Fetch', () => undefined, 'fetch')
      .retry({
        attempts: 3,
        timeoutMs: 1_000,
        backoffMs: exponentialBackoff({ baseDelayMs: 100, jitter: 'full', random }),
        maxBackoffMs: 2_000,
      })
      .build();
    expect(timeBudget(chart).worstCaseMs).toBe(3 * 1_000 + 2 * 2_000);
    expect(random).not.toHaveBeenCalled();
  });
});
