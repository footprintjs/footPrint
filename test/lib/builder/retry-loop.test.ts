/** P3b: explicit retries use normal chart nodes, stable operation keys and recorded reconciliation decisions. */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, UnknownEffectError } from '../../../src/index.js';

type State = Record<string, any>;
const build = (options: any) =>
  (flowChart<State>('Seed', () => undefined, 'seed') as any).addRetryLoop('charge', options);
const defaults = () => ({
  touches: 'mock-payments',
  idempotencyKey: () => 'synthetic-order-1',
  retry: { attempts: 3, timeoutMs: 100, backoffMs: 0 },
  attempt: () => 'receipt',
  reconcile: () => 'none',
});

describe('explicit retry-loop workflow', () => {
  it('retries only after reconciliation says none, keeps its key, then returns the value', async () => {
    const keys: string[] = [];
    let reconciled = 0;
    const chart = build({
      ...defaults(),
      attempt: (_scope: State, context: any) => {
        keys.push(context.idempotencyKey);
        if (keys.length === 1) throw new Error('synthetic response absent');
        return 'receipt-1';
      },
      reconcile: () => {
        reconciled += 1;
        return 'none';
      },
    }).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(keys).toEqual(['synthetic-order-1', 'synthetic-order-1']);
    expect(reconciled).toBe(1);
    expect(executor.getSnapshot().sharedState.charge).toMatchObject({
      attempt: 2,
      value: 'receipt-1',
      effect: 'applied',
    });
  });

  it('a provider-confirmed applied result finishes without sending again and records the logical decision', async () => {
    let sends = 0;
    const evidence: any[] = [];
    const chart = build({
      ...defaults(),
      attempt: () => {
        sends += 1;
        throw new Error('no answer');
      },
      reconcile: () => 'applied',
    }).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({ id: 'decisions', onDecision: (event) => evidence.push(event.evidence) });
    await executor.run();
    expect(sends).toBe(1);
    expect(evidence).toContainEqual(
      expect.objectContaining({
        chosen: 'done',
        retryLoop: expect.objectContaining({ id: 'charge', attempt: 1, effect: 'applied', reconciled: true }),
      }),
    );
  });

  it('stops with unknown effect when reconciliation still cannot establish the outcome', async () => {
    let sends = 0;
    const chart = build({
      ...defaults(),
      attempt: () => {
        sends += 1;
        throw new Error('no answer');
      },
      reconcile: () => 'unknown',
    }).build();
    await expect(new FlowChartExecutor(chart).run()).rejects.toBeInstanceOf(UnknownEffectError);
    expect(sends).toBe(1);
  });

  it('records logical pass metadata without rewriting the native call identity', async () => {
    let sends = 0;
    const records: any[] = [];
    const chart = build({
      ...defaults(),
      attempt: () => {
        if (++sends < 2) throw Object.assign(new Error('not sent'), { effect: 'none' });
        return 'ok';
      },
    }).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({
      id: 'calls',
      onAttempt: (event) => {
        if (event.record.kind === 'call') records.push(event.record);
      },
    });
    await executor.run();
    const physical = records.filter((record) => record.retryLoop?.phase === 'attempt');
    expect(physical).toHaveLength(2);
    expect(physical.map((record) => [record.attempt, record.of])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(physical.map((record) => record.retryLoop.attempt)).toEqual([1, 2]);
    expect(physical[0].series).not.toBe(physical[1].series);
    expect(physical[0].retryLoop.series).toBe(physical[1].retryLoop.series);
  });

  it.each([
    ['key rule', { idempotencyKey: undefined }],
    ['reconciliation', { reconcile: undefined }],
    ['attempt count', { retry: { attempts: 0 } }],
    ['state key', { into: '__proto__' }],
  ])('refuses an invalid %s before the chart can run', (_name, patch) => {
    expect(() => build({ ...defaults(), ...patch })).toThrow(/addRetryLoop: invalid/);
  });
});
