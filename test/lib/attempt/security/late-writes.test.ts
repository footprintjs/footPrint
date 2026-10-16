/**
 * THREAT: a timed-out attempt keeps running. The engine stops WAITING for it (the race), but the function's own
 * promise lives on — and if it writes through its scope after the stage moved on, that write would land in the
 * next attempt's buffer (and commit as if the next attempt wrote it), or after the stage's commit.
 *
 * THE LAW (P1b): an attempt is fenced the moment it ends without an answer. Its signal aborts it, and every later
 * write or emit through its scope is DROPPED (refused at the facade, so it reaches no buffer, no recorder) and
 * RECORDED on its stage (`StageSnapshot.lateWrites` — names only, never the value). A late read is refused too,
 * so it cannot mark the next attempt's commit with reads or untracked sources it never made.
 *
 * Test types: Security (the four doors: a write during the next attempt, a write after the commit, an emit, a
 * read) · Scenario (on a real chart, with real timers).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptContext, EmitEvent, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nodeOf(executor: FlowChartExecutor<any, any>, id: string): StageSnapshot {
  const stack = [executor.getSnapshot().executionTree as StageSnapshot];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    if (n.next) stack.push(n.next);
    stack.push(...(n.children ?? []));
  }
  throw new Error(`no node ${id}`);
}

describe('a timed-out attempt cannot write after the stage moved on', () => {
  it('a late write DURING the next attempt is dropped — it never reaches that attempt’s commit — and recorded', async () => {
    let calls = 0;
    const lateErrors: unknown[] = [];
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        calls += 1;
        if (calls === 1) {
          // Attempt 1 ignores its signal, outlives its 100 ms cap, and writes at 150 ms — while attempt 2 runs
          // (it starts at ~100 ms and answers at ~190 ms).
          await sleep(150);
          try {
            scope.late = 'from attempt 1';
          } catch (error) {
            lateErrors.push(error);
          }
          return;
        }
        await sleep(90);
        scope.value = 'from attempt 2';
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 2, timeoutMs: 100 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const state = executor.getSnapshot().sharedState as S;
    expect(state.value).toBe('from attempt 2');
    expect(state).not.toHaveProperty('late');
    const bundle = executor.getSnapshot().commitLog.find((b) => b.stageId === 'fetch')!;
    expect(JSON.stringify(bundle)).not.toContain('from attempt 1');
    expect(lateErrors).toHaveLength(1);
    expect(String((lateErrors[0] as Error).message)).toMatch(/attempt 1 has already ended/);
    expect(nodeOf(executor, 'fetch').lateWrites).toEqual([{ attempt: 1, key: 'late', channel: 'state' }]);
  });

  it('a late write AFTER the run failed is dropped and recorded; state stays as the stage left it', async () => {
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        scope.before = 'kept';
        await sleep(40);
        try {
          scope.after = 'never';
        } catch {
          /* refused */
        }
      },
      'fetch',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ timeoutMs: 10 })).rejects.toThrow(/timed out/);
    await sleep(60);
    const state = executor.getSnapshot().sharedState as S;
    expect(state.before).toBe('kept'); // commit-on-error: the attempt's writes before the cut land
    expect(state).not.toHaveProperty('after');
    expect(nodeOf(executor, 'fetch').lateWrites).toEqual([{ attempt: 1, key: 'after', channel: 'state' }]);
  });

  it('a late emit never reaches a recorder, and is recorded on the emit channel', async () => {
    const emitted: string[] = [];
    let calls = 0;
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        calls += 1;
        if (calls === 1) {
          await sleep(150);
          try {
            scope.$emit('progress.late', { secret: 'x' });
          } catch {
            /* refused */
          }
          return;
        }
        await sleep(90);
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 2, timeoutMs: 100 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder({ id: 'emits', onEmit: (e: EmitEvent) => emitted.push(e.name) });
    await executor.run();
    expect(emitted).toEqual([]);
    expect(nodeOf(executor, 'fetch').lateWrites).toEqual([{ attempt: 1, key: 'progress.late', channel: 'emit' }]);
  });

  it('a late read is refused: it cannot mark the next attempt’s commit with a source it never read', async () => {
    let calls = 0;
    const readErrors: unknown[] = [];
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        calls += 1;
        if (calls === 1) {
          await sleep(150);
          try {
            scope.$getArgs();
          } catch (error) {
            readErrors.push(error);
          }
          return;
        }
        await sleep(90);
        scope.value = 1;
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 2, timeoutMs: 100 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { secret: 'x' } });
    expect(readErrors).toHaveLength(1);
    const bundle = executor.getSnapshot().commitLog.find((b) => b.stageId === 'fetch')!;
    expect(bundle.untrackedSources).toBeUndefined();
  });

  it('the attempt signal aborts the abandoned attempt, so a function that listens stops on its own', async () => {
    let stoppedOnSignal = false;
    const chart = flowChart<S>(
      'Fetch',
      (scope: TypedScope<S>) => {
        const t: AttemptContext = scope.$attempt();
        return new Promise<void>((_resolve, reject) => {
          t.signal.addEventListener('abort', () => {
            stoppedOnSignal = true;
            reject(t.signal.reason);
          });
        });
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 1, timeoutMs: 10 })
      .build();
    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow(/ran out of its 10ms/);
    expect(stoppedOnSignal).toBe(true);
  });
});

describe('review fixes — every door of an ended attempt', () => {
  it('a late $debug / $metric never lands in the stage diagnostics; it is recorded as the emit it would have been', async () => {
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        await sleep(40);
        try {
          scope.$debug('lateKey', 'LATE');
        } catch {
          /* refused */
        }
        try {
          scope.$metric('lateMetric', 4242);
        } catch {
          /* refused */
        }
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 1, timeoutMs: 10 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow(/ran out/);
    await sleep(60);
    const fetch = nodeOf(executor, 'fetch');
    expect(JSON.stringify(fetch)).not.toContain('LATE');
    expect(JSON.stringify(fetch)).not.toContain('4242');
    expect(fetch.lateWrites).toEqual([
      { attempt: 1, key: 'log.debug.lateKey', channel: 'emit' },
      { attempt: 1, key: 'metric.lateMetric', channel: 'emit' },
    ]);
  });

  it('a $attempt() handle read after its attempt ended cannot mark the next attempt’s commit', async () => {
    let calls = 0;
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        calls += 1;
        const t = scope.$attempt();
        if (calls === 1) {
          await sleep(150);
          try {
            t.timeLeftMs();
          } catch {
            /* refused */
          }
          return;
        }
        await sleep(90);
        scope.value = 1;
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 2, timeoutMs: 100 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ deadline: Date.now() + 60_000 });
    const bundle = executor.getSnapshot().commitLog.find((b) => b.stageId === 'fetch')!;
    expect(bundle.untrackedSources).toBeUndefined();
  });

  it('late writes are bounded: an abandoned attempt that loops keeps the first 100', async () => {
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        await sleep(30);
        for (let i = 0; i < 150; i++) {
          try {
            scope[`k${i}`] = i;
          } catch {
            /* refused */
          }
        }
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 1, timeoutMs: 10 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run().catch(() => undefined);
    await sleep(60);
    expect(nodeOf(executor, 'fetch').lateWrites).toHaveLength(100);
  });
});
