/**
 * The run's correlation on a real chart — every event, every subflow, a resume (design §3.4, packet P4).
 *
 * WHY: a run started for an inbound request must be findable from that request's trace. `env.traceparent` (or
 * `env.traceId` + `env.operationId`) becomes ONE frozen `RunCorrelation` per leg: on the snapshot, and — the same
 * object, by reference — on every flow event's `TraversalContext` and every scope and emit event.
 *
 * Test types: Scenario (every hook a real run fires, the shared channels included; subflows two deep, lazy and
 * `parallelForEach` mounts; a pause and a resume on the same and on a fresh executor) · Boundary (no correlation →
 * no key anywhere; the bytes of the log and narrative do not change with a correlation).
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler, RunCorrelation } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, TraceparentError } from '../../../../src/index.js';
import { HOOK_NAMES } from '../../../../src/lib/recorder/hooks.js';

type S = Record<string, any>;

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const HEADER = `00-${TRACE}-${PARENT}-01`;
const OTHER = `00-${'b'.repeat(32)}-${'c'.repeat(16)}-00`;

/** The three emitters that carry no TraversalContext at all (engine/narrative/README.md) — nothing to stamp. */
const CONTEXT_LESS = new Set(['onSubflowRegistered', 'onLoop', 'onPause']);

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

interface Seen {
  readonly hook: string;
  readonly channel: 'scope' | 'flow';
  readonly correlation: RunCorrelation | undefined;
  readonly hasContext: boolean;
  readonly event: any;
}

/** One recorder on every hook of every channel. Scope and emit events carry `pipelineId`; flow events do not. */
function everyHook(seen: Seen[], opts: { throwOnWrite?: boolean } = {}) {
  const recorder: Record<string, unknown> = { id: 'every-hook' };
  for (const hook of HOOK_NAMES) {
    recorder[hook] = (event: any) => {
      const scope = event !== null && typeof event === 'object' && has(event, 'pipelineId');
      seen.push({
        hook,
        channel: scope ? 'scope' : 'flow',
        correlation: scope ? event.correlation : event?.traversalContext?.correlation,
        hasContext: scope || event?.traversalContext !== undefined,
        event,
      });
      if (opts.throwOnWrite && hook === 'onWrite' && event.key === 'boom') throw new Error('recorder failed');
    };
  }
  return recorder;
}

function inner2() {
  return flowChart<S>(
    'Deep',
    (s) => {
      s.deep = 1;
    },
    'deep',
  ).build();
}

function inner1() {
  return flowChart<S>(
    'Inner',
    (s) => {
      s.inner = 1;
    },
    'inner',
  )
    .addSubFlowChart('sf-deep', inner2(), 'SfDeep', {
      inputMapper: () => ({}),
      outputMapper: (o: S) => ({ deep: o.deep }),
    })
    .build();
}

/** A chart that fires every hook a run can fire: stages, a decider, a loop, a selector, a fork, subflows, a retry, an emit, a break. */
function busyChart() {
  let flaky = 0;
  return flowChart<S>(
    'Seed',
    (s) => {
      s.n = 0;
      s.$emit('app.seeded', { ok: true });
    },
    'seed',
  )
    .addFunction(
      'Count',
      (s) => {
        s.n = s.n + 1;
      },
      'count',
    )
    .addFunction('Back', () => undefined, 'back')
    .addDeciderFunction('Again?', (s) => (s.n < 2 ? 'again' : 'done'), 'again-decider')
    .addFunctionBranch('again', 'Again', () => undefined, undefined, { loopTo: 'count' })
    .addFunctionBranch('done', 'Done', () => undefined)
    .end()
    .addSelectorFunction('Pick', () => ['x', 'y'], 'pick')
    .addFunctionBranch('x', 'X', (s) => {
      s.x = 1;
    })
    .addFunctionBranch('y', 'Y', (s) => {
      s.y = 1;
    })
    .end()
    .addListOfFunction([
      {
        id: 'c1',
        name: 'C1',
        fn: (s: S) => {
          s.c1 = 1;
        },
      },
      {
        id: 'c2',
        name: 'C2',
        fn: (s: S) => {
          s.c2 = 1;
        },
      },
    ])
    .addSubFlowChart('sf', inner1(), 'Sf', { inputMapper: () => ({}), outputMapper: (o: S) => ({ fromSf: o.inner }) })
    .addLazySubFlowChartNext('lazy', inner2, 'Lazy')
    .addFunction(
      'Items',
      (s) => {
        s.items = [1, 2];
      },
      'items',
    )
    .addParallelForEach('Each', 'each', {
      items: (s: S) => s.items,
      branch: () => inner2(),
      into: 'out',
      maxBranches: 2,
    })
    .addFunction(
      'Flaky',
      (s) => {
        flaky += 1;
        if (flaky === 1) throw new Error('transient');
        s.boom = 'ok';
      },
      'flaky',
    )
    .retry({ attempts: 2 })
    .addFunction(
      'Stop',
      (s) => {
        s.$break('enough');
      },
      'stop',
    )
    .addFunction('Never', () => undefined, 'never')
    .build();
}

function failingChart() {
  return flowChart<S>('Seed', () => undefined, 'seed')
    .addListOfFunction([
      { id: 'ok', name: 'Ok', fn: () => undefined },
      {
        id: 'throttled',
        name: 'Throttled',
        fn: () => {
          throw Object.assign(new Error('slow down'), { status: 429 });
        },
      },
    ])
    .addFunction(
      'Fail',
      () => {
        throw new Error('fatal');
      },
      'fail',
    )
    .build();
}

function pauseChart() {
  return flowChart<S>(
    'Receive',
    (s) => {
      s.step = 1;
    },
    'receive',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: async () => ({ question: 'Approve?' }),
        resume: async (s: S, input: unknown) => {
          s.approved = (input as { approved: boolean }).approved;
        },
      } as PausableHandler<S, { approved: boolean }>,
      'approve',
    )
    .addFunction(
      'Process',
      (s) => {
        s.done = true;
      },
      'process',
    )
    .build();
}

async function runAll(env: Record<string, unknown> | undefined) {
  const seen: Seen[] = [];
  const busy = new FlowChartExecutor(busyChart());
  busy.attachCombinedRecorder(everyHook(seen, { throwOnWrite: true }));
  await busy.run({ env });

  const failing = new FlowChartExecutor(failingChart(), { throttlingErrorChecker: () => true });
  failing.attachCombinedRecorder(everyHook(seen));
  await expect(failing.run({ env })).rejects.toThrow('fatal');

  const pausing = new FlowChartExecutor(pauseChart());
  pausing.attachCombinedRecorder(everyHook(seen));
  await pausing.run({ env });
  expect(pausing.isPaused()).toBe(true);
  await pausing.resume(pausing.getCheckpoint()!, { approved: true }, { env: env as never });
  return { seen, busy };
}

describe('correlation — on every event of a real run', () => {
  it('every hook a run fires carries the ONE frozen correlation, by reference (the three context-less emitters aside)', async () => {
    const { seen, busy } = await runAll({ traceparent: HEADER });
    const correlation = busy.getSnapshot().correlation!;
    expect(correlation).toEqual({ traceId: TRACE, operationId: PARENT, sampled: true, traceparent: HEADER });
    expect(Object.isFrozen(correlation)).toBe(true);

    // Every hook in the registry fired on the channels it is declared on — so "every event" means every hook.
    const fired = new Set(seen.map((s) => `${s.channel}:${s.hook}`));
    const expected = [
      ...[
        'onRead',
        'onWrite',
        'onCommit',
        'onError',
        'onStageStart',
        'onStageEnd',
        'onPause',
        'onResume',
        'onEmit',
      ].map((h) => `scope:${h}`),
      ...HOOK_NAMES.filter(
        (h) => !['onRead', 'onWrite', 'onCommit', 'onStageStart', 'onStageEnd', 'onEmit'].includes(h),
      ).map((h) => `flow:${h}`),
    ];
    expect([...expected].filter((h) => !fired.has(h))).toEqual(['flow:onSubflowRegistered']);

    const withContext = seen.filter((s) => s.hasContext);
    for (const s of withContext)
      expect({ hook: `${s.channel}:${s.hook}`, ok: s.correlation !== undefined }).toEqual({
        hook: `${s.channel}:${s.hook}`,
        ok: true,
      });
    // One object per leg: the busy executor's events hold the snapshot's correlation itself.
    const busyEvents = withContext.slice(0, withContext.findIndex((s) => s.hook === 'onRunEnd') + 1);
    for (const s of busyEvents) expect(s.correlation).toBe(correlation);

    // The only events with no correlation are the named context-less emitters, which carry no context at all.
    const contextLess = seen.filter((s) => !s.hasContext);
    for (const s of contextLess) expect(CONTEXT_LESS.has(s.hook)).toBe(true);
    // And every hook that fired context-less ALSO fired with a context (and the correlation) somewhere else.
    for (const hook of new Set(contextLess.map((s) => s.hook))) {
      expect(withContext.some((s) => s.hook === hook && s.correlation !== undefined)).toBe(true);
    }
  });

  it('subflows inherit it: two deep, lazy, parallelForEach branches — flow and scope events alike', async () => {
    const { seen } = await runAll({ traceparent: HEADER });
    const inSubflow = seen.filter(
      (s) =>
        (s.channel === 'flow' && s.event?.traversalContext?.subflowId) ||
        (s.channel === 'scope' && String(s.event.runtimeStageId).includes('/')),
    );
    const ids = new Set(
      inSubflow.map((s) =>
        s.channel === 'flow' ? s.event.traversalContext.subflowId : s.event.runtimeStageId.split('/')[0],
      ),
    );
    expect([...ids].some((id) => String(id).includes('sf-deep'))).toBe(true);
    expect([...ids].some((id) => String(id).startsWith('lazy'))).toBe(true);
    expect([...ids].some((id) => String(id).startsWith('each~'))).toBe(true);
    for (const s of inSubflow) expect(s.correlation?.traceId).toBe(TRACE);
  });

  it('deferred delivery: every captured event keeps it, and a deferred listener’s failure event carries it', async () => {
    const seen: Seen[] = [];
    const ex = new FlowChartExecutor(busyChart());
    const recorder = everyHook(seen);
    const throwing = { ...recorder, id: 'deferred-every-hook' } as Record<string, any>;
    const write = throwing.onWrite;
    throwing.onWrite = (e: any) => {
      write(e);
      if (e.key === 'boom') throw new Error('deferred listener failed');
    };
    ex.attachCombinedRecorder(throwing, { delivery: 'deferred' });
    await ex.run({ env: { traceparent: HEADER } });
    await ex.drainObservers();
    expect(seen.length).toBeGreaterThan(50);
    for (const s of seen)
      expect({ hook: s.hook, traceId: s.correlation?.traceId }).toEqual({ hook: s.hook, traceId: TRACE });
    expect(seen.some((s) => s.hook === 'onError' && s.channel === 'scope')).toBe(true);
  });

  it('explicit ids: traceId + operationId, and the mixed form', async () => {
    const seen: Seen[] = [];
    const ex = new FlowChartExecutor(pauseChart());
    ex.attachCombinedRecorder(everyHook(seen));
    await ex.run({ env: { traceId: 'req-123', operationId: 'checkout' } });
    expect(ex.getSnapshot().correlation).toEqual({ traceId: 'req-123', operationId: 'checkout' });
    expect(seen.every((s) => s.correlation === ex.getSnapshot().correlation)).toBe(true);

    await ex.run({ env: { traceparent: HEADER, traceId: 'req-9' } });
    // Another trace than the header's: the header's sampled flag and traceparent do not ride.
    expect(ex.getSnapshot().correlation).toEqual({ traceId: 'req-9', operationId: PARENT });
  });
});

describe('correlation — a resumed run is its own leg', () => {
  it('same executor: the resume carries ITS env’s correlation, never the paused leg’s', async () => {
    const seen: Seen[] = [];
    const ex = new FlowChartExecutor(pauseChart());
    ex.attachCombinedRecorder(everyHook(seen));
    await ex.run({ env: { traceparent: HEADER } });
    const paused = ex.getCheckpoint()!;
    expect(JSON.stringify(paused)).not.toContain(TRACE); // the checkpoint carries no correlation (lean)

    seen.length = 0;
    await ex.resume(paused, { approved: true }, { env: { traceparent: OTHER } });
    expect(ex.getSnapshot().correlation?.traceId).toBe('b'.repeat(32));
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.correlation?.traceId).toBe('b'.repeat(32));
    // onResume is executor-made on both channels; it carries the resumed leg's correlation too.
    expect(
      seen
        .filter((s) => s.hook === 'onResume')
        .map((s) => s.channel)
        .sort(),
    ).toEqual(['flow', 'scope']);
  });

  it('a resume with no env carries none — nothing leaks from the paused leg', async () => {
    const seen: Seen[] = [];
    const ex = new FlowChartExecutor(pauseChart());
    ex.attachCombinedRecorder(everyHook(seen));
    await ex.run({ env: { traceparent: HEADER } });
    seen.length = 0;
    await ex.resume(ex.getCheckpoint()!, { approved: true });
    expect(has(ex.getSnapshot(), 'correlation')).toBe(false);
    for (const s of seen) expect(s.correlation).toBeUndefined();
  });

  it('a fresh executor resuming a stored checkpoint takes the correlation from its own env', async () => {
    const first = new FlowChartExecutor(pauseChart());
    await first.run({ env: { traceparent: HEADER } });
    const stored = JSON.parse(JSON.stringify(first.getCheckpoint()));

    const seen: Seen[] = [];
    const second = new FlowChartExecutor(pauseChart());
    second.attachCombinedRecorder(everyHook(seen));
    await second.resume(stored, { approved: true }, { env: { traceparent: HEADER } });
    expect(second.getSnapshot().correlation?.traceparent).toBe(HEADER);
    for (const s of seen) expect(s.correlation).toBe(second.getSnapshot().correlation);
  });

  it('a bad header on resume is refused before anything moves; the checkpoint still resumes', async () => {
    const ex = new FlowChartExecutor(pauseChart());
    await ex.run();
    const checkpoint = ex.getCheckpoint()!;
    await expect(ex.resume(checkpoint, { approved: true }, { env: { traceparent: 'garbage' } })).rejects.toBeInstanceOf(
      TraceparentError,
    );
    expect(ex.getCheckpoint()).toBe(checkpoint);
    await ex.resume(checkpoint, { approved: true });
    expect(ex.getSnapshot().sharedState.done).toBe(true);
  });
});

describe('correlation — absent when not given', () => {
  it('no env, or an env without it: no key on the snapshot, the contexts or the scope events', async () => {
    for (const env of [undefined, { timeoutMs: 1000 }]) {
      const { seen, busy } = await runAll(env);
      expect(has(busy.getSnapshot(), 'correlation')).toBe(false);
      for (const s of seen) {
        const holder = s.channel === 'scope' ? s.event : s.event?.traversalContext;
        if (holder) expect(has(holder, 'correlation')).toBe(false);
      }
    }
  });

  it('with a correlation, the log, the narrative and the state are the same bytes as without', async () => {
    const shape = async (env?: Record<string, unknown>) => {
      const ex = new FlowChartExecutor(busyChart());
      ex.enableNarrative();
      await ex.run({ env });
      const snap = ex.getSnapshot();
      return JSON.stringify({
        log: snap.commitLog,
        narrative: ex.getNarrativeEntries(),
        state: snap.sharedState,
        keys: Object.keys(snap).filter((k) => k !== 'correlation'),
      });
    };
    expect(await shape({ traceparent: HEADER })).toBe(await shape());
  });
});
