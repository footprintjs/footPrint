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
import { flowChart, FlowChartExecutor, interrupt, UnknownEffectError } from '../../../../src/index.js';

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

describe('redaction covers a key DERIVED from a selected value (review must-fix)', () => {
  it('a stage key built from a selected input key is served as the placeholder; the stage keeps the real key', async () => {
    const seen: string[] = [];
    const logged: string[] = [];
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        seen.push(scope.$attempt().idempotencyKey);
        return never(scope.$attempt().signal);
      },
      'charge',
    )
      .touches('stripe', { idempotencyKey: ({ args }) => `order-${(args as { orderId: string }).orderId}` })
      .retry({ attempts: 2, timeoutMs: 10 })
      .build();
    const events: FlowAttemptEvent[] = [];
    const errors: FlowErrorEvent[] = [];
    const executor = new FlowChartExecutor(chart, {
      logger: {
        info: () => undefined,
        log: () => undefined,
        debug: () => undefined,
        warn: (...a: unknown[]) => logged.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? { ...v } : v))),
        error: (...a: unknown[]) => logged.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? { ...v } : v))),
      },
    } as never);
    executor.setRedactionPolicy({ keys: ['orderId'] });
    executor.attachFlowRecorder({ id: 'p', onAttempt: (e) => events.push(e), onError: (e) => errors.push(e) });
    const rejection = await executor.run({ input: { orderId: 'SECRET-ORDER-99' } }).catch((e: unknown) => e);
    expect(seen).toEqual(['order-SECRET-ORDER-99', 'order-SECRET-ORDER-99']);
    const served = JSON.stringify({
      tree: executor.getSnapshot().executionTree,
      events: events.map((e) => e.record),
      errors: errors.map((e) => ({ ...e.structuredError, raw: undefined })),
      key: (rejection as UnknownEffectError).idempotencyKey,
      logged,
    });
    expect(served).not.toContain('SECRET-ORDER-99');
    for (const e of errors) expect(JSON.stringify(e.structuredError.raw ?? null)).not.toContain('SECRET-ORDER-99');
    expect((rejection as UnknownEffectError).idempotencyKey).toBe('[REDACTED]');
  });

  it('a $call key built after the stage read a selected state value is served as the placeholder', async () => {
    const chart = flowChart<S>(
      'Seed',
      (scope: any) => {
        scope.orderId = 'SECRET-STATE-7';
      },
      'seed',
    )
      .addFunction(
        'Pay',
        async (scope: any) => {
          const key = `order-${scope.orderId}`;
          await scope
            .$call('stripe.charges.create', () => 'ch_1', undefined, { touches: 'stripe', idempotencyKey: key })
            .catch(() => undefined);
        },
        'pay',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['orderId'] });
    await executor.run();
    const tree = JSON.stringify(executor.getSnapshot().executionTree);
    expect(tree).not.toContain('SECRET-STATE-7');
    expect(tree).toContain('"idempotencyKey":"[REDACTED]"');
  });

  it('a rule that selects nothing the key is made of leaves the key as it is', async () => {
    const chart = flowChart<S>('Charge', () => undefined, 'charge')
      .touches('stripe', { idempotencyKey: ({ args }) => `order-${(args as { orderId: string }).orderId}` })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['password'] });
    await executor.run({ input: { orderId: '5' } });
    expect(attempts(executor)[0].idempotencyKey).toBe('order-5');
  });
});

describe('a keyless touching stage is never re-run by a resume (review must-fix)', () => {
  it('its interrupt() fails the stage: nothing pauses, the effect is unknown', async () => {
    let charges = 0;
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        charges += 1;
        interrupt(scope, { approve: true });
      },
      'charge',
    )
      .touches('stripe')
      .build();
    const executor = new FlowChartExecutor(chart);
    const rejection = await executor.run().catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(UnknownEffectError);
    expect(((rejection as Error).cause as Error).message).toMatch(/touches "stripe" with no idempotencyKey/);
    expect(executor.getCheckpoint?.()).toBeFalsy();
    expect(charges).toBe(1);
  });

  it('with a key it pauses and resumes as before, under the same key', async () => {
    const keys: string[] = [];
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        keys.push(scope.$attempt().idempotencyKey);
        const answer = interrupt(scope, { approve: true });
        scope.answer = answer;
      },
      'charge',
    )
      .touches('stripe', { idempotencyKey: ({ args }) => `order-${(args as { orderId: string }).orderId}` })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { orderId: '3' } });
    const checkpoint = executor.getCheckpoint();
    expect(checkpoint).toBeTruthy();
    await executor.resume(checkpoint!, 'yes');
    expect(keys).toEqual(['order-3', 'order-3']);
  });

  it('a checkpoint of a keyless touching stage is refused at resume', async () => {
    const make = (touching: boolean) => {
      const builder = flowChart<S>(
        'Charge',
        (scope: any) => {
          interrupt(scope, { approve: true });
        },
        'charge',
      );
      return (touching ? builder.touches('stripe') : builder).build();
    };
    const first = new FlowChartExecutor(make(false));
    await first.run();
    const checkpoint = first.getCheckpoint()!;
    const second = new FlowChartExecutor(make(true));
    await expect(second.resume(checkpoint, 'yes')).rejects.toThrow(
      /Cannot resume: .*touches "stripe" with no idempotencyKey/,
    );
  });
});

describe('the key crosses a resume — never recomputed from an input that did not (review must-fix)', () => {
  it('a paused touching stage resumes under the key its checkpoint carries, across executors', async () => {
    const keys: string[] = [];
    let ruleCalls = 0;
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        keys.push(scope.$attempt().idempotencyKey);
        scope.answer = interrupt(scope, { approve: true });
      },
      'charge',
    )
      .touches('stripe', {
        idempotencyKey: ({ args }) => {
          ruleCalls += 1;
          return `order-${(args as { orderId: string }).orderId}`;
        },
      })
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run({ input: { orderId: '41' } });
    const stored = JSON.parse(JSON.stringify(first.getCheckpoint()));
    expect(stored.idempotencyKey).toBe('order-41');
    const second = new FlowChartExecutor(chart);
    await second.resume(stored, 'yes');
    expect(keys).toEqual(['order-41', 'order-41']);
    expect(ruleCalls).toBe(1);
  });

  it('a checkpoint carrying a malformed key is refused at resume', async () => {
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        interrupt(scope, 1);
      },
      'charge',
    )
      .touches('stripe', { idempotencyKey: () => 'k-1' })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const forged = { ...executor.getCheckpoint()!, idempotencyKey: 'k\r\nX-Evil: 1' };
    await expect(new FlowChartExecutor(chart).resume(forged, 'y')).rejects.toThrow(
      /Invalid checkpoint: idempotencyKey/,
    );
  });

  it('a later touching stage whose rule reads args on a resumed leg fails before sending; getState works', async () => {
    let sent = 0;
    const build = (fromState: boolean) =>
      flowChart<S>(
        'Ask',
        (scope: any) => {
          scope.savedOrder = 'from-state-9';
          interrupt(scope, 1);
        },
        'ask',
      )
        .addFunction(
          'Charge',
          (scope: any) => {
            sent += 1;
            scope.key = scope.$attempt().idempotencyKey;
          },
          'charge',
        )
        .touches('stripe', {
          idempotencyKey: fromState
            ? ({ getState }) => `order-${String(getState('savedOrder'))}`
            : ({ args }) => `order-${(args as { orderId?: string }).orderId}`,
        })
        .build();

    const viaArgs = new FlowChartExecutor(build(false));
    await viaArgs.run({ input: { orderId: '1' } });
    await expect(viaArgs.resume(viaArgs.getCheckpoint()!, 'y')).rejects.toThrow(/does not cross a resume/);
    expect(sent).toBe(0);

    const viaState = new FlowChartExecutor(build(true));
    await viaState.run({ input: { orderId: '1' } });
    await viaState.resume(viaState.getCheckpoint()!, 'y');
    expect(sent).toBe(1);
    expect(viaState.getSnapshot().sharedState.key).toBe('order-from-state-9');
  });

  it('a key a rule built from a selected state value is served as the placeholder', async () => {
    const chart = flowChart<S>(
      'Seed',
      (scope: any) => {
        scope.orderId = 'SECRET-S-1';
      },
      'seed',
    )
      .addFunction('Charge', () => undefined, 'charge')
      .touches('stripe', { idempotencyKey: ({ getState }) => `order-${String(getState('orderId'))}` })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['orderId'] });
    await executor.run();
    const tree = JSON.stringify(executor.getSnapshot().executionTree);
    expect(tree).not.toContain('SECRET-S-1');
  });

  it('parallel siblings that paused together each resume under their own key', async () => {
    const seen: string[] = [];
    const child = (id: string) => ({
      id,
      name: id,
      fn: (scope: any) => {
        seen.push(`${id}:${scope.$attempt().idempotencyKey}`);
        interrupt(scope, { id });
      },
      touches: { system: 'stripe', idempotencyKey: () => `key-${id}-${seen.length}` },
    });
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addListOfFunction([child('c1'), child('c2')])
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const firstCp = executor.getCheckpoint()!;
    const keysAtPause = [firstCp.idempotencyKey, ...(firstCp.pendingPauses ?? []).map((p) => p.idempotencyKey)];
    await executor.resume(firstCp, 'a');
    const secondCp = executor.getCheckpoint()!;
    expect(secondCp.idempotencyKey).toBe(keysAtPause[1]);
    await executor.resume(secondCp, 'b');
    const resumedKeys = seen.slice(2).map((s) => s.split(':')[1]);
    expect(resumedKeys).toEqual(keysAtPause);
  });
});

describe('the checkpoint key is operational only (coordinator review: resume.ts)', () => {
  const SECRET_KEY = 'order-CARRIED-SECRET-55';

  function pausingChart(rule = true) {
    const builder = flowChart<S>(
      'Charge',
      (scope: any) => {
        scope.answer = interrupt(scope, { approve: true });
      },
      'charge',
    );
    return (rule ? builder.touches('stripe', { idempotencyKey: () => SECRET_KEY }) : builder.touches('stripe')).build();
  }

  async function pausedCheckpoint() {
    const executor = new FlowChartExecutor(pausingChart());
    await executor.run();
    return JSON.parse(JSON.stringify(executor.getCheckpoint()));
  }

  it('refusal text names the field, never the key: malformed key, and a key for a stage with no key rule', async () => {
    const stored = await pausedCheckpoint();
    const malformed = { ...stored, idempotencyKey: `${SECRET_KEY} has space` };
    const first = await new FlowChartExecutor(pausingChart()).resume(malformed, 'y').catch((e: unknown) => e);
    expect((first as Error).message).toMatch(/idempotencyKey/);
    expect((first as Error).message).not.toContain(SECRET_KEY);

    const keyless = flowChart<S>('Charge', { execute: () => ({ ask: 1 }), resume: () => undefined }, 'charge')
      .touches('stripe')
      .build();
    const pauser = new FlowChartExecutor(keyless);
    await pauser.run();
    const forged = { ...JSON.parse(JSON.stringify(pauser.getCheckpoint())), idempotencyKey: SECRET_KEY };
    const second = await new FlowChartExecutor(keyless).resume(forged, 'y').catch((e: unknown) => e);
    expect((second as Error).message).toMatch(
      /carries an idempotencyKey, but stage 'Charge'.*declares no idempotency key rule/,
    );
    expect((second as Error).message).not.toContain(SECRET_KEY);
  });

  it('under any state rule the resumed records carry the placeholder; the stage gets the real key', async () => {
    const stored = await pausedCheckpoint();
    const seen: string[] = [];
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        seen.push(scope.$attempt().idempotencyKey);
        scope.answer = interrupt(scope, { approve: true });
      },
      'charge',
    )
      .touches('stripe', { idempotencyKey: () => 'never-asked-on-resume' })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['password'] });
    const events: FlowAttemptEvent[] = [];
    executor.attachFlowRecorder({ id: 'p', onAttempt: (e) => events.push(e) });
    executor.enableNarrative();
    await executor.resume(stored, 'y');
    expect(seen).toEqual([SECRET_KEY]);
    const served = JSON.stringify({
      tree: executor.getSnapshot().executionTree,
      events: events.map((e) => e.record),
      narrative: executor.getNarrativeEntries(),
    });
    expect(served).not.toContain(SECRET_KEY);
    expect(attempts(executor)[0].idempotencyKey).toBe('[REDACTED]');
  });

  it('never echoed into the resume event, the narrative or diagnostics', async () => {
    const stored = await pausedCheckpoint();
    const resumeEvents: unknown[] = [];
    const executor = new FlowChartExecutor(pausingChart());
    executor.attachFlowRecorder({ id: 'p', onResume: (e) => resumeEvents.push(e) });
    executor.enableNarrative();
    await executor.resume(stored, 'y');
    const snapshot = executor.getSnapshot();
    const echoed = JSON.stringify({
      resumeEvents,
      narrative: executor.getNarrativeEntries(),
      diagnostics: (snapshot.executionTree as StageSnapshot).logs,
      errors: (snapshot.executionTree as StageSnapshot).errors,
      state: snapshot.sharedState,
      commitLog: snapshot.commitLog,
    });
    expect(echoed).not.toContain(SECRET_KEY);
  });
});
