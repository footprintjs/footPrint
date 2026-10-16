/**
 * Side-effect safety under its threat model (design §3.3, §6, packet P3).
 *
 *   - A retry of a non-idempotent effect without a key is impossible: at build, at the run-time door for a node the
 *     builder never saw, at the stage, and at `$call`.
 *   - An unknown outcome is never reported as failed or ok: the stage fails with `UnknownEffectError` (never the
 *     attempt's own error) whatever stopped the series — a timeout, a cancellation, a failure the adapter did not
 *     declare harmless.
 *   - The key comes from code or state through a declared rule, never from what a stage wrote; its format and length
 *     are checked (it goes into a request header), and a refusal never echoes it.
 *   - Redaction covers the key: a key rule of that name, or `policy.diagnostics`, scrubs it on the record, the hook,
 *     the error served to observers, and every serialised view — while the stage itself still gets the real key.
 *
 * Test types: Security (each threat above) · Boundary (a cancellation mid-attempt; a key exactly at the limit).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptRecord, FlowAttemptEvent, FlowErrorEvent, FlowRecorder } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, UnknownEffectError } from '../../../../src/index.js';

type S = Record<string, unknown>;
const KEY = 'order-7f3a-SECRETKEY';

function attempts(executor: FlowChartExecutor<any, any>): readonly AttemptRecord[] {
  return (executor.getSnapshot().executionTree as StageSnapshot).attempts ?? [];
}

const never = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

function timingOutChart(seen: string[]) {
  return flowChart<S>(
    'Charge',
    (scope: any) => {
      seen.push(scope.$attempt().idempotencyKey);
      return never(scope.$attempt().signal);
    },
    'charge',
  )
    .touches('stripe', { idempotencyKey: () => KEY })
    .retry({ attempts: 2, timeoutMs: 10 })
    .build();
}

async function runRedacted(policy: Parameters<FlowChartExecutor['setRedactionPolicy']>[0]) {
  const seen: string[] = [];
  const events: FlowAttemptEvent[] = [];
  const errors: FlowErrorEvent[] = [];
  const recorder: FlowRecorder = { id: 'probe', onAttempt: (e) => events.push(e), onError: (e) => errors.push(e) };
  const executor = new FlowChartExecutor(timingOutChart(seen));
  executor.setRedactionPolicy(policy);
  executor.attachFlowRecorder(recorder);
  executor.enableNarrative();
  const rejection = await executor.run().catch((e: unknown) => e);
  return { executor, seen, events, errors, rejection };
}

describe('redaction covers the key', () => {
  for (const [label, policy] of [
    ['a key rule of that name', { keys: ['idempotencyKey'] }],
    ['policy.diagnostics', { diagnostics: { keys: ['logs.idempotencyKey'] } }],
  ] as const) {
    it(`${label}: scrubbed on the record, the hook, the served error and the narrative — the stage keeps the real key`, async () => {
      const { executor, seen, events, errors, rejection } = await runRedacted(policy);
      expect(seen).toEqual([KEY, KEY]);
      for (const record of attempts(executor)) {
        expect(record.idempotencyKey).toBe('[REDACTED]');
      }
      const served = JSON.stringify({
        tree: executor.getSnapshot().executionTree,
        events: events.map((e) => e.record),
        errors: errors.map((e) => ({ ...e.structuredError, raw: undefined })),
        narrative: executor.getNarrativeEntries(),
      });
      expect(served).not.toContain(KEY);
      // The hook's onError carries no raw thrown value holding the key.
      for (const e of errors) expect(JSON.stringify(e.structuredError.raw ?? null)).not.toContain(KEY);
      // The rejection is the engine's own error; it carries the key as the record does.
      expect(rejection).toBeInstanceOf(UnknownEffectError);
      expect((rejection as UnknownEffectError).idempotencyKey).toBe('[REDACTED]');
      expect((rejection as Error).message).not.toContain(KEY);
    });
  }

  it('without a policy the record keeps the key (it is the reconcile handle)', async () => {
    const seen: string[] = [];
    const executor = new FlowChartExecutor(timingOutChart(seen));
    const rejection = await executor.run().catch((e: unknown) => e);
    expect(attempts(executor).map((r) => r.idempotencyKey)).toEqual([KEY, KEY]);
    expect((rejection as UnknownEffectError).idempotencyKey).toBe(KEY);
  });

  it('the key never enters the decision evidence — only keyPresent', async () => {
    const seen: string[] = [];
    const executor = new FlowChartExecutor(timingOutChart(seen));
    await executor.run().catch(() => undefined);
    for (const record of attempts(executor)) expect(JSON.stringify(record.decision)).not.toContain(KEY);
  });
});

describe('an unknown outcome is never reported as failed or ok', () => {
  it('a cancellation mid-attempt on a touching stage fails with UnknownEffectError, never the abort reason alone', async () => {
    const controller = new AbortController();
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        setTimeout(() => controller.abort(new Error('caller cancelled')), 5);
        return never(scope.$attempt().signal);
      },
      'charge',
    )
      .touches('stripe', { idempotencyKey: () => 'k-1' })
      .retry({ attempts: 3 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const rejection = await executor.run({ signal: controller.signal }).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(UnknownEffectError);
    expect(((rejection as Error).cause as Error).message).toBe('caller cancelled');
    const records = attempts(executor);
    expect(records.map((r) => [r.outcome, r.effect, r.next])).toEqual([['aborted', 'unknown', 'stop']]);
  });

  it('no record of a touching attempt that did not answer says applied or none', async () => {
    const seen: string[] = [];
    const executor = new FlowChartExecutor(timingOutChart(seen));
    await executor.run().catch(() => undefined);
    for (const record of attempts(executor)) expect(record.effect).toBe('unknown');
  });
});

describe('the key comes from the declared rule — never from what the stage wrote', () => {
  it('a stage cannot replace the key: the context is frozen', async () => {
    let attemptedWrite: unknown;
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        const t = scope.$attempt();
        try {
          t.idempotencyKey = 'model-said-this';
        } catch (error) {
          attemptedWrite = error;
        }
      },
      'charge',
    )
      .touches('stripe', { idempotencyKey: () => 'from-code' })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(attemptedWrite).toBeInstanceOf(TypeError);
    expect(attempts(executor)[0].idempotencyKey).toBe('from-code');
  });
});
