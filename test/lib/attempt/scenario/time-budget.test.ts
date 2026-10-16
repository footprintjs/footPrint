/**
 * The time budget on a real chart (design §3.1, P1b): `run({ deadline })` / `timeoutMs` → `env.deadline`,
 * `env.signal` honoured, `RetryPolicy.timeoutMs`, `scope.$attempt()` and `timeLeftMs()`.
 *
 * WHY: the incident behind this design — "one stage, one error" in the record, when the truth was four attempts of
 * 40 s each past a 120 s budget. A lone call that times out must leave evidence: a stage with a `timeoutMs`, or any
 * stage of a run with a deadline, records its attempt even with no retry policy (`attempts: 1`). A stage with no
 * policy and no deadline records nothing, as before.
 *
 * Test types: Functional (`$attempt()` on every scope shape; `timeLeftMs()` marking `'env'`) · Scenario (a lone
 * timeout with and without a policy; a deadline across a 2-deep subflow; `env.signal` cancelling; resume with a
 * fresh deadline) · Boundary (a deadline already past: no attempt; a sync stage cannot be cut) · Byte identity (no
 * deadline, no policy → no attempts, no `'env'` mark, no narrative line).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptContext, TypedScope } from '../../../../src/index.js';
import { AttemptTimeoutError, flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const hang = (t: AttemptContext) =>
  new Promise<never>((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason)));

function nodes(root: StageSnapshot | undefined): StageSnapshot[] {
  const out: StageSnapshot[] = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    if (n.next) stack.push(n.next);
    for (const child of n.children ?? []) stack.push(child);
  }
  return out;
}
const node = (executor: FlowChartExecutor<any, any>, id: string) =>
  nodes(executor.getSnapshot().executionTree as StageSnapshot).find((n) => n.id === id)!;

describe('a lone call that times out leaves evidence', () => {
  it('RetryPolicy { attempts: 1, timeoutMs }: one timeout record, the run rejects with AttemptTimeoutError', async () => {
    const chart = flowChart<S>('Fetch', (scope: TypedScope<S>) => hang(scope.$attempt()), 'fetch')
      .setLogger(silent)
      .retry({ attempts: 1, timeoutMs: 20 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeInstanceOf(AttemptTimeoutError);
    const fetch = node(executor, 'fetch');
    expect(fetch.attempts).toHaveLength(1);
    expect(fetch.attempts![0]).toMatchObject({
      attempt: 1,
      of: 1,
      outcome: 'timeout',
      category: 'timeout',
      timeoutMs: 20,
    });
    expect(fetch.attemptSummary).toMatchObject({ count: 1, timeout: 1, last: { next: 'stop', reason: 'exhausted' } });
  });

  it('NO policy, a run deadline: the stage still records its one attempt, timed out', async () => {
    const chart = flowChart<S>('Fetch', (scope: TypedScope<S>) => hang(scope.$attempt()), 'fetch')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ timeoutMs: 20 })).rejects.toThrow('Execution timed out after 20ms');
    const fetch = node(executor, 'fetch');
    expect(fetch.attempts).toHaveLength(1);
    expect(fetch.attempts![0]).toMatchObject({ attempt: 1, of: 1, outcome: 'timeout', category: 'timeout' });
    expect(fetch.attempts![0].timeLeftMs).toBeLessThanOrEqual(0);
  });

  it('every stage of a run with a deadline records one attempt; the narrative tells only the one that says something', async () => {
    const chart = flowChart<S>(
      'Read',
      (scope: TypedScope<S>) => {
        scope.read = 1;
      },
      'read',
    )
      .addFunction('Fetch', (scope: TypedScope<S>) => hang(scope.$attempt()), 'fetch')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run({ deadline: Date.now() + 30 }).catch(() => undefined);
    expect(node(executor, 'read').attempts).toEqual([
      expect.objectContaining({ attempt: 1, of: 1, outcome: 'ok', next: 'done', reason: 'succeeded' }),
    ]);
    expect(node(executor, 'fetch').attempts?.[0]?.outcome).toBe('timeout');
    const lines = executor
      .getNarrativeEntries()
      .filter((e) => e.type === 'attempt')
      .map((e) => e.text);
    expect(lines).toHaveLength(1);
    // Rule 4 (no attempts left) comes before rule 6 (no time left): a lone attempt is exhausted.
    expect(lines[0]).toMatch(/^Attempt 1 of 1 at Fetch timed out after \d+m?s; stopped: no attempts left\.$/);
  });
});

describe('no policy and no deadline — byte-identical', () => {
  it('no attempts on the tree, no narrative attempt line, and a signal-only run keeps an empty env', async () => {
    let env: unknown;
    const chart = flowChart<S>(
      'Only',
      (scope: TypedScope<S>) => {
        env = scope.$getEnv();
        scope.v = 1;
      },
      'only',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run({ signal: new AbortController().signal });
    expect(node(executor, 'only').attempts).toBeUndefined();
    expect(env).toEqual({});
    expect(executor.getSnapshot().commitLog[0].untrackedSources).toBeUndefined();
    expect(executor.getNarrativeEntries().some((e) => e.type === 'attempt')).toBe(false);
  });

  it('$attempt() still answers: attempt 1 of 1, Infinity left, and no env mark', async () => {
    let seen: { attempt: number; of: number; left: number; aborted: boolean } | undefined;
    const chart = flowChart<S>(
      'Only',
      (scope: TypedScope<S>) => {
        const t = scope.$attempt();
        seen = { attempt: t.attempt, of: t.of, left: t.timeLeftMs(), aborted: t.signal.aborted };
        scope.v = 1;
      },
      'only',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(seen).toEqual({ attempt: 1, of: 1, left: Infinity, aborted: false });
    expect(executor.getSnapshot().commitLog[0].untrackedSources).toBeUndefined();
  });

  it('$attempt().signal is the run signal when a run has one but no deadline', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const chart = flowChart<S>(
      'Only',
      (scope: TypedScope<S>) => {
        signal = scope.$attempt().signal;
      },
      'only',
    ).build();
    await new FlowChartExecutor(chart).run({ signal: controller.signal });
    expect(signal).toBe(controller.signal);
  });
});

describe('env.deadline, timeLeftMs() and the untracked env read', () => {
  it('run({ deadline }) stamps env.deadline; timeLeftMs() reads it and marks the commit untracked: env', async () => {
    const deadline = Date.now() + 60_000;
    let seen: { envDeadline?: number; left: number } | undefined;
    const chart = flowChart<S>(
      'Plan',
      (scope: TypedScope<S>) => {
        const left = scope.$attempt().timeLeftMs();
        seen = { left, envDeadline: undefined };
        scope.left = left > 0;
      },
      'plan',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ deadline });
    expect(seen!.left).toBeGreaterThan(0);
    expect(seen!.left).toBeLessThanOrEqual(60_000);
    expect(executor.getSnapshot().commitLog[0].untrackedSources).toEqual(['env']);

    let envDeadline: number | undefined;
    const reader = flowChart<S>(
      'Read env',
      (scope: TypedScope<S>) => {
        envDeadline = scope.$getEnv().deadline;
      },
      'read-env',
    ).build();
    await new FlowChartExecutor(reader).run({ deadline });
    expect(envDeadline).toBe(deadline);
  });

  it('the deadline crosses a 2-deep subflow: the inner stage sees the same env.deadline', async () => {
    const deadline = Date.now() + 60_000;
    let inner: number | undefined;
    const leaf = flowChart<S>(
      'Leaf',
      (scope: TypedScope<S>) => {
        inner = scope.$getEnv().deadline;
      },
      'leaf',
    ).build();
    const middle = flowChart<S>('Mid', () => undefined, 'mid')
      .addSubFlowChartNext('sf-leaf', leaf, 'Leaf')
      .build();
    const outer = flowChart<S>('Top', () => undefined, 'top')
      .addSubFlowChartNext('sf-mid', middle, 'Mid')
      .build();
    const executor = new FlowChartExecutor(outer);
    await executor.run({ deadline });
    expect(inner).toBe(deadline);
  });

  it('a deadline already past: the run stops before its first stage — no attempt is made', async () => {
    let ran = false;
    const chart = flowChart<S>(
      'Never',
      () => {
        ran = true;
      },
      'never',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ deadline: Date.now() - 1 })).rejects.toThrow(/deadline/);
    expect(ran).toBe(false);
  });

  it('a retried stage under a deadline stops with no-time-left instead of waiting past it', async () => {
    let calls = 0;
    const chart = flowChart<S>(
      'Charge',
      () => {
        calls += 1;
        throw new Error('busy');
      },
      'charge',
    )
      .setLogger(silent)
      .retry({ attempts: 5, backoffMs: 5_000 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const started = Date.now();
    await expect(executor.run({ timeoutMs: 1_000 })).rejects.toThrow('busy');
    expect(Date.now() - started).toBeLessThan(900);
    expect(calls).toBe(1);
    expect(node(executor, 'charge').attempts![0]).toMatchObject({
      next: 'stop',
      reason: 'no-time-left',
      delayMs: 5_000,
    });
  });
});

describe('env.signal is honoured', () => {
  it('aborting env.signal cancels an async stage mid-flight (it used to be readable only)', async () => {
    const controller = new AbortController();
    const chart = flowChart<S>('Wait', () => new Promise((resolve) => setTimeout(resolve, 5_000)), 'wait')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    setTimeout(() => controller.abort(new Error('cancelled from env')), 10);
    const started = Date.now();
    await expect(executor.run({ env: { signal: controller.signal } })).rejects.toThrow('cancelled from env');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('resume takes a fresh deadline', () => {
  it('the resumed leg runs under its own deadline: env.deadline is the one passed to resume()', async () => {
    let seen: number | undefined;
    const chart = flowChart<S>('Start', () => undefined, 'start')
      .addPausableFunction('Approve', { execute: () => ({ ask: 'ok?' }), resume: () => undefined }, 'approve')
      .addFunction(
        'After',
        (scope: TypedScope<S>) => {
          seen = scope.$getEnv().deadline;
        },
        'after',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ deadline: Date.now() + 60_000 });
    expect(executor.isPaused()).toBe(true);
    const fresh = Date.now() + 120_000;
    await executor.resume(executor.getCheckpoint()!, { yes: true }, { deadline: fresh });
    expect(seen).toBe(fresh);
  });
});
