/**
 * Correlation — SECURITY tests (design §3.4, packet P4).
 *
 * Threat model: a `traceparent` comes from an untrusted caller.
 *   - It is read strictly; a refusal stops the run before anything moves, names the reason, and never repeats
 *     the header — not in the message, not in an event, not in the snapshot.
 *   - It is correlation only: a name the record carries, never identity. It never enters the commit log, the
 *     checkpoint, state or the stage's args.
 *   - One run's correlation never reaches another run: consecutive runs of one executor, concurrent runs of two
 *     executors of the SAME built chart.
 */
import { describe, expect, it } from 'vitest';

import { registerScopeRuntime } from '../../../../src/advanced.js';
import type { RunCorrelation } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, TraceparentError } from '../../../../src/index.js';

type S = Record<string, any>;

const header = (t: string, p: string) => `00-${t.repeat(32)}-${p.repeat(16)}-01`;
const A = header('a', '1');
const B = header('b', '2');

function chart(gate?: Promise<void>) {
  return flowChart<S>(
    'Seed',
    async (s) => {
      s.seen = s.$getEnv().traceId ?? null;
      await gate;
    },
    'seed',
  )
    .addFunction(
      'Next',
      (s) => {
        s.next = true;
      },
      'next',
    )
    .build();
}

function collect(ex: FlowChartExecutor<any, any>) {
  const out: Array<RunCorrelation | undefined> = [];
  ex.attachCombinedRecorder({
    id: 'collect',
    onStageExecuted: (e: any) => out.push(e.traversalContext?.correlation),
    onWrite: (e: any) => out.push(e.correlation),
    onRunStart: (e: any) => out.push(e.traversalContext?.correlation),
  });
  return out;
}

describe('a refused header', () => {
  it('rejects run() before any event fires or any state moves, naming the reason and not the header', async () => {
    const hostile = `00-${'a'.repeat(30)}"><img src=x>-${'1'.repeat(16)}-01`.slice(0, 55);
    const ex = new FlowChartExecutor(chart());
    const events = collect(ex);
    const error = await ex.run({ env: { traceparent: hostile } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TraceparentError);
    expect((error as TraceparentError).reason).toBe('characters');
    expect((error as Error).message).not.toContain('<img');
    expect(JSON.stringify(error)).not.toContain('<img');
    expect(events).toEqual([]);
    // The executor is not left mid-run: a good run follows.
    await ex.run({ env: { traceparent: A } });
    expect(ex.getSnapshot().correlation?.traceId).toBe('a'.repeat(32));
  });
});

describe('correlation is a name the record carries — never state, args, log or checkpoint', () => {
  it('the commit log, the state and the input carry no byte of it', async () => {
    const ex = new FlowChartExecutor(chart());
    await ex.run({ input: { q: 1 }, env: { traceparent: A } });
    const snap = ex.getSnapshot();
    expect(JSON.stringify(snap.commitLog)).not.toContain('a'.repeat(32));
    expect(JSON.stringify(snap.sharedState)).not.toContain('a'.repeat(32));
    expect(snap.sharedState.seen).toBeNull(); // the header is not turned into env.traceId for the stage
  });
});

describe('one run’s correlation never reaches another run', () => {
  it('consecutive runs of one executor: A, then nothing, then B', async () => {
    const ex = new FlowChartExecutor(chart());
    const events = collect(ex);
    await ex.run({ env: { traceparent: A } });
    const first = events.splice(0);
    await ex.run();
    const second = events.splice(0);
    await ex.run({ env: { traceparent: B } });
    const third = events.splice(0);
    expect(first.every((c) => c?.traceId === 'a'.repeat(32))).toBe(true);
    expect(second.every((c) => c === undefined)).toBe(true);
    expect(ex.getSnapshot().correlation?.traceId).toBe('b'.repeat(32));
    expect(third.every((c) => c?.traceId === 'b'.repeat(32))).toBe(true);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
  });

  it('concurrent runs of the SAME built chart on two executors keep their own', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const built = chart(gate);
    const x = new FlowChartExecutor(built);
    const y = new FlowChartExecutor(built);
    const xs = collect(x);
    const ys = collect(y);
    const both = Promise.all([x.run({ env: { traceparent: A } }), y.run({ env: { traceparent: B } })]);
    release();
    await both;
    expect(xs.length).toBeGreaterThan(0);
    expect(xs.every((c) => c?.traceId === 'a'.repeat(32))).toBe(true);
    expect(ys.every((c) => c?.traceId === 'b'.repeat(32))).toBe(true);
    expect(x.getSnapshot().correlation).not.toBe(y.getSnapshot().correlation);
    // And a third executor of the same chart with no env sees nothing of either.
    const z = new FlowChartExecutor(built);
    const zs = collect(z);
    await z.run();
    expect(zs.every((c) => c === undefined)).toBe(true);
  });

  it('the correlation a recorder holds cannot be edited to reach the next event', async () => {
    const ex = new FlowChartExecutor(chart());
    const events = collect(ex);
    await ex.run({ env: { traceparent: A } });
    const held = events[0]!;
    expect(() => {
      (held as { traceId: string }).traceId = 'forged';
    }).toThrow(TypeError);
  });
});

describe('what the stages see', () => {
  it('$getEnv().traceparent is the canonical header — a future version’s tail never reaches stage code', async () => {
    const seen: unknown[] = [];
    const built = flowChart<S>(
      'Seed',
      (s) => {
        seen.push(s.$getEnv().traceparent);
      },
      'seed',
    ).build();
    await new FlowChartExecutor(built).run({
      env: { traceparent: `cc-${'a'.repeat(32)}-${'1'.repeat(16)}-01-<script>tail</script>` },
    });
    expect(seen).toEqual([A]);
  });

  it('an inherited (polluted-prototype) traceparent is not the caller’s', async () => {
    const env = Object.create({ traceparent: A }) as Record<string, unknown>;
    const ex = new FlowChartExecutor(chart());
    await ex.run({ env });
    expect(ex.getSnapshot().correlation).toBeUndefined();
  });

  it('a scope target a custom factory re-uses across runs is cleared, never left with the last run’s', async () => {
    const installed: Array<RunCorrelation | undefined> = [];
    const target = { useCorrelation: (c: RunCorrelation | undefined) => installed.push(c) };
    const built = flowChart<S>('Seed', () => undefined, 'seed').build();
    const ex = new FlowChartExecutor(built, {
      scopeFactory: () => registerScopeRuntime({}, { target, handlesAssignments: false }),
    } as never);
    await ex.run({ env: { traceparent: A } });
    await ex.run();
    expect(installed.map((c) => c?.traceId)).toEqual(['a'.repeat(32), undefined]);
  });
});
