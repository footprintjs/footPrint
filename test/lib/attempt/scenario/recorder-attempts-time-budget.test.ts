/**
 * The recorders under a time budget (P1c over P1b): an attempt's own `timeout` outcome and the `no-time-left` stop
 * reach every recorder that counts outcomes or stops.
 *
 * WHY: P1b added two facts the incident needed — an attempt that ran out of its cap (`outcome: 'timeout'`), and a
 * series a deadline stopped before a wait it could not afford (`reason: 'no-time-left'`). A recorder that counts
 * outcomes or stops must say both. And P1b records a LONE attempt (`of: 1`) for every stage of a run with a
 * deadline: one that timed out is evidence (the lone timeout is the incident's own shape); one that merely failed
 * is a stage error like any other, and adds no attempt row — so a deadline alone never multiplies recorder rows.
 *
 * Test types: Scenario (one fork under a deadline — a child that recovers after a timeout, a lone timeout, a retry
 * stopped `no-time-left`, a lone failure, a plain child — and each recorder's row).
 */
import { describe, expect, it } from 'vitest';

import type { AttemptContext, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { debug, manifest, metrics } from '../../../../src/recorders.js';
import { controlDepRecorder, inOutRecorder, QualityRecorder, topologyRecorder } from '../../../../src/trace.js';

type S = Record<string, unknown>;
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const hang = (t: AttemptContext) =>
  new Promise<never>((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason)));

function buildChart() {
  let rateCalls = 0;
  return flowChart<S>(
    'Seed',
    (scope: TypedScope<S>) => {
      scope.seeded = true;
    },
    'seed',
  )
    .setLogger(silent)
    .addListOfFunction([
      {
        // Attempt 1 hangs past its 20ms cap; attempt 2 answers.
        id: 'rate',
        name: 'Rate',
        fn: async (scope: TypedScope<S>) => {
          rateCalls += 1;
          if (rateCalls === 1) await hang(scope.$attempt());
          scope.rate = 1.09;
        },
        retry: { attempts: 2, timeoutMs: 20 },
      },
      {
        // A lone call with a cap that never answers.
        id: 'lone',
        name: 'Lone',
        fn: (scope: TypedScope<S>) => hang(scope.$attempt()),
        retry: { attempts: 1, timeoutMs: 20 },
      },
      {
        // The wait before a retry would outlast the run's deadline.
        id: 'busy',
        name: 'Busy',
        fn: () => {
          throw new Error('busy');
        },
        retry: { attempts: 5, backoffMs: 60_000 },
      },
      {
        // No policy: under a deadline it still records a lone attempt — a plain failure, not attempt evidence.
        id: 'broken',
        name: 'Broken',
        fn: () => {
          throw new Error('broken');
        },
      },
      { id: 'plain', name: 'Plain', fn: () => undefined },
    ])
    .build();
}

async function runUnderDeadline() {
  const executor = new FlowChartExecutor(buildChart());
  const topo = topologyRecorder();
  const inOut = inOutRecorder();
  const quality = new QualityRecorder(() => ({ score: 1 }));
  const dbg = debug({ verbosity: 'minimal' });
  const man = manifest();
  const ctrl = controlDepRecorder();
  const met = metrics();
  for (const recorder of [topo, inOut, quality, dbg, man, ctrl, met]) executor.attachCombinedRecorder(recorder);
  await executor.run({ timeoutMs: 5_000 });
  const byStage = <T>(entries: Iterable<[string, T]>) =>
    Object.fromEntries([...entries].map(([id, value]) => [id.split('#')[0], value]));
  return { topo, inOut, quality, dbg, man, ctrl, met, byStage };
}

describe('a timeout and a no-time-left stop reach every recorder that counts outcomes or stops', () => {
  it('Topology: a node for the recovered-after-timeout series, the lone timeout and the no-time-left stop', async () => {
    const { topo } = await runUnderDeadline();
    const series = topo.getByKind('attempt-series');
    expect(Object.fromEntries(series.map((n) => [n.name, n.attemptSummary]))).toEqual({
      Rate: expect.objectContaining({ count: 2, ok: 1, timeout: 1, last: { next: 'done', reason: 'succeeded' } }),
      Lone: expect.objectContaining({
        count: 1,
        timeout: 1,
        last: { next: 'stop', reason: 'exhausted', category: 'timeout' },
      }),
      Busy: expect.objectContaining({ count: 1, failed: 1, last: expect.objectContaining({ reason: 'no-time-left' }) }),
    });
  });

  it('InOut: the root exit counts timeouts by outcome, and the lone timeout and the no-time-left stop as gave up', async () => {
    const { inOut } = await runUnderDeadline();
    const exit = inOut.getRootBoundary().exit!;
    expect(exit.attempts).toEqual({
      count: 4,
      byOutcome: { ok: 1, failed: 1, timeout: 2, aborted: 0, paused: 0 },
      gaveUp: 2,
    });
    expect(exit.failedAttempts?.map((r) => r.series.split('#')[0]).sort()).toEqual(['busy', 'lone', 'rate']);
  });

  it('Quality: a recovered series that timed out keeps its score and gains the drop; the two that stopped score 0', async () => {
    const { quality, byStage } = await runUnderDeadline();
    const rows = byStage(quality.getMap());
    expect(rows.rate).toMatchObject({ score: 1, drop: 'attempts', factors: ['attempts: 1 of 2 timed out'] });
    expect(rows.lone).toMatchObject({
      score: 0,
      drop: 'attempts',
      factors: ['attempts: gave up (exhausted, timeout) after 1 of 1'],
    });
    expect(rows.busy).toMatchObject({
      score: 0,
      drop: 'attempts',
      factors: ['attempts: gave up (no-time-left, unknown) after 1 of 5'],
    });
    expect(rows.broken).toBeUndefined(); // a plain failure: no onStageEnd, no attempt evidence
  });

  it('Debug: timeout rows carry the cap and the time left; stop rows name exhausted and no-time-left', async () => {
    const { dbg } = await runUnderDeadline();
    const rows = dbg.getEntries().filter((e) => e.type === 'attempt' || e.type === 'attemptStop');
    const summary = rows.map((e) => {
      const d = e.data as { outcome?: string; reason: string };
      return [e.type, e.stageName, d.outcome ?? '-', d.reason];
    });
    expect(summary.sort()).toEqual(
      [
        ['attempt', 'Rate', 'timeout', 'retryable'],
        ['attempt', 'Rate', 'ok', 'succeeded'],
        ['attempt', 'Lone', 'timeout', 'exhausted'],
        ['attemptStop', 'Lone', '-', 'exhausted'],
        ['attempt', 'Busy', 'failed', 'no-time-left'],
        ['attemptStop', 'Busy', '-', 'no-time-left'],
      ].sort(),
    );
    const timedOut = rows.find((e) => e.stageName === 'Lone' && e.type === 'attempt')!.data as Record<string, unknown>;
    expect(timedOut).toMatchObject({ timeoutMs: 20, category: 'timeout' });
    expect(typeof timedOut.timeLeftMs).toBe('number');
    const stopped = rows.find((e) => e.stageName === 'Busy' && e.type === 'attempt')!.data as Record<string, unknown>;
    expect(stopped).toMatchObject({ delayMs: 60_000 }); // the wait that did not fit
  });

  it('ControlDep: the lone timeout and the no-time-left stop are attempt-stop decisions', async () => {
    const { ctrl } = await runUnderDeadline();
    const stops = ctrl.getDecisions().filter((d) => d.kind === 'attempt-stop');
    expect(stops.map((d) => [d.deciderRuntimeStageId.split('#')[0], d.ruleLabel]).sort()).toEqual([
      ['busy', 'no-time-left'],
      ['lone', 'exhausted'],
    ]);
  });

  it('Manifest and Metrics: the summaries and the attempt count', async () => {
    const { man, met, byStage } = await runUnderDeadline();
    expect(man.getRootAttempts().map((r) => [r.stageName, r.attempts.timeout, r.attempts.last.reason])).toEqual(
      expect.arrayContaining([
        ['Rate', 1, 'succeeded'],
        ['Lone', 1, 'exhausted'],
        ['Busy', 0, 'no-time-left'],
      ]),
    );
    expect(man.getRootAttempts()).toHaveLength(3);
    const steps = byStage(met.getMap());
    expect(steps.rate.attempts).toBe(2);
    expect(steps.lone.attempts).toBeUndefined();
  });
});
