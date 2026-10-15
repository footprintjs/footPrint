/**
 * A stage's retry policy, run by the attempt runner — every stage kind, the event order, the execution tree.
 *
 * WHY: before 10.1 a retried stage said nothing about its attempts but "attempt N failed, retrying" — not how long
 * a try took, not why retrying stopped, and nothing at all when `retryOn` declined. The runner records every
 * attempt and every decision, on the execution tree (`StageSnapshot.attempts` / `attemptSummary`) and on the
 * `onAttempt` hook, never on the commit bundle (design Q1).
 *
 * Test types: Functional (every stage kind the engine funnels through `executeStage`: linear, streaming, pausable,
 * decider, selector, fork child, subflow inner) · Scenario (the event ORDER on a real chart, success, exhaustion
 * and decline; a loop; a pause and a resume; deferred delivery) · Boundary (`attempts: 1` and no policy record
 * nothing).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptRecord, FlowAttemptEvent, FlowRecorder } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index.js';

type S = Record<string, unknown>;

/** A stage function that throws `boom <n>` for its first `fails` calls. */
function flaky(fails: number, write = 'value') {
  let calls = 0;
  return (scope: S) => {
    calls += 1;
    if (calls <= fails) throw new Error(`boom ${calls}`);
    scope[write] = `ok after ${calls}`;
  };
}

/** Every node of an execution tree, depth first. */
function nodes(root: StageSnapshot | undefined): StageSnapshot[] {
  const out: StageSnapshot[] = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (node.next) stack.push(node.next);
    for (const child of node.children ?? []) stack.push(child);
  }
  return out;
}

function node(executor: FlowChartExecutor<any, any>, id: string): StageSnapshot {
  const found = nodes(executor.getSnapshot().executionTree as StageSnapshot).find((n) => n.id === id);
  if (!found) throw new Error(`no execution-tree node '${id}'`);
  return found;
}

function attemptProbe(): FlowRecorder & { events: FlowAttemptEvent[] } {
  const events: FlowAttemptEvent[] = [];
  return { id: 'attempt-probe', events, onAttempt: (event) => events.push(event) };
}

const project = (records: readonly AttemptRecord[] | undefined) =>
  (records ?? []).map((r) => [r.attempt, r.outcome, r.next, r.reason]);

describe('a linear stage under a policy — the tree and the hook', () => {
  it('recovers on attempt 3: three records on the node, a summary, one onAttempt per attempt', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(2), 'flaky')
      .retry({ attempts: 3 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const probe = attemptProbe();
    executor.attachFlowRecorder(probe);
    await executor.run();

    const flakyNode = node(executor, 'flaky');
    expect(project(flakyNode.attempts)).toEqual([
      [1, 'failed', 'retry', 'retryable'],
      [2, 'failed', 'retry', 'retryable'],
      [3, 'ok', 'done', 'succeeded'],
    ]);
    expect(flakyNode.attemptSummary).toEqual({
      count: 3,
      ok: 1,
      failed: 2,
      timeout: 0,
      aborted: 0,
      paused: 0,
      last: { next: 'done', reason: 'succeeded' },
    });
    for (const record of flakyNode.attempts!) {
      expect(record.series).toBe(flakyNode.runtimeStageId);
      expect(record.kind).toBe('stage');
      expect(record.of).toBe(3);
      expect(typeof record.startedAt).toBe('number');
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(flakyNode.attempts![0].error).toEqual({ message: 'boom 1', name: 'Error' });
    expect(flakyNode.attempts![0].category).toBe('unknown');

    // The hook carries the same records, in order, stamped with the stage's own execution.
    expect(probe.events.map((e) => e.record)).toEqual(flakyNode.attempts);
    for (const event of probe.events) {
      expect(event.stageName).toBe('Flaky');
      expect(event.stageId).toBe('flaky');
      expect(event.channel).toBe('flow');
      expect(event.traversalContext?.runtimeStageId).toBe(flakyNode.runtimeStageId);
    }
    expect(probe.events[0].structuredError?.raw).toBeInstanceOf(Error);
    expect(probe.events[2].structuredError).toBeUndefined();
    // The records ride the snapshot, never the log: one bundle for the stage, no attempt anywhere in it.
    const log = executor.getSnapshot().commitLog;
    expect(log.filter((b) => b.stageId === 'flaky')).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain('retryable');
  });

  it('a first-try success under a policy is one record; no policy and `attempts: 1` record nothing', async () => {
    const build = (retry?: { attempts: number }) => {
      const b = flowChart<S>('Seed', () => undefined, 'seed').addFunction('Fine', flaky(0), 'fine');
      return (retry ? b.retry(retry) : b).build();
    };
    for (const [retry, expected] of [
      [{ attempts: 3 }, [[1, 'ok', 'done', 'succeeded']]],
      [{ attempts: 1 }, []],
      [undefined, []],
    ] as const) {
      const executor = new FlowChartExecutor(build(retry));
      const probe = attemptProbe();
      executor.attachFlowRecorder(probe);
      await executor.run();
      const fine = node(executor, 'fine');
      expect(project(fine.attempts)).toEqual(expected);
      expect(probe.events).toHaveLength(expected.length);
      if (expected.length === 0) {
        expect(Object.hasOwn(fine, 'attempts')).toBe(false);
        expect(Object.hasOwn(fine, 'attemptSummary')).toBe(false);
      }
    }
  });
});

describe('the event order on a real chart', () => {
  function ordered(chart: ReturnType<ReturnType<typeof flowChart<S>>['build']>) {
    const order: string[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder({
      id: 'scope-order',
      onStageStart: (e) => e.stageName === 'Flaky' && order.push('start'),
      onStageEnd: (e) => e.stageName === 'Flaky' && order.push('end'),
    });
    executor.attachFlowRecorder({
      id: 'flow-order',
      onAttempt: (e) => order.push(`attempt ${e.record.attempt} ${e.record.next}`),
      onStageRetry: (e) => order.push(`retry ${e.attempt}`),
      onError: (e) => order.push(`error ${e.stageName}`),
      onStageExecuted: (e) => e.stageName === 'Flaky' && order.push('executed'),
    });
    return { executor, order };
  }

  it('recovered: start → attempt(1) → retry(1) → … → end → attempt(3) → executed', async () => {
    const { executor, order } = ordered(
      flowChart<S>('Seed', () => undefined, 'seed')
        .addFunction('Flaky', flaky(2), 'flaky')
        .retry({ attempts: 3 })
        .build(),
    );
    await executor.run();
    expect(order).toEqual([
      'start',
      'attempt 1 retry',
      'retry 1',
      'start',
      'attempt 2 retry',
      'retry 2',
      'start',
      'end',
      'attempt 3 done',
      'executed',
    ]);
  });

  it('exhausted: … → attempt(3) stop → onError', async () => {
    const { executor, order } = ordered(
      flowChart<S>('Seed', () => undefined, 'seed')
        .addFunction('Flaky', flaky(9), 'flaky')
        .retry({ attempts: 3 })
        .build(),
    );
    await expect(executor.run()).rejects.toThrow('boom 3');
    expect(order).toEqual([
      'start',
      'attempt 1 retry',
      'retry 1',
      'start',
      'attempt 2 retry',
      'retry 2',
      'start',
      'attempt 3 stop',
      'error Flaky',
    ]);
    expect(node(executor, 'flaky').attemptSummary?.last).toEqual({
      next: 'stop',
      reason: 'exhausted',
      category: 'unknown',
    });
  });

  it('declined: the stop that left no evidence before 10.1 is one attempt, decided "declined"', async () => {
    const { executor, order } = ordered(
      flowChart<S>('Seed', () => undefined, 'seed')
        .addFunction('Flaky', flaky(9), 'flaky')
        .retry({ attempts: 4, retryOn: () => false })
        .build(),
    );
    await expect(executor.run()).rejects.toThrow('boom 1');
    expect(order).toEqual(['start', 'attempt 1 stop', 'error Flaky']);
    const [record] = node(executor, 'flaky').attempts!;
    expect(record.reason).toBe('declined');
    expect(record.decision.rules[4]).toMatchObject({
      type: 'function',
      label: 'declined',
      matched: true,
      inputs: [{ key: 'retryOn', valueSummary: 'false', redacted: false }],
    });
  });
});

describe('every stage kind the engine funnels through executeStage', () => {
  it('a DECIDER: its attempts sit on the decider node; it still routes', async () => {
    let calls = 0;
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addDeciderFunction(
        'Route',
        () => {
          calls += 1;
          if (calls < 2) throw new Error('flaky router');
          return 'left';
        },
        'route',
        undefined,
        { retry: { attempts: 2 } },
      )
      .addFunctionBranch('left', 'Left', (scope: S) => {
        scope.value = 'left';
      })
      .addFunctionBranch('right', 'Right', () => undefined)
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.value).toBe('left');
    expect(project(node(executor, 'route').attempts)).toEqual([
      [1, 'failed', 'retry', 'retryable'],
      [2, 'ok', 'done', 'succeeded'],
    ]);
  });

  it('a SELECTOR', async () => {
    let calls = 0;
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addSelectorFunction(
        'Pick',
        () => {
          calls += 1;
          if (calls < 2) throw new Error('flaky selector');
          return ['one'];
        },
        'pick',
        undefined,
        { retry: { attempts: 2 } },
      )
      .addFunctionBranch('one', 'One', () => undefined)
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(project(node(executor, 'pick').attempts)).toEqual([
      [1, 'failed', 'retry', 'retryable'],
      [2, 'ok', 'done', 'succeeded'],
    ]);
  });

  it('a FORK CHILD: the child’s node carries its own series; the sibling carries none', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addListOfFunction([
        { id: 'flaky-child', name: 'Flaky child', fn: flaky(1), retry: { attempts: 2 } },
        { id: 'steady-child', name: 'Steady child', fn: () => undefined },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const child = node(executor, 'flaky-child');
    expect(project(child.attempts)).toEqual([
      [1, 'failed', 'retry', 'retryable'],
      [2, 'ok', 'done', 'succeeded'],
    ]);
    expect(child.attempts![0].series).toBe(child.runtimeStageId);
    expect(node(executor, 'steady-child').attempts).toBeUndefined();
  });

  it('a stage INSIDE a subflow: the hook names its prefixed id and its own execution', async () => {
    const inner = flowChart<S>('Inner work', flaky(1), 'inner-work').retry({ attempts: 2 }).build();
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addSubFlowChartNext('sf', inner, 'Sub')
      .build();
    const executor = new FlowChartExecutor(chart);
    const probe = attemptProbe();
    executor.attachFlowRecorder(probe);
    await executor.run();
    expect(probe.events.map((e) => [e.stageId, e.record.attempt, e.record.next])).toEqual([
      ['sf/inner-work', 1, 'retry'],
      ['sf/inner-work', 2, 'done'],
    ]);
    expect(probe.events[0].record.series).toBe(probe.events[0].traversalContext?.runtimeStageId);
    expect(probe.events[0].record.series.startsWith('sf/')).toBe(true);
  });

  it('a STREAMING stage', async () => {
    let calls = 0;
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addStreamingFunction(
        'Stream',
        async (scope: S, _breakFn, onToken) => {
          calls += 1;
          onToken?.('t');
          if (calls < 2) throw new Error('stream dropped');
          scope.done = true;
        },
        'stream',
      )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(project(node(executor, 'stream').attempts)).toEqual([
      [1, 'failed', 'retry', 'retryable'],
      [2, 'ok', 'done', 'succeeded'],
    ]);
  });

  it('a PAUSABLE stage: the pause is one attempt, stopped "paused" — never retried', async () => {
    let calls = 0;
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addPausableFunction(
        'Gate',
        {
          execute: () => {
            calls += 1;
            return { question: 'approve?' };
          },
          resume: () => undefined,
        },
        'gate',
      )
      .retry({ attempts: 5 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const result = (await executor.run()) as { paused?: true };
    expect(result.paused).toBe(true);
    expect(calls).toBe(1);
    const gate = node(executor, 'gate');
    expect(project(gate.attempts)).toEqual([[1, 'paused', 'stop', 'paused']]);
    expect(gate.attempts![0].error).toBeUndefined();
    expect(gate.attemptSummary?.last).toEqual({ next: 'stop', reason: 'paused' });
  });
});

describe('loops, pauses and delivery', () => {
  it('a retried stage in a loop: each pass is its own series, under its own runtimeStageId', async () => {
    let failFirstPass = true;
    const chart = flowChart<S>(
      'Seed',
      (scope: S) => {
        scope.passes = 0;
      },
      'seed',
    )
      .addFunction(
        'Work',
        (scope: S) => {
          if (failFirstPass) {
            failFirstPass = false;
            throw new Error('flaky pass');
          }
          scope.passes = (scope.passes as number) + 1;
        },
        'work',
      )
      .retry({ attempts: 2 })
      .addDeciderFunction('More?', (scope: S) => ((scope.passes as number) < 2 ? 'again' : 'done'), 'more')
      .addFunctionBranch('again', 'Again', () => undefined, undefined, { loopTo: 'work' })
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const passes = nodes(executor.getSnapshot().executionTree as StageSnapshot).filter((n) => n.id === 'work');
    expect(passes.map((p) => project(p.attempts))).toEqual(
      expect.arrayContaining([
        [
          [1, 'failed', 'retry', 'retryable'],
          [2, 'ok', 'done', 'succeeded'],
        ],
        [[1, 'ok', 'done', 'succeeded']],
      ]),
    );
    const series = passes.flatMap((p) => p.attempts!.map((a) => a.series));
    expect(new Set(series).size).toBe(passes.length);
  });

  it('an interrupt inside a retried stage pauses (stop "paused"); the resumed leg records its own series', async () => {
    const chart = flowChart<S>('Init', () => undefined, 'init')
      .addFunction(
        'Ask',
        (scope: S) => {
          const answer = interrupt<{ ok: boolean }>(scope, { question: 'go?' });
          scope.answer = answer.ok;
        },
        'ask',
      )
      .retry({ attempts: 3 })
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    expect(project(node(first, 'ask').attempts)).toEqual([[1, 'paused', 'stop', 'paused']]);
    // The checkpoint carries no attempt evidence (lean format 2).
    expect(JSON.stringify(first.getCheckpoint())).not.toContain('"attempts"');

    const second = new FlowChartExecutor(chart);
    await second.resume(first.getCheckpoint()!, { ok: true });
    expect(second.getSnapshot().sharedState.answer).toBe(true);
    const resumed = nodes(second.getSnapshot().executionTree as StageSnapshot).find((n) => n.attempts);
    expect(project(resumed?.attempts)).toEqual([[1, 'ok', 'done', 'succeeded']]);
  });

  it('a recorder attached with delivery: deferred receives every onAttempt, the records intact', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(2), 'flaky')
      .retry({ attempts: 3 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const seen: FlowAttemptEvent[] = [];
    executor.attachFlowRecorder({ id: 'deferred-attempts', onAttempt: (e) => seen.push(e) }, { delivery: 'deferred' });
    await executor.run();
    expect(seen.map((e) => e.record)).toEqual(node(executor, 'flaky').attempts);
  });

  it('the whole snapshot, attempts included, survives structuredClone', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const tree = executor.getSnapshot().executionTree;
    expect(structuredClone(tree)).toEqual(tree);
  });
});
