/**
 * `scope.$call(target, fn, policy?)` and `observed()` on real charts (design §3.6, §3.8, packet P2).
 *
 * WHY: the incident behind this design — the record said "one stage, one error"; the truth was four attempts of
 * 40 s each inside an SDK. A call made INSIDE a stage must leave its own evidence: every call is an
 * `AttemptRecord` of kind `'call'` under the stage that made it — even a single call with no retry (`attempts: 1`,
 * the owner's requirement: the app team needs single-call evidence). It runs under its stage attempt's time and
 * signal (P1b), on the same runner, category and decision (P1a), and its event carries the run's correlation (P4).
 * An SDK that retries on its own is reported through `observed()` — the same record, kind `'observed'`.
 *
 * Test types: Functional (`$call` on every stage kind; `observed()` through `$attempt()` and through a call's
 * context) · Scenario (a single call; retries; two calls; calls inside a retried stage; a run deadline; a call cut
 * by its stage's cap; correlation on the event; the narrative) · Byte identity (the commit log never carries a
 * call; a stage that makes none is unchanged).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptContext, FlowAttemptEvent, TypedScope } from '../../../../src/index.js';
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

function probe() {
  const events: FlowAttemptEvent[] = [];
  return { id: 'attempt-probe', events, onAttempt: (e: FlowAttemptEvent) => events.push(e) };
}

/** A local "service": fails `fails` times with a 503, then answers. */
function service(fails: number) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: () => {
      calls += 1;
      if (calls <= fails) throw Object.assign(new Error(`busy ${calls}`), { status: 503 });
      return { price: 9 };
    },
  };
}

describe('a single call leaves evidence', () => {
  it('`attempts: 1` (no policy): ONE record of kind call under the stage — a stage with no policy of its own', async () => {
    const quotes = service(0);
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        scope.quote = await scope.$call('stripe.quotes.create', () => quotes.call());
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    const p = probe();
    executor.attachFlowRecorder(p);
    await executor.run();

    const quote = node(executor, 'quote');
    expect(quote.attempts).toHaveLength(1);
    expect(quote.attempts![0]).toMatchObject({
      series: `${quote.runtimeStageId}@1.1`,
      kind: 'call',
      target: 'stripe.quotes.create',
      attempt: 1,
      of: 1,
      outcome: 'ok',
      next: 'done',
      reason: 'succeeded',
    });
    expect(typeof quote.attempts![0].durationMs).toBe('number');
    // The stage itself ran outside the runner: no series of its own, no summary.
    expect(quote.attemptSummary).toBeUndefined();
    // The hook fired once, for the call, with the stage's own traversal context.
    expect(p.events).toHaveLength(1);
    expect(p.events[0].stageId).toBe('quote');
    expect(p.events[0].traversalContext?.runtimeStageId).toBe(quote.runtimeStageId);
    expect(p.events[0].record).toBe(quote.attempts![0]);
  });

  it('the commit log never carries a call (Q1): the bundle of a stage that called equals one that did not', async () => {
    const build = (withCall: boolean) =>
      flowChart<S>(
        'Quote',
        async (scope: TypedScope<S>) => {
          scope.quote = withCall ? await scope.$call('svc', () => 9) : 9;
        },
        'quote',
      ).build();
    const a = new FlowChartExecutor(build(true));
    const b = new FlowChartExecutor(build(false));
    await a.run();
    await b.run();
    const strip = (log: readonly object[]) => JSON.stringify(log.map((bundle) => ({ ...bundle, runId: 'x' })));
    expect(strip(a.getSnapshot().commitLog)).toBe(strip(b.getSnapshot().commitLog));
    expect(JSON.stringify(a.getSnapshot().commitLog)).not.toContain('svc');
  });
});

describe('retries inside a stage', () => {
  it('a call that retries: every attempt recorded, in order, under ONE series', async () => {
    const svc = service(2);
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        scope.quote = await scope.$call('svc', () => svc.call(), { attempts: 3 });
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const records = node(executor, 'quote').attempts!;
    expect(records.map((r) => [r.series, r.attempt, r.outcome, r.category, r.next])).toEqual([
      [records[0].series, 1, 'failed', 'server', 'retry'],
      [records[0].series, 2, 'failed', 'server', 'retry'],
      [records[0].series, 3, 'ok', undefined, 'done'],
    ]);
    expect(svc.calls).toBe(3);
  });

  it('two calls in one stage are two series (ordinals 1 and 2), each counting from 1', async () => {
    const chart = flowChart<S>(
      'Two',
      async (scope: TypedScope<S>) => {
        await scope.$call('first', () => 1);
        await scope.$call('second', () => 2);
      },
      'two',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const two = node(executor, 'two');
    expect(two.attempts!.map((r) => [r.series, r.target, r.attempt])).toEqual([
      [`${two.runtimeStageId}@1.1`, 'first', 1],
      [`${two.runtimeStageId}@1.2`, 'second', 1],
    ]);
  });

  it('calls inside a RETRIED stage: each stage attempt’s calls are kept (a discard keeps evidence), in order', async () => {
    let stageCalls = 0;
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        stageCalls += 1;
        await scope.$call('lookup', () => 'card');
        if (stageCalls === 1) throw new Error('stage failed after its call');
        scope.done = true;
      },
      'charge',
    )
      .setLogger(silent)
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const charge = node(executor, 'charge');
    const id = charge.runtimeStageId;
    expect(charge.attempts!.map((r) => [r.kind, r.series, r.attempt, r.outcome])).toEqual([
      ['call', `${id}@1.1`, 1, 'ok'],
      ['stage', id, 1, 'failed'],
      ['call', `${id}@2.1`, 1, 'ok'],
      ['stage', id, 2, 'ok'],
    ]);
    // The stage's summary is the STAGE series' — calls are their own series.
    expect(charge.attemptSummary).toMatchObject({ count: 2, ok: 1, failed: 1, last: { next: 'done' } });
  });
});

describe('time: the call runs under its stage attempt', () => {
  it('a run deadline caps the call; a wait that would outlast it is not started (no-time-left)', async () => {
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        await scope.$call(
          'svc',
          () => {
            throw Object.assign(new Error('rate limited'), { status: 429 });
          },
          { attempts: 5, backoffMs: 5_000 },
        );
      },
      'quote',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    const started = Date.now();
    await expect(executor.run({ timeoutMs: 1_000 })).rejects.toThrow('rate limited');
    expect(Date.now() - started).toBeLessThan(900);
    const records = node(executor, 'quote').attempts!.filter((r) => r.kind === 'call');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'rate-limited',
      next: 'stop',
      reason: 'no-time-left',
      delayMs: 5_000,
    });
    expect(records[0].timeLeftMs).toBeLessThanOrEqual(1_000);
    expect(records[0].timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it('a call cut by its STAGE’s cap is recorded timed out — before the stage’s own record', async () => {
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        await scope.$call('slow.service', hang, { attempts: 3 });
      },
      'fetch',
    )
      .setLogger(silent)
      .retry({ attempts: 1, timeoutMs: 30 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeInstanceOf(AttemptTimeoutError);
    const records = node(executor, 'fetch').attempts!;
    expect(records.map((r) => [r.kind, r.outcome, r.category, r.next])).toEqual([
      ['call', 'timeout', 'timeout', 'stop'],
      ['stage', 'timeout', 'timeout', 'stop'],
    ]);
    // Its deadline was the stage attempt's end: it ran out of time, it was not cancelled.
    expect(['no-time-left', 'exhausted']).toContain(records[0].reason);
    expect(records[0].timeoutMs).toBeLessThanOrEqual(30);
  });

  it('the call’s signal is its stage attempt’s: a run cancellation aborts it', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const chart = flowChart<S>(
      'Fetch',
      async (scope: TypedScope<S>) => {
        await scope.$call('slow', (t) => {
          setTimeout(() => controller.abort(new Error('caller went away')), 5);
          return hang(t).catch((error: Error) => {
            seen.push(error.message);
            throw error;
          });
        });
      },
      'fetch',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ signal: controller.signal })).rejects.toThrow('caller went away');
    expect(seen).toEqual(['caller went away']);
    expect(node(executor, 'fetch').attempts![0]).toMatchObject({ kind: 'call', outcome: 'aborted', reason: 'aborted' });
  });
});

describe('correlation (P4) rides the call’s event', () => {
  it('the onAttempt event carries the run’s correlation, by reference', async () => {
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        await scope.$call('svc', () => 1);
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    const p = probe();
    executor.attachFlowRecorder(p);
    await executor.run({ env: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } });
    const correlation = executor.getSnapshot().correlation;
    expect(correlation?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(p.events).toHaveLength(1);
    expect(p.events[0].traversalContext?.correlation).toBe(correlation);
  });
});

describe('every stage kind can call', () => {
  const callIn = (target: string) => async (scope: TypedScope<S>) => {
    await scope.$call(target, () => target);
  };
  const callTargets = (executor: FlowChartExecutor<any, any>, id: string) =>
    (node(executor, id).attempts ?? []).filter((r) => r.kind === 'call').map((r) => r.target);

  it('a DECIDER, its branch, a FORK child and a stage INSIDE a subflow', async () => {
    const inner = flowChart<S>('Inner', callIn('inner.call'), 'inner').build();
    const chart = flowChart<S>('Seed', callIn('seed.call'), 'seed')
      .addDeciderFunction(
        'Route',
        async (scope: TypedScope<S>) => {
          await scope.$call('route.call', () => 1);
          return 'left';
        },
        'route',
      )
      .addFunctionBranch('left', 'Left', callIn('left.call'))
      .addFunctionBranch('right', 'Right', () => undefined)
      .end()
      .addListOfFunction([
        { id: 'child-a', name: 'Child A', fn: callIn('child-a.call') },
        { id: 'child-b', name: 'Child B', fn: () => undefined },
      ])
      .addSubFlowChartNext('sf', inner, 'Sub')
      .build();
    const executor = new FlowChartExecutor(chart);
    const p = probe();
    executor.attachFlowRecorder(p);
    await executor.run();
    expect(callTargets(executor, 'seed')).toEqual(['seed.call']);
    expect(callTargets(executor, 'route')).toEqual(['route.call']);
    expect(callTargets(executor, 'left')).toEqual(['left.call']);
    expect(callTargets(executor, 'child-a')).toEqual(['child-a.call']);
    expect(callTargets(executor, 'child-b')).toEqual([]);
    const innerEvent = p.events.find((e) => e.record.target === 'inner.call')!;
    expect(innerEvent.stageId).toBe('sf/inner');
    expect(innerEvent.record.series.startsWith('sf/inner#')).toBe(true);
  });
});

describe('observed() — retries an SDK ran on its own', () => {
  it('through `$attempt()`: kind observed, under the stage attempt’s call level, beside the stage’s calls', async () => {
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        await scope.$call('lookup', () => 1); // ordinal 1
        const t = scope.$attempt();
        t.observed({ target: 'stripe', attempt: 1, of: 3, outcome: 'failed', durationMs: 600, error: { status: 500 } });
        t.observed({ target: 'stripe', attempt: 2, of: 3, outcome: 'ok', durationMs: 90 }); // same series
      },
      'charge',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const charge = node(executor, 'charge');
    const id = charge.runtimeStageId;
    expect(charge.attempts!.map((r) => [r.kind, r.series, r.target, r.attempt, r.outcome])).toEqual([
      ['call', `${id}@1.1`, 'lookup', 1, 'ok'],
      ['observed', `${id}@1.2`, 'stripe', 1, 'failed'],
      ['observed', `${id}@1.2`, 'stripe', 2, 'ok'],
    ]);
    expect(charge.attempts![1]).toMatchObject({ source: 'sdk', category: 'server', of: 3 });
  });

  it('through a call’s own context: the SDK’s attempts are a call of the STAGE attempt (one call level)', async () => {
    const chart = flowChart<S>(
      'Charge',
      async (scope: TypedScope<S>) => {
        await scope.$call('stripe.charges.create', (t) => {
          t.observed({ target: 'stripe', attempt: 1, of: 2, outcome: 'timeout', durationMs: 40 });
          return 'ch_1';
        });
      },
      'charge',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const charge = node(executor, 'charge');
    const id = charge.runtimeStageId;
    expect(charge.attempts!.map((r) => [r.kind, r.series])).toEqual([
      ['observed', `${id}@1.2`],
      ['call', `${id}@1.1`],
    ]);
  });

  it('an observed attempt never changes control flow: the stage’s result is its own', async () => {
    const chart = flowChart<S>(
      'Charge',
      (scope: TypedScope<S>) => {
        scope.$attempt().observed({ target: 'stripe', outcome: 'failed', durationMs: 1, error: new Error('x') });
        scope.ok = true;
      },
      'charge',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.ok).toBe(true);
  });
});

describe('the narrative tells every call', () => {
  it('a single call, a retried call and an observed attempt — one line each, inside the stage', async () => {
    const svc = service(1);
    const chart = flowChart<S>(
      'Quote',
      async (scope: TypedScope<S>) => {
        await scope.$call('inventory.lookup', () => 1);
        await scope.$call('svc', () => svc.call(), { attempts: 2 });
        scope.$attempt().observed({
          target: 'stripe',
          attempt: 2,
          of: 3,
          outcome: 'failed',
          durationMs: 600,
          error: Object.assign(new Error('busy'), { status: 500 }),
        });
      },
      'quote',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();
    const lines = executor
      .getNarrativeEntries()
      .filter((e) => e.type === 'attempt')
      .map((e) => e.text);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Call inventory\.lookup succeeded in \d+ms\.$/);
    expect(lines[1]).toMatch(/^Call svc, attempt 1 of 2, failed in \d+ms \(server: busy 1\), retrying immediately\.$/);
    expect(lines[2]).toMatch(/^Call svc, attempt 2 of 2, succeeded in \d+ms\.$/);
    expect(lines[3]).toMatch(/^Observed: the stripe SDK made attempt 2 of 3, failed in 600ms \(server: busy\)\.$/);
  });

  it('a stage that makes no call narrates byte-identically (no attempt line)', async () => {
    const chart = flowChart<S>(
      'Plain',
      (scope: TypedScope<S>) => {
        scope.x = 1;
      },
      'plain',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();
    expect(executor.getNarrativeEntries().filter((e) => e.type === 'attempt')).toEqual([]);
    expect(node(executor, 'plain').attempts).toBeUndefined();
  });
});
