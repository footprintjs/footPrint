/** P3b boundary/security: no blind resend, no secret error state, isolated resume and declared bounds. */
import type { RecordEntry } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { FlowAttemptEvent, RetryLoopOptions, RetryLoopState } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, timeBudget, UnknownEffectError } from '../../../src/index.js';

type S = { charge?: RetryLoopState<string>; orderId?: string };
const options = (): RetryLoopOptions<unknown, string> => ({
  touches: 'mock-payments',
  idempotencyKey: () => 'synthetic-key',
  retry: { attempts: 3, timeoutMs: 50 },
  attempt: () => 'ok',
  reconcile: () => 'none',
});
const setup = (patch: Partial<RetryLoopOptions<unknown, string>> = {}) =>
  flowChart<S>('Seed', () => undefined, 'seed')
    .addRetryLoop('charge', { ...options(), ...patch })
    .build();
const never = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

describe('explicit loop boundaries', () => {
  it('public typed configuration works without an untyped builder', async () => {
    const chart = flowChart<S>(
      'Seed',
      (scope) => {
        scope.orderId = 'order-1';
      },
      'seed',
    )
      .addRetryLoop('charge', {
        ...options(),
        attempt: (scope, context) => `${scope.orderId}:${context.retryLoop.attempt}`,
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.charge).toMatchObject({ value: 'order-1:1' });
  });
  it('one built chart has independent run keys, pass counts and call namespaces', async () => {
    let keys = 0;
    const calls = new Map<string, number>();
    const chart = setup({
      idempotencyKey: () => `key-${++keys}`,
      attempt: (_scope, context) => {
        const key = context.idempotencyKey!;
        const n = (calls.get(key) ?? 0) + 1;
        calls.set(key, n);
        if (n === 1) throw new Error('lost answer');
        return key;
      },
    });
    const first = new FlowChartExecutor(chart);
    const second = new FlowChartExecutor(chart);
    await Promise.all([first.run(), second.run()]);
    expect(keys).toBe(2);
    expect([...calls.values()]).toEqual([2, 2]);
    expect(first.getSnapshot().sharedState.charge).toMatchObject({ attempt: 2, value: 'key-1' });
    expect(second.getSnapshot().sharedState.charge).toMatchObject({ attempt: 2, value: 'key-2' });
  });
  it.each(['unknown', 'invalid', 'throw'] as const)('reconciliation %s stops without another send', async (kind) => {
    let sends = 0;
    const executor = new FlowChartExecutor(
      setup({
        attempt: () => {
          sends++;
          throw new Error('unknown');
        },
        reconcile: () => {
          if (kind === 'throw') throw new Error('read failed');
          return kind as 'unknown';
        },
      }),
    );
    await expect(executor.run()).rejects.toBeInstanceOf(UnknownEffectError);
    expect(sends).toBe(1);
    expect(executor.getSnapshot().sharedState.charge).toMatchObject({
      reconciled: true,
      effect: 'unknown',
      terminal: true,
    });
  });
  it('times out the physical attempt, then records logical done when provider confirms applied', async () => {
    const events: FlowAttemptEvent[] = [];
    let sends = 0;
    const executor = new FlowChartExecutor(
      setup({
        attempt: (_scope, context) => {
          sends++;
          return never(context.signal);
        },
        reconcile: () => 'applied',
        retry: { attempts: 3, timeoutMs: 5 },
      }),
    );
    executor.attachFlowRecorder({ id: 'capture', onAttempt: (e) => events.push(e) });
    await executor.run();
    expect(sends).toBe(1);
    expect(events.find((e) => e.record.retryLoop?.phase === 'attempt')?.record).toMatchObject({
      outcome: 'timeout',
      effect: 'unknown',
      attempt: 1,
      of: 1,
    });
    expect(executor.getSnapshot().sharedState.charge).toMatchObject({
      effect: 'applied',
      decision: { retryLoop: { next: 'done' } },
    });
  });
  it.each(['reconcile', 'wait'] as const)('caller abort during %s never sends again', async (where) => {
    let sends = 0;
    const controller = new AbortController();
    const executor = new FlowChartExecutor(
      setup({
        attempt: () => {
          sends++;
          throw new Error('lost');
        },
        reconcile: async (_scope, context) => {
          if (where === 'reconcile') {
            controller.abort(new Error('cancel'));
            await never(context.signal);
          }
          return 'none';
        },
        retry: { attempts: 3, timeoutMs: 100, backoffMs: where === 'wait' ? 200 : 0 },
      }),
    );
    if (where === 'wait') setTimeout(() => controller.abort(new Error('cancel')), 10);
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow();
    expect(sends).toBe(1);
  });
  it('pause and fresh-executor resume keep the operational key, with no raw thrown error in state', async () => {
    const raw = Object.assign(new Error('served failure'), { cause: { hidden: 'raw-payload' } });
    let keys = 0;
    let sends = 0;
    const chart = setup({
      wait: 'pause',
      idempotencyKey: () => `key-${++keys}`,
      attempt: () => {
        if (++sends === 1) throw raw;
        return 'ok';
      },
    });
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = first.getCheckpoint()!;
    expect(checkpoint).toBeTruthy();
    expect(JSON.stringify(checkpoint)).not.toContain('raw-payload');
    const resumed = new FlowChartExecutor(chart);
    await resumed.resume(structuredClone(checkpoint), undefined);
    expect(keys).toBe(1);
    expect(sends).toBe(2);
    expect(resumed.getSnapshot().sharedState.charge).toMatchObject({ value: 'ok', attempt: 2 });
  });
  it('selected input taints operational key and error in all served helper state and attempt records', async () => {
    const secret = 'SELECTED-SYNTHETIC-TOKEN';
    const seen: unknown[] = [];
    const events: FlowAttemptEvent[] = [];
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addRetryLoop('charge', {
        ...options(),
        idempotencyKey: (context) => (context.args as { orderId: string }).orderId,
        attempt: (_scope, context) => {
          seen.push(context.idempotencyKey);
          throw new Error(secret, { cause: { orderId: secret } });
        },
        reconcile: () => 'unknown',
      })
      .build();
    const entries: RecordEntry[] = [];
    const errors: unknown[] = [];
    const executor = new FlowChartExecutor(chart, {
      sink: {
        adapter: {
          opened: (e) => {
            entries.push(e);
          },
          commit: (e) => {
            entries.push(e);
          },
          note: (e) => {
            entries.push(e);
          },
          closed: (e) => {
            entries.push(e);
          },
        },
      },
    });
    executor.setRedactionPolicy({ keys: ['orderId'], diagnostics: { keys: ['errors.stageExecutionError'] } });
    executor.attachFlowRecorder({
      id: 'capture',
      onAttempt: (e) => events.push(e),
      onRunFailed: (e) => errors.push(e.structuredError),
    });
    await executor.run({ input: { orderId: secret } }).catch(() => undefined);
    expect(seen).toEqual([secret]);
    expect(JSON.stringify(executor.getSnapshot({ redact: true }))).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(errors)).not.toContain(secret);
    const state = executor.getSnapshot().sharedState.charge as RetryLoopState;
    expect(state.error).not.toHaveProperty('raw');
    expect(state.error).not.toHaveProperty('cause');
  });
  it('counts total passes and both callback caps without asking a backoff function at build', () => {
    let asks = 0;
    const chart = flowChart('Seed', () => undefined, 'seed')
      .retry({ attempts: 1, timeoutMs: 1 })
      .addRetryLoop('charge', {
        ...options(),
        retry: {
          attempts: 4,
          timeoutMs: 40,
          backoffMs: () => {
            asks++;
            return 2;
          },
          maxBackoffMs: 10,
        },
      })
      .build();
    const report = timeBudget(chart);
    expect(asks).toBe(0);
    expect(report.worstCaseMs).toBe(361);
    expect(timeBudget(chart, { assume: { loops: { charge: 1 } } }).worstCaseMs).toBe(361);
  });
  it('nested mounts preserve runtime namespaces and declared budget metadata', async () => {
    const child = flowChart('Seed', () => undefined, 'seed')
      .retry({ attempts: 1, timeoutMs: 1 })
      .addRetryLoop('charge', options())
      .build();
    const chart = flowChart('Root', () => undefined, 'root')
      .retry({ attempts: 1, timeoutMs: 1 })
      .addSubFlowChartNext('nested', child, 'Nested')
      .build();
    const events: FlowAttemptEvent[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({ id: 'capture', onAttempt: (e) => events.push(e) });
    await executor.run();
    expect(events.find((e) => e.record.retryLoop)?.record.retryLoop?.series).toMatch(/^nested\/charge#/);
    expect(timeBudget(chart).worstCaseMs).toBe(302);
  });
});

it.each([1, 2, 3, 4, 5])(
  'the total-pass ceiling %i is enforced rather than reconstructed from events',
  async (attempts) => {
    let sends = 0;
    let reads = 0;
    const executor = new FlowChartExecutor(
      setup({
        onStop: 'continue',
        retry: { attempts, timeoutMs: 50 },
        attempt: () => {
          sends++;
          throw new Error('uncertain');
        },
        reconcile: (_scope, context) => {
          expect(context.idempotencyKey).toBe('synthetic-key');
          reads++;
          return 'none';
        },
      }),
    );
    await executor.run();
    expect(sends).toBe(attempts);
    expect(reads).toBe(attempts);
    expect(executor.getSnapshot().sharedState.charge).toMatchObject({
      attempt: attempts,
      terminal: true,
      decision: { retryLoop: { next: 'stop', reason: 'exhausted' } },
    });
  },
);
it('a throwing retry predicate is a recorded decline and never a second send', async () => {
  let sends = 0;
  const executor = new FlowChartExecutor(
    setup({
      onStop: 'continue',
      retry: {
        attempts: 3,
        timeoutMs: 50,
        retryOn: () => {
          throw new Error('rule failed');
        },
      },
      attempt: () => {
        sends++;
        throw new Error('uncertain');
      },
    }),
  );
  await executor.run();
  expect(sends).toBe(1);
  expect(executor.getSnapshot().sharedState.charge).toMatchObject({
    retryOnThrew: true,
    decision: { retryLoop: { next: 'stop', reason: 'declined' } },
  });
});

it.each([{ attempt: 99 }, { series: 'wrong#1' }, { error: { message: 'x', raw: { secret: 'not-an-error-record' } } }])(
  'refuses malformed restored helper state before a provider call',
  async (patch) => {
    let sends = 0;
    const state = {
      id: 'charge',
      series: 'charge#1',
      attempt: 1,
      of: 3,
      idempotencyKey: 'saved-key',
      effect: 'none',
      reconciled: false,
      delayMs: 0,
      retryOn: true,
      terminal: false,
      ...patch,
    };
    const chart = flowChart(
      'Seed',
      (scope) => {
        scope.$setValue('charge', state);
      },
      'seed',
    )
      .addRetryLoop('charge', {
        ...options(),
        attempt: () => {
          sends++;
          return 'ok';
        },
      })
      .build();
    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow(/addRetryLoop: invalid restored/);
    expect(sends).toBe(0);
  },
);
