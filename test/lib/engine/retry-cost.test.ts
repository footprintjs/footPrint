/**
 * Declarative per-stage retry — PERFORMANCE and LOAD.
 *
 * Deliberately measured in OPERATION COUNTS, not milliseconds. Wall-clock
 * thresholds on a shared runner are a coin flip; the honest question is
 * whether the feature adds WORK, and work is countable:
 *
 *   - performance: a chart with no policy, and one whose policy never fires,
 *     must do the IDENTICAL amount of engine work — same stage invocations,
 *     same commits, same events. Retry must be free when it does not happen.
 *   - load: under many stages × many attempts, the record stays bounded and
 *     exact — one commit per stage no matter how many attempts ran, and a
 *     retry-event count that matches the arithmetic precisely.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';

interface State {
  [key: string]: unknown;
}

/** Engine work performed by a run, in countable units. */
interface WorkProfile {
  stageInvocations: number;
  commits: number;
  stagesExecuted: number;
  writes: number;
  retries: number;
}

/** Build an N-stage chart; `policy` decides whether each stage declares retry. */
function buildChain(stageCount: number, opts: { withPolicy: boolean; onInvoke: () => void }) {
  let builder = flowChart<State>(
    'Stage 0',
    (scope: State) => {
      opts.onInvoke();
      scope.s0 = 0;
    },
    'stage-0',
  );
  if (opts.withPolicy) builder = builder.retry({ attempts: 3 });

  for (let i = 1; i < stageCount; i++) {
    builder = builder.addFunction(
      `Stage ${i}`,
      (scope: State) => {
        opts.onInvoke();
        scope[`s${i}`] = i;
      },
      `stage-${i}`,
    );
    if (opts.withPolicy) builder = builder.retry({ attempts: 3 });
  }
  return builder.build();
}

async function profile(stageCount: number, withPolicy: boolean): Promise<WorkProfile> {
  let stageInvocations = 0;
  const chart = buildChain(stageCount, { withPolicy, onInvoke: () => (stageInvocations += 1) });

  const executor = new FlowChartExecutor(chart);
  let stagesExecuted = 0;
  let writes = 0;
  let retries = 0;
  executor.attachFlowRecorder({
    id: 'work',
    onStageExecuted: () => (stagesExecuted += 1),
    onStageRetry: () => (retries += 1),
  });
  executor.attachScopeRecorder({ id: 'writes', onWrite: () => (writes += 1) });
  await executor.run();

  return { stageInvocations, commits: executor.getSnapshot().commitLog.length, stagesExecuted, writes, retries };
}

describe('retry — costs nothing when it does not fire', () => {
  it('a never-firing policy does the IDENTICAL work as no policy at all', async () => {
    const withoutPolicy = await profile(40, false);
    const withPolicy = await profile(40, true);

    // Not "close enough" — identical. A declared policy on a stage that never
    // throws must not add an invocation, a commit, an event or a write.
    expect(withPolicy).toEqual(withoutPolicy);
    expect(withPolicy.retries).toBe(0);
  });

  it('scales the same way — no per-stage overhead that grows with chart size', async () => {
    const small = await profile(10, true);
    const large = await profile(40, true);

    // Work is linear in stage count and identical to the no-policy shape:
    // 4x the stages, exactly 4x the invocations and commits.
    expect(large.stageInvocations).toBe(small.stageInvocations * 4);
    expect(large.commits).toBe(small.commits * 4);
    expect(large.retries).toBe(0);
  });
});

describe('retry — the record stays bounded under load', () => {
  it('200 stages that each fail twice: exactly 200 commits and 400 retry events', async () => {
    const STAGES = 200;
    const FAILURES_PER_STAGE = 2;
    const callsByStage = new Map<string, number>();

    const stageFn = (id: string) => (scope: State) => {
      const calls = (callsByStage.get(id) ?? 0) + 1;
      callsByStage.set(id, calls);
      if (calls <= FAILURES_PER_STAGE) throw new Error(`flaky ${id} #${calls}`);
      scope[id] = calls;
    };

    let builder = flowChart<State>('Stage 0', stageFn('stage-0'), 'stage-0').retry({ attempts: 3 });
    for (let i = 1; i < STAGES; i++) {
      builder = builder.addFunction(`Stage ${i}`, stageFn(`stage-${i}`), `stage-${i}`).retry({ attempts: 3 });
    }

    const executor = new FlowChartExecutor(builder.build());
    let retries = 0;
    executor.attachFlowRecorder({ id: 'count', onStageRetry: () => (retries += 1) });
    await executor.run();

    const snapshot = executor.getSnapshot();
    // ONE commit per stage — 600 stage-function runs, 200 executions.
    expect(snapshot.commitLog).toHaveLength(STAGES);
    expect(retries).toBe(STAGES * FAILURES_PER_STAGE);
    // Every stage reached its successful third attempt, and every one of them
    // committed the value from THAT attempt — no state lost to the discards.
    expect([...callsByStage.values()].every((c) => c === FAILURES_PER_STAGE + 1)).toBe(true);
    const state = snapshot.sharedState as State;
    for (let i = 0; i < STAGES; i++) {
      expect(state[`stage-${i}`]).toBe(FAILURES_PER_STAGE + 1);
    }
  });

  it('a deep retry ceiling does not multiply the commit log', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Very flaky',
        (scope: State) => {
          calls += 1;
          if (calls < 50) throw new Error('still flaky');
          scope.done = true;
        },
        'very-flaky',
      )
      .retry({ attempts: 50 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(calls).toBe(50);
    // 50 attempts, ONE bundle: the log measures executions, not tries.
    expect(executor.getSnapshot().commitLog.filter((b) => b.stageId === 'very-flaky')).toHaveLength(1);
  });
});
