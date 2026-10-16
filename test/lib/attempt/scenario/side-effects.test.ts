/**
 * Side-effect safety on a real chart (design §3.3, packet P3): a stage that `.touches()` an outside system.
 *
 * The law, end to end: the idempotency key is computed ONCE per execution (not per attempt), from the declared
 * rule, before attempt 1, and handed to every attempt through `scope.$attempt()`; every attempt record says what
 * it did to the system (`effect`); a stage whose LAST attempt left the effect unknown — it timed out, was cut, or
 * failed without the adapter saying nothing was sent — fails with `UnknownEffectError`, so the caller reconciles
 * instead of retrying blindly. The same law holds for a `$call` that declares `touches`.
 *
 * Test types: Functional (the key per execution; `effect` on each outcome; a lone touching stage; a loop) · Scenario
 * (a timeout on a touching stage → `UnknownEffectError` through `run()` and `onError`; recovery; the adapter's
 * `effect: 'none'`; the narrative) · Boundary (a key rule that throws or returns a bad key; a dynamic StageNode
 * and a hand-edited chart are held to the build law at run time).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptRecord, FlowAttemptEvent, FlowErrorEvent, FlowRecorder } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, UnknownEffectError } from '../../../../src/index.js';

type S = Record<string, unknown>;

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

function attemptsOf(executor: FlowChartExecutor<any, any>, id: string): readonly AttemptRecord[] {
  const found = nodes(executor.getSnapshot().executionTree as StageSnapshot).find((n) => n.id === id);
  return found?.attempts ?? [];
}

const has = (value: unknown, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const never = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

describe('the key — once per execution, from the declared rule', () => {
  it('is computed once before attempt 1 and handed to every attempt; the rule sees args, runId and runtimeStageId', async () => {
    const contexts: unknown[] = [];
    const seen: unknown[] = [];
    let calls = 0;
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction(
        'Charge',
        (scope: any) => {
          seen.push(scope.$attempt().idempotencyKey);
          if (++calls < 3) throw new Error('gateway 502');
          scope.charged = true;
        },
        'charge',
      )
      .touches('stripe', {
        idempotencyKey: (ctx) => {
          contexts.push(ctx);
          return `order-${(ctx.args as { orderId: string }).orderId}`;
        },
      })
      .retry({ attempts: 3 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { orderId: '77' } });

    expect(contexts).toHaveLength(1);
    const ctx = contexts[0] as { args: unknown; runId: string; runtimeStageId: string };
    expect(ctx.args).toEqual({ orderId: '77' });
    expect(Object.isFrozen(ctx.args)).toBe(true);
    expect(typeof ctx.runId).toBe('string');
    expect(ctx.runtimeStageId).toBe('charge#1');
    expect(seen).toEqual(['order-77', 'order-77', 'order-77']);
    const records = attemptsOf(executor, 'charge');
    expect(records.map((r) => [r.system, r.idempotencyKey, r.effect])).toEqual([
      ['stripe', 'order-77', 'unknown'],
      ['stripe', 'order-77', 'unknown'],
      ['stripe', 'order-77', 'applied'],
    ]);
  });

  it('a loop executes the stage again: one key per execution', async () => {
    const keys: string[] = [];
    let pass = 0;
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Charge', () => undefined, 'charge')
      .touches('stripe', {
        idempotencyKey: ({ runtimeStageId }) => {
          keys.push(runtimeStageId);
          return `k-${runtimeStageId.replace('#', '-')}`;
        },
      })
      .retry({ attempts: 2 })
      .addDeciderFunction('Check', () => (++pass < 2 ? 'again' : 'done'), 'check')
      .addFunctionBranch('again', 'Again', () => undefined, undefined, { loopTo: 'charge' })
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();
    await new FlowChartExecutor(chart).run();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('a rule that throws fails the stage with its error, before any attempt', async () => {
    let ran = 0;
    const chart = flowChart<S>(
      'Charge',
      () => {
        ran += 1;
      },
      'charge',
      {
        touches: {
          system: 'stripe',
          idempotencyKey: () => {
            throw new Error('no order id');
          },
        },
        retry: { attempts: 2 },
      },
    ).build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('no order id');
    expect(ran).toBe(0);
    expect(attemptsOf(executor, 'charge')).toHaveLength(0);
  });

  it('a rule that returns a bad key fails the stage with a TypeError that never echoes the key', async () => {
    const chart = flowChart<S>('Charge', () => undefined, 'charge', {
      touches: { system: 'stripe', idempotencyKey: () => 'SECRET\r\nX-Evil: 1' },
      retry: { attempts: 2 },
    }).build();
    const error = await new FlowChartExecutor(chart).run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/idempotencyKey/);
    expect((error as Error).message).not.toContain('SECRET');
  });
});

describe('effect — what each attempt did, and the unknown stop', () => {
  it('a timed-out attempt on a touching stage is effect unknown; the stage fails with UnknownEffectError', async () => {
    const errors: FlowErrorEvent[] = [];
    const events: FlowAttemptEvent[] = [];
    const recorder: FlowRecorder = {
      id: 'probe',
      onError: (e) => errors.push(e),
      onAttempt: (e) => events.push(e),
    };
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Charge', (scope: any) => never(scope.$attempt().signal), 'charge')
      .touches('stripe', { idempotencyKey: () => 'order-9' })
      .retry({ attempts: 2, timeoutMs: 15 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    executor.enableNarrative();
    const error = await executor.run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnknownEffectError);
    expect((error as UnknownEffectError).system).toBe('stripe');
    expect((error as UnknownEffectError).idempotencyKey).toBe('order-9');
    expect((error as UnknownEffectError).attempts).toBe(2);
    expect((error as Error).cause).toMatchObject({ name: 'AttemptTimeoutError' });

    const records = attemptsOf(executor, 'charge');
    expect(records.map((r) => [r.outcome, r.effect, r.next])).toEqual([
      ['timeout', 'unknown', 'retry'],
      ['timeout', 'unknown', 'stop'],
    ]);
    expect(events.map((e) => e.record.effect)).toEqual(['unknown', 'unknown']);
    expect(errors).toHaveLength(1);
    expect(errors[0].structuredError.name).toBe('UnknownEffectError');
    const lines = executor
      .getNarrativeEntries()
      .filter((e) => e.type === 'attempt')
      .map((e) => e.text);
    expect(lines[1]).toMatch(/timed out after \d+ms, effect on stripe unknown; stopped: no attempts left\./);
  });

  it("the adapter's effect: 'none' keeps the stage's own error", async () => {
    const declined = Object.assign(new Error('card declined'), { effect: 'none' });
    const chart = flowChart<S>(
      'Charge',
      () => {
        throw declined;
      },
      'charge',
      { touches: { system: 'stripe', idempotencyKey: () => 'k' }, retry: { attempts: 2, retryOn: () => false } },
    ).build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBe(declined);
    expect(attemptsOf(executor, 'charge').map((r) => r.effect)).toEqual(['none']);
  });

  it('a touching stage with no policy still runs on the runner: one record, effect applied, not narrated', async () => {
    const chart = flowChart<S>(
      'Charge',
      (scope: any) => {
        scope.done = true;
      },
      'charge',
    )
      .touches('stripe')
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();
    const records = attemptsOf(executor, 'charge');
    expect(records.map((r) => [r.of, r.outcome, r.effect, r.system])).toEqual([[1, 'ok', 'applied', 'stripe']]);
    expect(has(records[0], 'idempotencyKey')).toBe(false);
    expect(executor.getNarrativeEntries().filter((e) => e.type === 'attempt')).toHaveLength(0);
  });

  it('a lone touching stage that throws fails with UnknownEffectError (it may have sent the request)', async () => {
    const boom = new Error('socket hang up');
    const chart = flowChart<S>(
      'Charge',
      () => {
        throw boom;
      },
      'charge',
    )
      .touches('stripe')
      .build();
    const error = await new FlowChartExecutor(chart).run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownEffectError);
    expect((error as Error).cause).toBe(boom);
    expect(has(error as object, 'idempotencyKey')).toBe(false);
  });

  it('a chart without touches records no effect fields (byte identity)', async () => {
    let calls = 0;
    const chart = flowChart<S>(
      'Work',
      () => {
        if (++calls < 2) throw new Error('x');
      },
      'work',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    for (const record of attemptsOf(executor, 'work')) {
      expect(Object.keys(record)).not.toEqual(expect.arrayContaining(['effect']));
      expect(has(record, 'system') || has(record, 'idempotencyKey')).toBe(false);
    }
  });
});

describe('the run-time door — a node the builder never saw', () => {
  it('a dynamic StageNode that touches and retries without a key is refused before it runs', async () => {
    let ran = 0;
    const chart = flowChart<S>(
      'Init',
      () => ({
        name: 'Dyn',
        id: 'dyn-parent',
        next: {
          name: 'Charge',
          id: 'dyn-charge',
          fn: () => {
            ran += 1;
          },
          touches: { system: 'stripe' },
          retry: { attempts: 3 },
        },
      }),
      'init',
    ).build();
    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow(
      /dynamic StageNode: stage 'dyn-charge': .*touches "stripe".*idempotencyKey/s,
    );
    expect(ran).toBe(0);
  });

  it('a built chart edited by hand is refused at the stage', async () => {
    let ran = 0;
    const chart = flowChart<S>(
      'Charge',
      () => {
        ran += 1;
      },
      'charge',
    ).build();
    chart.root.touches = { system: 'stripe' };
    chart.root.retry = { attempts: 3 };
    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow(/touches "stripe".*idempotencyKey/s);
    expect(ran).toBe(0);
  });
});

describe('$call that declares touches — the same law inside a stage', () => {
  it('refuses a retried touching call with no key, synchronously, before anything is sent', async () => {
    let sent = 0;
    let thrown: unknown;
    const chart = flowChart<S>(
      'Pay',
      (scope: any) => {
        try {
          scope.$call(
            'stripe.charges.create',
            () => {
              sent += 1;
            },
            { attempts: 3 },
            { touches: 'stripe' },
          );
        } catch (error) {
          thrown = error;
        }
      },
      'pay',
    ).build();
    await new FlowChartExecutor(chart).run();
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toMatch(/touches "stripe".*idempotencyKey/s);
    expect(sent).toBe(0);
  });

  it('a key without a system, or a bad key, is refused', async () => {
    const thrown: unknown[] = [];
    const chart = flowChart<S>(
      'Pay',
      (scope: any) => {
        for (const options of [{ idempotencyKey: 'k' }, { touches: 'stripe', idempotencyKey: 'has space' }]) {
          try {
            scope.$call('stripe.charges.create', () => 1, undefined, options);
          } catch (error) {
            thrown.push(error);
          }
        }
      },
      'pay',
    ).build();
    await new FlowChartExecutor(chart).run();
    expect(thrown).toHaveLength(2);
    for (const error of thrown) expect(error).toBeInstanceOf(TypeError);
    expect((thrown[1] as Error).message).not.toContain('has space');
  });

  it('records effect on each call attempt; the call context carries the key; unknown last → UnknownEffectError', async () => {
    const keys: unknown[] = [];
    let caught: unknown;
    const chart = flowChart<S>(
      'Pay',
      async (scope: any) => {
        const key = `order-${scope.$getArgs().orderId}`;
        try {
          await scope.$call(
            'stripe.charges.create',
            (t: any) => {
              keys.push(t.idempotencyKey);
              return never(t.signal);
            },
            { attempts: 2, timeoutMs: 10 },
            { touches: 'stripe', idempotencyKey: key },
          );
        } catch (error) {
          caught = error;
        }
      },
      'pay',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: { orderId: '5' } });
    expect(keys).toEqual(['order-5', 'order-5']);
    expect(caught).toBeInstanceOf(UnknownEffectError);
    expect((caught as UnknownEffectError).system).toBe('stripe');
    const records = attemptsOf(executor, 'pay');
    expect(records.map((r) => [r.kind, r.outcome, r.effect, r.idempotencyKey])).toEqual([
      ['call', 'timeout', 'unknown', 'order-5'],
      ['call', 'timeout', 'unknown', 'order-5'],
    ]);
  });

  it('a call without touches records no effect (P2 byte identity)', async () => {
    const chart = flowChart<S>(
      'Pay',
      async (scope: any) => {
        await scope.$call('inventory.lookup', () => 1);
      },
      'pay',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const [record] = attemptsOf(executor, 'pay');
    expect(has(record, 'effect') || has(record, 'system')).toBe(false);
  });
});
