/**
 * The microtask claim, pinned (design addendum #10): a retried stage runs on the runner's promise — one await per
 * attempt, as the 9.15 loop had — and a stage with no policy keeps its pre-10.1 async frame, so parallel siblings
 * SETTLE in the order they always did. The order is what the commit log records, so the commit log is what is
 * pinned.
 *
 * The chart is a fork of [a retried child, a plain child, a subflow child], then a stage after the join. Each
 * expected order below is the one footprintjs 10.0.1 (the 9.15 loop) commits for the same chart, read off that
 * release when this test was written: a change to the runner's await shape moves a line here.
 *
 * Test types: Scenario (a real fork) · Regression (the 10.0.1 order, per variant).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;

/** The fork; the retried child fails its first `fails` attempts. `policy: false` declares no retry at all. */
function forkChart(fails: number, policy = true) {
  let calls = 0;
  const inner = flowChart<S>(
    'Inner',
    (s: S) => {
      s.inner = 1;
    },
    'inner',
  )
    .addFunction(
      'Inner 2',
      (s: S) => {
        s.inner2 = 2;
      },
      'inner2',
    )
    .build();
  return flowChart<S>(
    'Seed',
    (s: S) => {
      s.seed = 1;
    },
    'seed',
  )
    .addListOfFunction([
      {
        id: 'retried',
        name: 'Retried',
        fn: (s: S) => {
          calls += 1;
          if (calls <= fails) throw new Error(`flaky ${calls}`);
          s.r = calls;
        },
        ...(policy && { retry: { attempts: 3 } }),
      },
      {
        id: 'plain',
        name: 'Plain',
        fn: (s: S) => {
          s.p = 1;
        },
      },
    ])
    .addSubFlowChart('sub', inner, 'Sub')
    .addFunction(
      'After',
      (s: S) => {
        s.after = 1;
      },
      'after',
    )
    .build();
}

async function commitOrder(chart: ReturnType<typeof forkChart>): Promise<string[]> {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  return executor.getSnapshot().commitLog.map((b) => `${b.runtimeStageId}${b.phase ? `:${b.phase}` : ''}`);
}

/** 10.0.1's order when the retried child settles first (in its first or second attempt). */
const RETRIED_FIRST = [
  'seed#0',
  'retried#1',
  'plain#2',
  'retried#1:repeat',
  'plain#2:repeat',
  'sub#3',
  'sub#3:repeat',
  'after#6',
];

describe('a retried fork child settles where 10.0.1 settled it', () => {
  it('succeeds first try: the 10.0.1 order — and the same order as a child with no policy', async () => {
    expect(await commitOrder(forkChart(0))).toEqual(RETRIED_FIRST);
    expect(await commitOrder(forkChart(0, false))).toEqual(RETRIED_FIRST);
  });

  it('recovers on its second attempt: the 10.0.1 order', async () => {
    expect(await commitOrder(forkChart(1))).toEqual(RETRIED_FIRST);
  });

  it('recovers on its third attempt: the plain sibling now settles first — as it did on 10.0.1', async () => {
    expect(await commitOrder(forkChart(2))).toEqual([
      'seed#0',
      'plain#2',
      'retried#1',
      'plain#2:repeat',
      'retried#1:repeat',
      'sub#3',
      'sub#3:repeat',
      'after#6',
    ]);
  });
});
