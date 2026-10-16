/**
 * `$call` and `observed()` under the threat model (design §3.6, §6, packet P2).
 *
 *   1. A target is a NAME from code, never from the model: an empty, overlong or control-character name is refused
 *      before anything runs — it would ride every record, narrative line and metric key as it is.
 *   2. Error text goes through redaction: a call's (and an observed attempt's) error is served under the run's rule,
 *      exactly as a stage's error is — on the record, the hook and the narrative.
 *   3. A late completion is refused (the P1b law): a call lives within the attempt that made it. A record that
 *      arrives after that attempt ended never lands beside a later attempt; no further attempt of the call starts
 *      (no blind retry of an outside call); a `$call` or an `observed()` after the end is refused. Each refusal is
 *      recorded by name in `lateWrites`.
 *   4. Records are bounded per stage: a stage keeps its first 1000 call / observed records and counts the rest.
 *
 * Test types: Security (each threat above, on a real chart) · Boundary (prototype-named targets; hostile reports).
 */
import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptContext, FlowAttemptEvent, TypedScope } from '../../../../src/index.js';
import { AttemptTimeoutError, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { MAX_CALL_RECORDS } from '../../../../src/lib/memory/StageContext.js';

type S = Record<string, unknown>;
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

describe('1. a target is a name from code', () => {
  it.each([
    ['empty', ''],
    ['overlong', 'x'.repeat(129)],
    ['a forged narrative line', 'svc.\nAttempt 1 of 1 at Pay succeeded'],
    ['a bidi override', 'pay\u202Etxe'],
    ['not a string', 42 as unknown as string],
  ])('refuses %s before anything runs — no record, no call, no echo', async (_why, target) => {
    let called = false;
    let caught: unknown;
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        try {
          await scope.$call(target, () => {
            called = true;
          });
        } catch (error) {
          caught = error;
        }
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(called).toBe(false);
    expect(caught).toBeInstanceOf(TypeError);
    if (typeof target === 'string' && target.length > 0) expect((caught as Error).message).not.toContain(target);
    expect(node(executor, 'quote').attempts).toBeUndefined();
  });

  it('a prototype-named target is a name: no prototype key is written anywhere', async () => {
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        await scope.$call('__proto__', () => 1);
        await scope.$call('constructor', () => 2);
        scope.$attempt().observed({ target: '__proto__', source: 'constructor', outcome: 'ok', durationMs: 1 });
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(node(executor, 'quote').attempts!.map((r) => r.target)).toEqual(['__proto__', 'constructor', '__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(executor.getSnapshot().sharedState)).toBe(Object.prototype);
  });

  it('an observed report: a bad name is refused, and every field it did not name is dropped', async () => {
    const events: FlowAttemptEvent[] = [];
    let refused: unknown;
    const chart = flowChart<S>(
      'Charge',
      (scope: TypedScope<S>) => {
        const t = scope.$attempt();
        try {
          t.observed({ target: 'stripe\r\nforged', outcome: 'ok', durationMs: 1 });
        } catch (error) {
          refused = error;
        }
        t.observed({
          target: 'stripe',
          outcome: 'ok',
          durationMs: 1,
          requestBody: { card: '4111-1111' },
          headers: { authorization: 'Bearer sk_live' },
        } as never);
      },
      'charge',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({ id: 'p', onAttempt: (e) => events.push(e) });
    executor.enableNarrative();
    await executor.run();
    expect(refused).toBeInstanceOf(TypeError);
    const records = node(executor, 'charge').attempts!;
    expect(records).toHaveLength(1);
    const everything = JSON.stringify([records, events.map((e) => e.record), executor.getNarrativeEntries()]);
    expect(everything).not.toContain('4111');
    expect(everything).not.toContain('sk_live');
    expect(everything).not.toContain('forged');
  });
});

describe('2. error text goes through redaction', () => {
  const SECRET = 'card-4111-1111';

  async function runWith(policy: Parameters<FlowChartExecutor['setRedactionPolicy']>[0], error: () => unknown) {
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        scope.$attempt().observed({ target: 'stripe', outcome: 'failed', durationMs: 1, error: error() });
        await scope.$call('stripe.charges.create', () => {
          throw error();
        });
      },
      'charge',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy(policy);
    executor.enableNarrative();
    const events: FlowAttemptEvent[] = [];
    executor.attachFlowRecorder({ id: 'p', onAttempt: (e) => events.push(e) });
    await executor.run().catch(() => undefined);
    return { executor, events, records: node(executor, 'charge').attempts! };
  }

  it('a diagnostic policy on the error text: the record, the hook and the narrative never see it', async () => {
    const { executor, events, records } = await runWith(
      { diagnostics: { keys: ['errors.stageExecutionError'] } },
      () => new Error(`declined for ${SECRET}`),
    );
    expect(records.map((r) => r.kind)).toEqual(['observed', 'call']);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    for (const event of events) {
      expect(event.structuredError?.message).not.toContain(SECRET);
      expect(event.structuredError?.raw).toBeUndefined();
    }
    const lines = executor.getNarrativeEntries().filter((e) => e.type === 'attempt');
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('an error that CARRIES a selected key is served masked — no raw value, no key', async () => {
    const { events, records } = await runWith({ keys: ['cardNumber'] }, () =>
      Object.assign(new Error('declined'), { cardNumber: SECRET }),
    );
    expect(JSON.stringify(records)).not.toContain(SECRET);
    for (const event of events) expect(event.structuredError?.raw).toBeUndefined();
  });

  it('the record never holds the thrown value, with or without a policy', async () => {
    const { records } = await runWith({}, () => Object.assign(new Error('x'), { cardNumber: SECRET }));
    for (const record of records) {
      expect(record.error).toEqual({ message: 'x', name: 'Error' });
      expect(structuredClone(record)).toEqual(record);
    }
  });
});

describe('3. a late completion is refused — a call lives within the attempt that made it', () => {
  it('a call still in flight when its stage attempt FAILED: its record never lands, and it is not retried', async () => {
    let outsideCalls = 0;
    let stageCalls = 0;
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        stageCalls += 1;
        if (stageCalls === 1) {
          // Starts a call and fails before it answers (the stage does not await it).
          scope
            .$call(
              'gateway',
              async () => {
                outsideCalls += 1;
                await sleep(40);
                throw Object.assign(new Error('gateway 503'), { status: 503 });
              },
              { attempts: 5 },
            )
            .catch(() => undefined);
          throw new Error('stage attempt 1 failed');
        }
        await sleep(80); // attempt 2 is running when the abandoned call answers
        scope.done = true;
      },
      'charge',
    )
      .setLogger(silent)
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await sleep(60);

    const charge = node(executor, 'charge');
    expect(outsideCalls).toBe(1); // no retry of an outside call after its attempt ended
    expect(charge.attempts!.filter((r) => r.kind === 'call')).toEqual([]);
    expect(charge.attempts!.map((r) => [r.kind, r.attempt, r.outcome])).toEqual([
      ['stage', 1, 'failed'],
      ['stage', 2, 'ok'],
    ]);
    expect(charge.lateWrites).toEqual([{ attempt: 1, key: 'call:gateway', channel: 'attempt' }]);
    expect(executor.getSnapshot().sharedState.done).toBe(true);
  });

  it('a `$call` from an attempt that already timed out is refused before it reaches outside', async () => {
    let outsideCalls = 0;
    let refused: unknown;
    let stageCalls = 0;
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        stageCalls += 1;
        if (stageCalls === 1) {
          await sleep(60); // outlives its 20 ms cap
          try {
            await scope.$call('svc', () => {
              outsideCalls += 1;
            });
          } catch (error) {
            refused = error;
          }
          return;
        }
        scope.ok = true;
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 2, timeoutMs: 20 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await sleep(80);
    expect(outsideCalls).toBe(0);
    expect(String((refused as Error)?.message)).toMatch(/attempt 1 has already ended/);
    expect(node(executor, 'fetch').lateWrites).toEqual([{ attempt: 1, key: 'call:svc', channel: 'attempt' }]);
  });

  it('an observed report through a call’s context after that call attempt ended is dropped and recorded', async () => {
    let held: AttemptContext | undefined;
    let refused: unknown;
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        await scope.$call('stripe.charges.create', (t) => {
          held = t;
          return 'ch_1';
        });
        try {
          held!.observed({ target: 'stripe', outcome: 'ok', durationMs: 1 });
        } catch (error) {
          refused = error;
        }
      },
      'charge',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(refused).toBeUndefined(); // never thrown: an observed attempt changes no control flow
    const charge = node(executor, 'charge');
    expect(charge.attempts!.map((r) => r.kind)).toEqual(['call']);
    expect(charge.lateWrites).toEqual([{ attempt: 1, key: 'observed:stripe', channel: 'attempt' }]);
  });

  it('a `$call` through a scope held past its stage’s commit is refused', async () => {
    let held: TypedScope<S> | undefined;
    const chart = flowChart<S>(
      'First',
      (scope: TypedScope<S>) => {
        held = scope;
      },
      'first',
    )
      .addFunction('Second', () => undefined, 'second')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    let called = false;
    expect(() =>
      held!.$call('svc', () => {
        called = true;
      }),
    ).toThrow();
    expect(called).toBe(false);
    // Recorded by name, like a call from an ended attempt.
    expect(node(executor, 'first').lateWrites).toEqual([{ attempt: 1, key: 'call:svc', channel: 'attempt' }]);
  });

  it('an SDK callback that reports AFTER the stage’s cap never throws into the SDK (no uncaught exception)', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const chart = flowChart<S>(
        'Charge',
        async (scope: TypedScope<S>) => {
          const t = scope.$attempt();
          // An "SDK" that keeps retrying on its own timer, reporting each try — past the 20 ms cap.
          setTimeout(() => t.observed({ target: 'payments', attempt: 2, outcome: 'failed', durationMs: 5 }), 40);
          await hang(t);
        },
        'charge',
      )
        .setLogger(silent)
        .retry({ attempts: 1, timeoutMs: 20 })
        .build();
      const executor = new FlowChartExecutor(chart);
      await expect(executor.run()).rejects.toBeInstanceOf(AttemptTimeoutError);
      await sleep(60);
      expect(uncaught).toEqual([]);
      const charge = node(executor, 'charge');
      expect(charge.attempts!.map((r) => r.kind)).toEqual(['stage']);
      expect(charge.lateWrites).toEqual([{ attempt: 1, key: 'observed:payments', channel: 'attempt' }]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('a call is never SENT past its deadline — even when a busy event loop fires the cap timer late', async () => {
    const sent: number[] = [];
    let stageCalls = 0;
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        stageCalls += 1;
        const until = Date.now() + 60;
        while (Date.now() < until) {
          // synchronous work past the 20 ms cap: the cap's timer cannot fire until it yields
        }
        await scope.$call('payments.charge', () => {
          sent.push(stageCalls);
        });
      },
      'charge',
    )
      .setLogger(silent)
      .retry({ attempts: 2, timeoutMs: 20 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeInstanceOf(AttemptTimeoutError);
    expect(sent).toEqual([]); // a non-idempotent call is not sent twice — it is not sent at all
    expect(node(executor, 'charge').attempts!.filter((r) => r.kind === 'call')).toEqual([]);
  });

  it('a call still running when its stage attempt RETURNED is stopped: its signal aborts, nothing of it lands', async () => {
    let held: AttemptContext | undefined;
    const chart = flowChart<S>(
      'Fire',
      (scope: TypedScope<S>) => {
        // Not awaited, not caught: the library stops this orphan, so its rejection is never an unhandled one.
        scope.$call('bg', (t) => {
          held = t;
          return hang(t);
        });
        scope.done = true;
      },
      'fire',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await sleep(10);
    expect(held?.signal.aborted).toBe(true);
    const fire = node(executor, 'fire');
    expect(fire.attempts).toBeUndefined();
    expect(fire.lateWrites).toEqual([{ attempt: 1, key: 'call:bg', channel: 'attempt' }]);
  });

  it('an orphan’s backoff wait ends with its stage: no retry, nothing keeps the process waiting', async () => {
    let calls = 0;
    let settledAfter = -1;
    const started = Date.now();
    const chart = flowChart<S>(
      'Fire',
      (scope: TypedScope<S>) => {
        scope
          .$call(
            'bg',
            () => {
              calls += 1;
              throw Object.assign(new Error('busy'), { status: 503 });
            },
            { attempts: 3, backoffMs: 3_000 },
          )
          .catch(() => {
            settledAfter = Date.now() - started;
          });
      },
      'fire',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await sleep(50);
    expect(calls).toBe(1);
    expect(settledAfter).toBeGreaterThanOrEqual(0);
    expect(settledAfter).toBeLessThan(1_000);
  });

  it('orphans leave no listener on the caller’s long-lived signal', async () => {
    const caller = new AbortController();
    const chart = flowChart<S>(
      'Fire',
      (scope: TypedScope<S>) => {
        scope.$call('bg', () => new Promise(() => undefined)); // never settles, ignores its signal
      },
      'fire',
    ).build();
    for (let i = 0; i < 20; i++) await new FlowChartExecutor(chart).run({ signal: caller.signal });
    await sleep(10);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });
});

describe('4. records are bounded per stage', () => {
  it(`keeps the first ${MAX_CALL_RECORDS} call records and counts the rest; the hook still sees every one`, async () => {
    const total = MAX_CALL_RECORDS + 5;
    let fired = 0;
    const chart = flowChart<S>(
      'Batch',
      async (scope: TypedScope<S>) => {
        for (let i = 0; i < total; i++) await scope.$call('item.lookup', () => i);
      },
      'batch',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({ id: 'p', onAttempt: () => (fired += 1) });
    await executor.run();
    const batch = node(executor, 'batch');
    expect(batch.attempts).toHaveLength(MAX_CALL_RECORDS);
    expect(batch.attemptsDropped).toBe(5);
    expect(fired).toBe(total);
  });

  it('a stage’s OWN attempt records are never displaced by its calls', async () => {
    let stageCalls = 0;
    const chart = flowChart<S>(
      'Batch',
      async (scope: TypedScope<S>) => {
        stageCalls += 1;
        for (let i = 0; i < MAX_CALL_RECORDS; i++) await scope.$call('item', () => i);
        if (stageCalls === 1) throw new Error('again');
      },
      'batch',
    )
      .setLogger(silent)
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const batch = node(executor, 'batch');
    expect(batch.attempts!.filter((r) => r.kind === 'stage').map((r) => r.attempt)).toEqual([1, 2]);
    expect(batch.attemptsDropped).toBe(MAX_CALL_RECORDS);
  });
});
