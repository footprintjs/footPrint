/**
 * The attempt record — PERFORMANCE, in operation counts (the `retry-cost.test.ts` method: work is countable,
 * wall clocks on a shared runner are not).
 *
 *   - The runner adds no clone per attempt: a retried stage that reads and writes nothing does exactly the
 *     `structuredClone` work of the same stage succeeding first try. The record holds the served error's named
 *     fields and the evidence's summaries — built, never cloned.
 *   - A never-firing policy adds exactly its evidence: one `onAttempt` per stage execution and nothing else
 *     (`retry-cost.test.ts` pins that invocations, commits, writes and stage events stay identical).
 *   - A decision is O(rules): six rows at most, whatever the ceiling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type TypedScope, flowChart, FlowChartExecutor } from '../../../src/index.js';

type S = Record<string, unknown>;

afterEach(() => vi.restoreAllMocks());

async function clonesOf(build: () => ReturnType<ReturnType<typeof flowChart<S>>['build']>): Promise<number> {
  const chart = build();
  const spy = vi.spyOn(globalThis, 'structuredClone');
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const count = spy.mock.calls.length;
  spy.mockRestore();
  return count;
}

/** A stage that touches no state: fails `fails` times, then returns. */
function silent(fails: number) {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls <= fails) throw new Error(`fail ${calls}`);
  };
}

describe('attempts — the runner adds no clone per attempt', () => {
  it('positive control: the spy sees the engine’s clones', async () => {
    const count = await clonesOf(() =>
      flowChart<S>(
        'Write',
        (scope: S) => {
          scope.payload = { a: [1, 2, 3] };
        },
        'write',
      ).build(),
    );
    expect(count).toBeGreaterThan(0);
  });

  it('three attempts cost the clones of one', async () => {
    const retried = await clonesOf(() => flowChart<S>('Silent', silent(2), 'silent').retry({ attempts: 3 }).build());
    const firstTry = await clonesOf(() => flowChart<S>('Silent', silent(0), 'silent').retry({ attempts: 3 }).build());
    expect(retried).toBe(firstTry);
  });
});

describe('calls — a `$call` costs its records, never a clone (P2)', () => {
  it('a single call (`attempts: 1`) costs exactly ONE record and no clone', async () => {
    const withCall = await clonesOf(() =>
      flowChart<S>(
        'Call',
        async (scope: TypedScope<S>) => {
          await scope.$call('svc', () => 1);
        },
        'call',
      ).build(),
    );
    const without = await clonesOf(() =>
      flowChart<S>(
        'Call',
        async () => {
          await Promise.resolve(1);
        },
        'call',
      ).build(),
    );
    expect(withCall).toBe(without);
    const chart = flowChart<S>(
      'Call',
      async (scope: TypedScope<S>) => {
        await scope.$call('svc', () => 1);
      },
      'call',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().executionTree.attempts).toHaveLength(1);
  });

  it('three call attempts cost the clones of one', async () => {
    const callFailing = (fails: number) => () =>
      flowChart<S>(
        'Call',
        async (scope: TypedScope<S>) => {
          await scope.$call('svc', silent(fails), { attempts: 3 });
        },
        'call',
      ).build();
    expect(await clonesOf(callFailing(2))).toBe(await clonesOf(callFailing(0)));
  });
});

describe('attempts — a never-firing policy adds only its evidence', () => {
  async function attemptEvents(withPolicy: boolean, stages: number): Promise<number> {
    let builder = flowChart<S>('Stage 0', () => undefined, 'stage-0');
    if (withPolicy) builder = builder.retry({ attempts: 3 });
    for (let i = 1; i < stages; i++) {
      builder = builder.addFunction(`Stage ${i}`, () => undefined, `stage-${i}`);
      if (withPolicy) builder = builder.retry({ attempts: 3 });
    }
    const executor = new FlowChartExecutor(builder.build());
    let events = 0;
    executor.attachFlowRecorder({ id: 'count', onAttempt: () => (events += 1) });
    await executor.run();
    return events;
  }

  it('one onAttempt per stage execution with a policy; none without', async () => {
    expect(await attemptEvents(true, 40)).toBe(40);
    expect(await attemptEvents(false, 40)).toBe(0);
  });
});
