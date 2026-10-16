/**
 * Every built-in recorder accounts for attempts (design docs/design/2026-10-time-and-failure-evidence.md §5.1, P1c).
 *
 * WHY: P1a put every attempt on the execution tree and the `onAttempt` hook; a reader that only has a recorder's
 * row — the Topology graph, a boundary pair, a quality score, a debug log, the manifest, a control decision, the
 * metrics — still saw a retried stage as one quiet step, and a stage that gave up as a bare error. One chart, every
 * recorder attached, one row asserted per recorder.
 *
 * The one predicate every recorder shares (`recorder/attemptSeries.ts · isRetryEvidence`): a series is evidence when it
 * RETRIED or GAVE UP. A policy stage that succeeded first time adds nothing anywhere — so a chart in which nothing
 * retried keeps every recorder row byte-identical to the same chart with no policy at all.
 *
 * Test types: Scenario (one chart — a root stage that recovers, a subflow stage that recovers, a fork child that
 * gives up, a policy stage that never fails — and each recorder's row) · Functional (snapshot rows survive
 * `structuredClone`) · Security (a redacted stage error is redacted in every row that carries error text) ·
 * Boundary (no retry ⇒ every row identical to the no-policy chart).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { AttemptRecord, FlowAttemptEvent, RetryPolicy } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { debug, manifest, metrics } from '../../../../src/recorders.js';
import { controlDepRecorder, inOutRecorder, QualityRecorder, topologyRecorder } from '../../../../src/trace.js';

type S = Record<string, unknown>;
const SECRET = 'acct-0042-secret';

/** Throws `boom <n>` for the first `fails` calls, then writes `key`. */
function flaky(fails: number, key: string) {
  let calls = 0;
  return (scope: S) => {
    calls += 1;
    if (calls <= fails) throw new Error(`boom ${calls} on ${SECRET}`);
    scope[key] = `ok after ${calls}`;
  };
}

/** A permanent failure: the policy's `retryOn` declines it on the first attempt. */
function permanent(scope: S): never {
  const account = scope.seeded ? SECRET : 'unknown';
  throw Object.assign(new Error(`card declined for ${account}`), { status: 402 });
}

/**
 * The one chart. `withPolicies: false` builds the same shape with no policy at all; `failing: false` keeps the
 * policies but makes every stage succeed first time (nothing retries, nothing gives up).
 */
function buildChart({ withPolicies = true, failing = true } = {}) {
  const policy = (p: RetryPolicy) => (withPolicies ? p : undefined);
  const pay = flowChart<S>('Charge', failing ? flaky(1, 'charged') : flaky(0, 'charged'), 'charge');
  const payChart = (withPolicies ? pay.retry({ attempts: 3 }) : pay).build();

  const root = flowChart<S>(
    'Seed',
    (scope: S) => {
      scope.seeded = true;
    },
    'seed',
  ).addFunction('Fetch', failing ? flaky(2, 'fetched') : flaky(0, 'fetched'), 'fetch');
  const withFetch = withPolicies ? root.retry({ attempts: 3 }) : root;
  const steady = withFetch.addFunction('Steady', flaky(0, 'steady'), 'steady');
  return (withPolicies ? steady.retry({ attempts: 2 }) : steady)
    .addSubFlowChartNext('sf-pay', payChart, 'Pay')
    .addListOfFunction([
      {
        id: 'ledger',
        name: 'Ledger',
        fn: failing ? permanent : flaky(0, 'ledger'),
        retry: policy({ attempts: 3, retryOn: (e) => (e as { status?: number }).status !== 402 }),
      },
      { id: 'notify', name: 'Notify', fn: flaky(0, 'notified') },
    ])
    .addFunction('Done', flaky(0, 'done'), 'done')
    .build();
}

function attachAll(executor: FlowChartExecutor<any, any>) {
  const topo = topologyRecorder({ id: 'topology' });
  const inOut = inOutRecorder({ id: 'inout' });
  const quality = new QualityRecorder(() => ({ score: 1 }), { id: 'quality' });
  const dbg = debug({ id: 'debug', verbosity: 'minimal' });
  const man = manifest();
  const ctrl = controlDepRecorder({ id: 'control' });
  const met = metrics({ id: 'metrics' });
  const records: AttemptRecord[] = [];
  executor.attachCombinedRecorder(topo);
  executor.attachCombinedRecorder(inOut);
  executor.attachCombinedRecorder(quality);
  executor.attachCombinedRecorder(dbg);
  executor.attachCombinedRecorder(man);
  executor.attachCombinedRecorder(ctrl);
  executor.attachCombinedRecorder(met);
  executor.attachFlowRecorder({ id: 'probe', onAttempt: (e: FlowAttemptEvent) => records.push(e.record) });
  return { topo, inOut, quality, dbg, man, ctrl, met, records };
}

/** Every node of an execution tree. */
function treeNodes(root: StageSnapshot | undefined): StageSnapshot[] {
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

async function runOnce(options?: Parameters<typeof buildChart>[0], redact?: boolean) {
  const executor = new FlowChartExecutor(buildChart(options));
  if (redact) executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
  const recs = attachAll(executor);
  await executor.run();
  const seriesOf = (stageId: string) => {
    const found = recs.records.find((r) => r.series.split('#')[0] === stageId);
    if (!found) throw new Error(`no attempt series for ${stageId}`);
    return found.series;
  };
  return { executor, ...recs, seriesOf };
}

const refs = (series: string, ...attempts: number[]) => attempts.map((attempt) => ({ series, attempt }));

describe('one chart — every built-in recorder accounts for its attempts', () => {
  it('Topology: an attempt-series node per stage that retried or gave up, under its parent', async () => {
    const { topo, seriesOf, executor } = await runOnce();
    const series = topo.getByKind('attempt-series');
    expect(series.map((n) => [n.name, n.parentId, n.depth, n.incomingKind])).toEqual([
      ['Fetch', undefined, 0, 'root'],
      ['sf-pay/Charge', 'sf-pay', 1, 'next'],
      ['Ledger', expect.stringMatching(/^fork-/), 1, 'next'],
    ]);
    // The fork child hangs under its fork-branch node.
    const ledgerParent = topo.getTopology().nodes.find((n) => n.id === series[2].parentId)!;
    expect(ledgerParent.kind).toBe('fork-branch');
    expect(ledgerParent.name).toBe('Ledger');
    expect(series[2].depth).toBe(ledgerParent.depth + 1);

    const fetch = series[0];
    expect(fetch.id).toBe(`attempts-${seriesOf('fetch')}`);
    expect(fetch.enteredAt).toBe(seriesOf('fetch'));
    expect(fetch.attempts).toEqual(refs(seriesOf('fetch'), 1, 2, 3));
    // The node's summary is the execution tree's — the recorder derives nothing the runner did not stamp.
    const tree = treeNodes(executor.getSnapshot().executionTree as StageSnapshot);
    expect(fetch.attemptSummary).toEqual(tree.find((n) => n.id === 'fetch')!.attemptSummary);
    expect(series[2].attemptSummary).toEqual(tree.find((n) => n.id === 'ledger')!.attemptSummary);
    expect(series[2].attemptSummary?.last).toEqual({ next: 'stop', reason: 'declined', category: 'permanent' });

    // One retry self-edge per retry decision; a plain or first-time-ok stage is no node at all.
    const retryEdges = topo.getTopology().edges.filter((e) => e.kind === 'retry');
    expect(retryEdges.map((e) => [e.from, e.to])).toEqual([
      [fetch.id, fetch.id],
      [fetch.id, fetch.id],
      [series[1].id, series[1].id],
    ]);
    expect(topo.getTopology().nodes.some((n) => n.name === 'Steady' || n.name === 'Seed')).toBe(false);
  });

  it('InOut: each exit boundary says what it cost to get through', async () => {
    const { inOut, seriesOf } = await runOnce();
    const sfExit = inOut.getBoundaries().find((b) => b.subflowId === 'sf-pay' && b.phase === 'exit')!;
    expect(sfExit.attempts).toEqual({
      count: 2,
      byOutcome: { ok: 1, failed: 1, timeout: 0, aborted: 0, paused: 0 },
      gaveUp: 0,
    });
    expect(sfExit.failedAttempts).toEqual(refs(seriesOf('sf-pay/charge'), 1));

    const rootExit = inOut.getRootBoundary().exit!;
    expect(rootExit.attempts).toEqual({
      count: 6,
      byOutcome: { ok: 2, failed: 4, timeout: 0, aborted: 0, paused: 0 },
      gaveUp: 1,
    });
    expect(rootExit.failedAttempts).toEqual([
      ...refs(seriesOf('fetch'), 1, 2),
      ...refs(seriesOf('sf-pay/charge'), 1),
      ...refs(seriesOf('ledger'), 1),
    ]);
    // Entries never carry it — the cost is known only at the exit.
    expect(inOut.getSteps().some((b) => Object.hasOwn(b, 'attempts'))).toBe(false);
  });

  it('Quality: a gave-up series is a drop at that stage, with the keys it read', async () => {
    const { quality, seriesOf } = await runOnce();
    const ledger = quality.getByKey(seriesOf('ledger'))!;
    expect(ledger.score).toBe(0);
    expect(ledger.drop).toBe('attempts');
    expect(ledger.attempts?.last.reason).toBe('declined');
    expect(ledger.factors).toEqual(['attempts: gave up (declined, permanent) after 1 of 3']);
    expect(ledger.keysRead).toEqual(['seeded']);
    // A series that recovered without a timeout is no drop: its score is the scoring function's.
    const fetch = quality.getByKey(seriesOf('fetch'))!;
    expect(fetch.score).toBe(1);
    expect(fetch.drop).toBeUndefined();
    expect(quality.getLowest()?.runtimeStageId).toBe(seriesOf('ledger'));
  });

  it('Debug: one row per attempt, and a stop row for a series that gave up', async () => {
    const { dbg, seriesOf } = await runOnce();
    const rows = dbg.getEntries().filter((e) => e.type === 'attempt' || e.type === 'attemptStop');
    expect(rows.map((e) => [e.type, e.stageName, (e.data as { attempt: number }).attempt])).toEqual([
      ['attempt', 'Fetch', 1],
      ['attempt', 'Fetch', 2],
      ['attempt', 'Fetch', 3],
      ['attempt', 'sf-pay/Charge', 1],
      ['attempt', 'sf-pay/Charge', 2],
      ['attempt', 'Ledger', 1],
      ['attemptStop', 'Ledger', 1],
    ]);
    expect(rows[0].data).toEqual({
      stageId: 'fetch',
      series: seriesOf('fetch'),
      attempt: 1,
      of: 3,
      outcome: 'failed',
      category: 'unknown',
      durationMs: expect.any(Number),
      next: 'retry',
      reason: 'retryable',
      delayMs: 0,
      error: { message: `boom 1 on ${SECRET}`, name: 'Error' },
    });
    expect(rows[6].data).toEqual({
      stageId: 'ledger',
      series: seriesOf('ledger'),
      attempt: 1,
      of: 3,
      reason: 'declined',
      category: 'permanent',
    });
    // A stage's failure is no `error` row (the scope channel's onError is a recorder's own failure, and the flow
    // channel's is ignored): the attempt rows are the failure evidence.
    expect(dbg.getErrors()).toEqual([]);
  });

  it('Manifest: a subflow entry carries the attempts of the stages it ran; root-level ones ride meta', async () => {
    const { man, seriesOf, executor } = await runOnce();
    const [pay] = man.getManifest();
    expect(pay.attempts).toEqual([
      {
        stageId: 'sf-pay/charge',
        stageName: 'sf-pay/Charge',
        runtimeStageId: seriesOf('sf-pay/charge'),
        attempts: expect.objectContaining({ count: 2, ok: 1, failed: 1 }),
      },
    ]);
    expect(man.getRootAttempts().map((r) => [r.stageName, r.attempts.count, r.attempts.last.reason])).toEqual([
      ['Fetch', 3, 'succeeded'],
      ['Ledger', 1, 'declined'],
    ]);
    const row = executor.getSnapshot().recorders!.find((r) => r.id === 'manifest')!;
    expect(row.meta).toEqual({ rootAttempts: man.getRootAttempts() });
  });

  it('ControlDep: a stop decision is recorded as an attempt-stop decision on the stage', async () => {
    const { ctrl, seriesOf, records } = await runOnce();
    const stops = ctrl.getDecisions().filter((d) => d.kind === 'attempt-stop');
    expect(stops).toEqual([
      {
        kind: 'attempt-stop',
        deciderRuntimeStageId: seriesOf('ledger'),
        chosen: 'stop',
        evidence: records.find((r) => r.series === seriesOf('ledger'))!.decision,
        ruleLabel: 'declined',
      },
    ]);
    expect(ctrl.getAttemptStop(seriesOf('ledger'))?.ruleLabel).toBe('declined');
    expect(ctrl.getAttemptStop(seriesOf('fetch'))).toBeUndefined();
  });

  it('MetricRecorder: attempts = the stage starts it saw; duration spans every attempt', async () => {
    const { met, seriesOf } = await runOnce();
    expect(met.getByKey(seriesOf('fetch'))?.attempts).toBe(3);
    expect(met.getByKey(seriesOf('sf-pay/charge'))?.attempts).toBe(2);
    expect(met.getByKey(seriesOf('steady'))?.attempts).toBeUndefined();
    // Ledger was declined on its first attempt: one start, no count.
    expect(met.getByKey(seriesOf('ledger'))?.attempts).toBeUndefined();
    expect(met.values().filter((m) => m.attempts !== undefined)).toHaveLength(2);
  });

  it('snapshot rows carry the attempt fields and survive structuredClone', async () => {
    const { executor } = await runOnce();
    const rows = executor.getSnapshot().recorders!;
    expect(structuredClone(rows)).toEqual(rows);
    const byId = (id: string) => JSON.stringify(rows.find((r) => r.id === id));
    expect(byId('topology')).toContain('"attempt-series"');
    expect(byId('inout')).toContain('"gaveUp":1');
    expect(byId('quality')).toContain('"drop":"attempts"');
    expect(byId('debug')).toContain('"attemptStop"');
    // ControlDepRecorder serves a lookup, not a snapshot bundle: it has no row, before or after 10.1.
    expect(rows.some((r) => r.id === 'control')).toBe(false);
    expect(byId('metrics')).toContain('"attempts":3');
  });
});

describe('the redaction law reaches every row that carries attempt error text', () => {
  it('a diagnostic policy on the stage error text keeps it out of every recorder row', async () => {
    const { executor, dbg } = await runOnce(undefined, true);
    const attemptRows = dbg.getEntries().filter((e) => e.type === 'attempt');
    expect(attemptRows.some((e) => (e.data as { error?: unknown }).error !== undefined)).toBe(true);
    expect(JSON.stringify(executor.getSnapshot().recorders)).not.toContain(SECRET);
  });
});

describe('a chart in which nothing retried keeps every recorder row byte-identical', () => {
  /** Timing is the only thing two runs may disagree on. */
  function stable(rows: unknown): unknown {
    return JSON.parse(
      JSON.stringify(rows, (key, value) =>
        key === 'timestamp' || key === 'duration' || key === 'totalDuration' ? 0 : value,
      ),
    );
  }

  it('policies that never fail record the same rows as no policy at all', async () => {
    const quiet = await runOnce({ withPolicies: true, failing: false });
    const plain = await runOnce({ withPolicies: false, failing: false });
    expect(quiet.records.length).toBeGreaterThan(0); // the policies ran — and said nothing to the recorders
    expect(stable(quiet.executor.getSnapshot().recorders)).toEqual(stable(plain.executor.getSnapshot().recorders));
  });
});
