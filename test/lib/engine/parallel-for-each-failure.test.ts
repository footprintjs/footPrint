/**
 * A `parallelForEach` stage that fails leaves what every other failed stage leaves.
 *
 * The law for a failed stage: what it staged is committed (so the stage has a bundle, a stop the
 * cursor can stand on), then `onError` fires for it, then the run rejects with the original value,
 * and the run's failure context names the stage. The fan-out stage had no error path at all:
 *
 * - when its `items` selector threw or returned something that is not an array, or `branch()` threw
 *   or handed back something that is not a chart, the stage left no bundle and no `onError`, and the
 *   run's failure context named no stage;
 * - when a branch failed under `failFast` the stage left no bundle;
 * - its success commit was the bare one, so a commit that failed fired no `onError`.
 *
 * A branch that fails is reported by its own stage. The fan-out stage does what a subflow mount
 * does for an inner failure: it commits and passes the error on, without reporting it a second time.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';

type S = Record<string, any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The failures below are expected: keep the engine's error log out of the test output. */
const silent = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

/** One stage per branch; the branch for item 2 throws. */
const branch = (item: unknown) =>
  flowChart<S>(
    'B',
    (s) => {
      if (item === 2) throw new Error('boom');
      s.v = item;
    },
    'b',
  ).build();

async function run(config: Record<string, unknown>) {
  const chart = flowChart<S>(
    'Start',
    (s) => {
      s.list = [1, 2, 3];
    },
    'start',
  )
    .addParallelForEach('Fan', 'fan', config as never)
    .setLogger(silent)
    .build();
  const executor = new FlowChartExecutor(chart);
  const events: string[] = [];
  executor.attachFlowRecorder({
    id: 'flow',
    onError: (event: { stageName: string }) => events.push(`error:${event.stageName}`),
    onStageExecuted: (event: { stageName: string }) => events.push(`executed:${event.stageName}`),
  } as never);
  executor.attachScopeRecorder({
    id: 'scope',
    onStageStart: (event: { stageName: string }) => events.push(`start:${event.stageName}`),
    onStageEnd: (event: { stageName: string }) => events.push(`end:${event.stageName}`),
    onCommit: (event: { stageName: string }) => events.push(`commit:${event.stageName}`),
  } as never);
  let rejected: unknown;
  try {
    await executor.run();
  } catch (error) {
    rejected = error;
  }
  return {
    executor,
    rejected,
    events,
    /** What the fan-out stage itself did, in order. */
    fan: () => events.filter((event) => event.endsWith(':Fan')),
    errors: () => events.filter((event) => event.startsWith('error:')),
    /** Each bundle on the run's log, as `<runtimeStageId>` or `<runtimeStageId>:<phase>`. */
    commits: () =>
      executor
        .getSnapshot()
        .commitLog.map((bundle) => `${bundle.runtimeStageId}${bundle.phase ? `:${bundle.phase}` : ''}`),
    failedAt: () => executor.getFailureContext()?.stage?.runtimeStageId,
  };
}

describe("parallelForEach — the stage's own failure: commit, then onError, then the original value", () => {
  const ownFailures: Array<[string, Record<string, unknown>, (rejected: unknown) => void]> = [
    [
      'the items selector throws',
      {
        items: () => {
          throw new Error('items bad');
        },
        branch,
      },
      (rejected) => expect((rejected as Error).message).toBe('items bad'),
    ],
    [
      'the items selector returns something that is not an array',
      { items: () => 'not a list', branch },
      (rejected) => expect((rejected as Error).message).toMatch(/items\(\) must return an array/),
    ],
    [
      'branch() throws',
      {
        items: (s: S) => s.list,
        branch: () => {
          throw new Error('no chart for you');
        },
      },
      (rejected) => expect((rejected as Error).message).toBe('no chart for you'),
    ],
    [
      'branch() hands back something that is not a chart',
      { items: (s: S) => s.list, branch: () => ({ not: 'a chart' }) },
      (rejected) => expect((rejected as Error).message).toMatch(/must return a built chart/),
    ],
  ];

  it.each(ownFailures)('%s', async (_name, config, checkRejection) => {
    const ran = await run({ maxBranches: 4, into: 'out', ...config });
    checkRejection(ran.rejected);
    // The stage has its bundle, and no branch ran.
    expect(ran.commits()).toEqual(['start#0', 'fan#1']);
    // Commit before onError, and no onStageEnd: the stage did not end.
    expect(ran.fan()).toEqual(['start:Fan', 'commit:Fan', 'error:Fan']);
    expect(ran.failedAt()).toBe('fan#1');
  });

  it('rejects with the very value that was thrown', async () => {
    const original = { not: 'an Error' };
    const ran = await run({
      items: () => {
        throw original;
      },
      branch,
      maxBranches: 4,
      into: 'out',
    });
    expect(ran.rejected).toBe(original);
    expect(ran.errors()).toEqual(['error:Fan']);
  });

  it('a results array that cannot be committed fails the stage like any other failed commit', async () => {
    // The branch's last stage returns a function, so the results array cannot be cloned at the commit.
    const ran = await run({
      items: () => [1],
      branch: () => flowChart<S>('B', () => (() => 1) as never, 'b').build(),
      maxBranches: 4,
      into: 'out',
    });
    expect((ran.rejected as Error).name).toBe('DataCloneError');
    // The stage ended, its commit failed (so no bundle), and the failure is reported under its name.
    expect(ran.fan()).toEqual(['start:Fan', 'executed:Fan', 'end:Fan', 'error:Fan']);
    expect(ran.commits()).not.toContain('fan#1');
    expect(ran.failedAt()).toBe('fan#1');
  });
});

describe("parallelForEach — a branch's failure: the branch reports it, the fan-out stage commits and passes it on", () => {
  it('failFast: one report, under the branch stage; the fan-out stage still has its bundle', async () => {
    const ran = await run({ items: (s: S) => s.list, branch, maxBranches: 4, into: 'out', failFast: true });
    expect((ran.rejected as Error).message).toBe('boom');
    expect(ran.errors()).toEqual(['error:fan~1/B']);
    expect(ran.fan()).toEqual(['start:Fan', 'executed:Fan', 'commit:Fan']);
    expect(ran.commits()).toContain('fan#1');
    // The run's failure is the branch stage's, not the fan-out's.
    expect(ran.failedAt()).toBe('fan~1/b#5');
  });

  it('failFast with a slow sibling: the stage commits when the run rejects, the sibling finishes after', async () => {
    const ran = await run({
      items: (s: S) => s.list,
      branch: (item: unknown) =>
        flowChart<S>(
          'B',
          async (s) => {
            if (item === 1) throw new Error('boom');
            await sleep(20);
            s.v = item;
          },
          'b',
        ).build(),
      maxBranches: 4,
      into: 'out',
      failFast: true,
    });
    expect((ran.rejected as Error).message).toBe('boom');
    const atRejection = ran.commits();
    expect(atRejection).toContain('fan#1');
    expect(atRejection).not.toContain('fan~2#6');

    await sleep(60);
    // The siblings were not cancelled (failFast never did): their bundles land after the stage's.
    const after = ran.commits();
    expect(after.indexOf('fan#1')).toBeLessThan(after.indexOf('fan~2#6'));
    expect(ran.errors()).toEqual(['error:fan~0/B']);
  });

  it('best-effort (the default) is unchanged: the failed slot is empty and the stage succeeds', async () => {
    const ran = await run({ items: (s: S) => s.list, branch, maxBranches: 4, into: 'out' });
    expect(ran.rejected).toBeUndefined();
    expect(ran.errors()).toEqual(['error:fan~1/B']);
    expect(ran.fan()).toEqual(['start:Fan', 'executed:Fan', 'end:Fan', 'commit:Fan']);
    const out = (ran.executor.getSnapshot().sharedState as S).out;
    expect(out.map((entry: S | null | undefined) => entry?.v)).toEqual([1, undefined, 3]);
    expect(ran.executor.getFailureContext()).toBeUndefined();
  });

  it("a branch's pause passes through: the run pauses, and nothing is reported as an error", async () => {
    const ran = await run({
      items: () => [1, 2],
      branch: (item: unknown) =>
        flowChart<S>(
          'B',
          (s) => {
            s.v = item;
          },
          'b',
        )
          .addPausableFunction(
            'Ask',
            { execute: () => (item === 2 ? { question: 'go on?' } : undefined), resume: () => {} } as never,
            'ask',
          )
          .build(),
      maxBranches: 4,
      into: 'out',
    });
    expect(ran.rejected).toBeUndefined();
    expect(ran.executor.isPaused()).toBe(true);
    expect(ran.errors()).toEqual([]);
  });
});

describe('parallelForEach — a stage that succeeds is unchanged', () => {
  it('with branches: start, the fork event, end, commit', async () => {
    const ran = await run({ items: () => [1, 3], branch, maxBranches: 4, into: 'out' });
    expect(ran.rejected).toBeUndefined();
    expect(ran.fan()).toEqual(['start:Fan', 'executed:Fan', 'end:Fan', 'commit:Fan']);
    expect(ran.commits()).toEqual(['start#0', 'fan~0#2', 'fan~1#4', 'fan~0#2:repeat', 'fan~1#4:repeat', 'fan#1']);
  });

  it('with no items: start, end, commit, then the fork event', async () => {
    const ran = await run({ items: () => [], branch, maxBranches: 4, into: 'out' });
    expect(ran.rejected).toBeUndefined();
    expect(ran.fan()).toEqual(['start:Fan', 'end:Fan', 'commit:Fan', 'executed:Fan']);
    expect(ran.commits()).toEqual(['start#0', 'fan#1']);
  });
});
