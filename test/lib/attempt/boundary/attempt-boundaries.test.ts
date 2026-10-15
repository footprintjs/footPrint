/**
 * The attempt record at its edges, on real charts (design §10, Boundary).
 *
 * Test types: Boundary (values a stage may throw that are not Errors, including ones whose reads throw; a
 * category and a decision that disagree; a broken backoff and a broken predicate; an abort mid-wait; a deep
 * ceiling) · Security of the hook (a recorder that throws, or that tries to edit the record it was handed, can
 * neither break the run nor change the record the tree keeps).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptRecord } from '../../../../src/index.js';
import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

function nodeOf(executor: FlowChartExecutor<any, any>, id: string): StageSnapshot {
  let node: StageSnapshot | undefined = executor.getSnapshot().executionTree as StageSnapshot;
  while (node && node.id !== id) node = node.next;
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function throwing(values: readonly unknown[]) {
  let calls = 0;
  return () => {
    const value = values[calls];
    calls += 1;
    if (calls <= values.length) throw value;
  };
}

describe('what a stage may throw', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('trap');
      },
      getPrototypeOf() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
    },
  );

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'plain text'],
    ['a number', 42],
    ['a null-prototype object', Object.assign(Object.create(null), { reason: 'x' })],
    ['a hostile Proxy', hostile],
  ])('%s: recorded, categorised unknown, served, clone-safe', async (_label, thrown) => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Odd', throwing([thrown]), 'odd')
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const [first] = nodeOf(executor, 'odd').attempts!;
    expect(first).toMatchObject({ outcome: 'failed', category: 'unknown', next: 'retry' });
    expect(typeof first.error?.message).toBe('string');
    expect(structuredClone(first)).toEqual(first);
  });
});

describe('the category is what it looked like; the decision is what the policy said', () => {
  it('429 with retryable: false, declined by its own predicate: rate-limited AND declined', async () => {
    const error = Object.assign(new Error('slow down'), { status: 429, retryable: false });
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Call', throwing([error]), 'call')
      .retry({ attempts: 3, retryOn: (e) => (e as { retryable?: boolean }).retryable !== false })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBe(error);
    const [record] = nodeOf(executor, 'call').attempts!;
    expect([record.category, record.next, record.reason]).toEqual(['rate-limited', 'stop', 'declined']);
  });
});

describe('broken dials', () => {
  it('a throwing backoff is no wait — recorded as delayMs 0, and the retry happens', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', throwing([new Error('once')]), 'flaky')
      .retry({
        attempts: 2,
        backoffMs: () => {
          throw new Error('bad dial');
        },
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(nodeOf(executor, 'flaky').attempts!.map((r) => [r.next, r.delayMs])).toEqual([
      ['retry', 0],
      ['done', undefined],
    ]);
  });

  it('a throwing retryOn is "declined", and the logger is told once — the served form of what it threw', async () => {
    const warn = vi.fn();
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', throwing([new Error('original')]), 'flaky')
      .retry({
        attempts: 5,
        retryOn: () => {
          throw new Error('predicate is broken');
        },
      })
      .setLogger({ info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('original');
    expect(nodeOf(executor, 'flaky').attempts!.map((r) => r.reason)).toEqual(['declined']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('retryOn predicate threw');
  });
});

describe('an abort while the series waits', () => {
  it('ends the series with no phantom attempt; the summary records the abort; the run rejects with the failure', async () => {
    const controller = new AbortController();
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', throwing([new Error('first try failed'), new Error('never reached')]), 'flaky')
      .retry({ attempts: 5, backoffMs: 10_000 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({ id: 'cancel', onStageRetry: () => setTimeout(() => controller.abort(), 5) });
    const started = Date.now();
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow('first try failed');
    expect(Date.now() - started).toBeLessThan(2_000);
    const flaky = nodeOf(executor, 'flaky');
    expect(flaky.attempts!.map((r) => r.next)).toEqual(['retry']);
    expect(flaky.attemptSummary).toMatchObject({ count: 1, failed: 1, last: { next: 'stop', reason: 'aborted' } });
  });
});

describe('a deep ceiling', () => {
  it('50 attempts: 50 records, each decision bounded by the six rules', async () => {
    const failures = Array.from({ length: 49 }, (_, i) => new Error(`still flaky ${i + 1}`));
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Very flaky', throwing(failures), 'very-flaky')
      .retry({ attempts: 50 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const records = nodeOf(executor, 'very-flaky').attempts!;
    expect(records).toHaveLength(50);
    expect(records.every((r) => r.decision.rules.length <= 6)).toBe(true);
    expect(records[49]).toMatchObject({ outcome: 'ok', next: 'done' });
  });
});

describe('recorders cannot break the series or edit its record', () => {
  it('a throwing onAttempt recorder is isolated (a dev-mode warning) — the run and the tree are whole', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', throwing([new Error('once')]), 'flaky')
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({
      id: 'bad',
      onAttempt: () => {
        throw new Error('recorder is broken');
      },
    });
    await executor.run();
    expect(nodeOf(executor, 'flaky').attempts).toHaveLength(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('threw in onAttempt'))).toBe(true);
  });

  it('a recorder that writes to the record it was handed changes nothing the tree keeps', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', throwing([new Error('once')]), 'flaky')
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const edits: unknown[] = [];
    executor.attachFlowRecorder({
      id: 'editor',
      onAttempt: (e) => {
        try {
          (e.record as { reason: string }).reason = 'edited';
        } catch (error) {
          edits.push(error);
        }
        try {
          (e.record.decision.rules as unknown[]).push({});
        } catch (error) {
          edits.push(error);
        }
      },
    });
    await executor.run();
    const records = nodeOf(executor, 'flaky').attempts as AttemptRecord[];
    expect(records.map((r) => r.reason)).toEqual(['retryable', 'succeeded']);
    expect(edits).toHaveLength(4);
    expect(records[0].decision.rules).toHaveLength(6);
  });
});

describe('an abort around the decision keeps the 9.15 order, on a real chart', () => {
  /** A stage that writes, then fails — every time. */
  const writesThenFails = (scope: S) => {
    scope.partial = 'from the failed try';
    throw new Error('first try failed');
  };

  it('(a) an abort inside backoffMs comes after the discard: the failed try’s writes never land, the retry event fires', async () => {
    const controller = new AbortController();
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', writesThenFails, 'flaky')
      .retry({
        attempts: 3,
        backoffMs: () => {
          controller.abort();
          return 10_000;
        },
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    const retried: number[] = [];
    executor.attachFlowRecorder({ id: 'retries', onStageRetry: (e) => retried.push(e.attempt) });
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow('first try failed');
    expect(retried).toEqual([1]);
    expect(executor.getSnapshot().sharedState).not.toHaveProperty('partial');
    expect(nodeOf(executor, 'flaky').attemptSummary).toMatchObject({
      count: 1,
      last: { next: 'stop', reason: 'aborted' },
    });
  });

  it('(b) an abort inside retryOn stops before the discard: backoffMs is never asked, and the failed try’s writes land', async () => {
    const controller = new AbortController();
    const backoffMs = vi.fn(() => 10_000);
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', writesThenFails, 'flaky')
      .retry({
        attempts: 3,
        backoffMs,
        retryOn: () => {
          controller.abort();
          return true;
        },
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    const retried: number[] = [];
    executor.attachFlowRecorder({ id: 'retries', onStageRetry: (e) => retried.push(e.attempt) });
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow('first try failed');
    expect(backoffMs).not.toHaveBeenCalled();
    expect(retried).toEqual([]);
    // Nothing discarded it, so the error path committed it — a failing stage's writes land (M1).
    expect(executor.getSnapshot().sharedState.partial).toBe('from the failed try');
    expect(nodeOf(executor, 'flaky').attempts!.map((r) => [r.outcome, r.next, r.reason])).toEqual([
      ['failed', 'stop', 'aborted'],
    ]);
  });
});

describe('a StageNode returned at run time is held to the builder’s retry rule', () => {
  const returning = (retry: unknown) =>
    flowChart<S>(
      'Init',
      () => ({
        name: 'Dyn',
        id: 'dyn-parent',
        next: {
          name: 'DynN',
          id: 'dyn-x',
          fn: (s: S) => {
            s.dyn = 1;
          },
          retry,
        },
      }),
      'init',
    ).build();

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['0', 0],
    ['a fraction', 2.5],
    ['a string', '3'],
  ])('refuses attempts = %s on the stage’s error path, in the builder’s words', async (_label, attempts) => {
    const errors: string[] = [];
    const executor = new FlowChartExecutor(returning({ attempts }));
    executor.attachFlowRecorder({
      id: 'errors',
      onError: (e) => {
        errors.push(e.message);
      },
    });
    await expect(executor.run()).rejects.toThrow(
      `[footprint] dynamic StageNode: stage 'dyn-x': retry.attempts must be a whole number >= 1 (got ${String(
        attempts,
      )}).`,
    );
    expect(errors).toHaveLength(1);
    // Nothing adopted ran.
    expect(executor.getSnapshot().commitLog.map((b) => b.runtimeStageId)).toEqual(['init#0']);
  });

  it('the same policy is refused at build — one rule, two doors', () => {
    expect(() =>
      flowChart<S>('Init', () => undefined, 'init')
        .addFunction('X', () => undefined, 'x')
        .retry({ attempts: Infinity }),
    ).toThrow("retry() at 'X': retry.attempts must be a whole number >= 1 (got Infinity).");
  });

  it('admits a valid policy on a returned node, and the node retries under it', async () => {
    let calls = 0;
    const chart = flowChart<S>(
      'Init',
      () => ({
        name: 'Dyn',
        id: 'dyn-parent',
        next: {
          name: 'DynN',
          id: 'dyn-x',
          fn: (s: S) => {
            calls += 1;
            if (calls === 1) throw new Error('once');
            s.dyn = calls;
          },
          retry: { attempts: 2 },
        },
      }),
      'init',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(calls).toBe(2);
    expect(executor.getSnapshot().sharedState.dyn).toBe(2);
  });
});
