/** P7 security/boundaries: payload-free projection, exact physical references and bounded storage ownership. */
import { describe, expect, it } from 'vitest';

import type { FlowAttemptEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { AttemptRow, AttemptStore } from '../../../../src/recorders.js';
import { attempts, memoryStore } from '../../../../src/recorders.js';

const ctx = (runId = 'run-1', index = 0) => ({
  runId,
  stageId: 'step',
  runtimeStageId: `step#${index}`,
  stageName: 'Step',
  depth: 0,
});
const event = (
  durationMs: number,
  index = 0,
  runId = 'run-1',
  patch: Partial<FlowAttemptEvent['record']> = {},
): FlowAttemptEvent => ({
  stageName: 'Step',
  stageId: 'step',
  traversalContext: ctx(runId, index),
  record: {
    series: `step#${index}`,
    kind: 'stage',
    attempt: 1,
    of: 1,
    startedAt: 1000 + index,
    durationMs,
    outcome: 'ok',
    next: 'done',
    reason: 'succeeded',
    decision: { rules: [], chosen: 'done', default: 'retry' },
    ...patch,
  },
});

describe('attempt metrics boundaries and security', () => {
  it('computes exact nearest-rank percentiles, with success category absent instead of invented unknown', () => {
    const rec = attempts({ exemplars: 2 });
    [1, 2, 3, 4, 100].forEach((ms, i) => rec.onAttempt(event(ms, i)));
    expect(rec.byTarget().get('step')).toMatchObject({
      count: 5,
      byKind: { stage: 5, call: 0, observed: 0 },
      byCategory: { unknown: 0 },
      latencyMs: { p50: 3, p90: 100, p95: 100, max: 100, mean: 22 },
      budgetUsedMs: 110,
    });
    expect(rec.slowest('step', 2).map((ref) => ref.id)).toEqual(['step#4@1', 'step#3@1']);
    expect(rec.byRun().get('run-1')).not.toHaveProperty('budgetMs');
  });
  it('isolates identical native attempt IDs across runs and makes returned views detached', () => {
    const rec = attempts();
    rec.onAttempt(event(3, 0, 'one'));
    rec.onAttempt(event(5, 0, 'two'));
    expect(rec.byTarget().get('step')?.count).toBe(2);
    expect(rec.byRun().size).toBe(2);
    const refs = rec.slowest('step');
    Reflect.set(refs[0], 'durationMs', 999);
    expect(rec.slowest('step')[0].durationMs).toBe(5);
  });
  it('drops key, errors, raw causes and unknown envelopes before external storage or snapshots', async () => {
    const secret = 'SYNTHETIC-DO-NOT-RETAIN';
    const stored: AttemptRow[] = [];
    const store: AttemptStore = {
      append: (rows) => {
        stored.push(...rows);
      },
      read: async () => stored,
    };
    const rec = attempts({ store });
    const sample = event(4, 0, 'run-1', {
      outcome: 'failed',
      category: 'auth',
      next: 'stop',
      reason: 'declined',
      idempotencyKey: secret,
      error: { message: secret, name: 'Error' },
    });
    Object.assign(sample.record, { extra: { hidden: secret } });
    rec.onAttempt(sample);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(rec.toSnapshot())).not.toContain(secret);
    expect(rec.byTarget().get('step')).toMatchObject({ gaveUp: 1, byCategory: { auth: 1 } });
    const bad = { ...stored[0], category: '__proto__', error: { message: secret } };
    const external = attempts({ store: { append() {}, read: async () => [bad as AttemptRow] } });
    expect((await external.aggregate()).storage).toMatchObject({ omittedRows: 1, incomplete: true });
    expect((await external.aggregate()).byTarget.size).toBe(0);
  });
  it('records observed SDK work separately, including an observed retry', async () => {
    const rec = attempts();
    const chart = flowChart(
      'SDK',
      (scope) => {
        scope.$attempt().observed({
          target: 'mock.sdk',
          attempt: 1,
          outcome: 'failed',
          startedAt: 10,
          durationMs: 2,
          category: 'network',
        });
        scope.$attempt().observed({ target: 'mock.sdk', attempt: 2, outcome: 'ok', startedAt: 12, durationMs: 3 });
      },
      'sdk',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();
    expect(rec.byTarget().get('mock.sdk')).toMatchObject({
      count: 2,
      byKind: { observed: 2 },
      byOutcome: { failed: 1, ok: 1 },
    });
  });
  it('bounds memory rows and discloses evictions, while durable rows remain separately queryable', async () => {
    const store = memoryStore({ maxRows: 20 });
    const rec = attempts({ maxRows: 2, store });
    [1, 2, 3].forEach((ms, i) => rec.onAttempt(event(ms, i)));
    expect(rec.byTarget().get('step')?.count).toBe(2);
    expect(rec.storage()).toMatchObject({ omittedRows: 1, incomplete: true });
    expect((await rec.aggregate()).byTarget.get('step')?.count).toBe(2);
    expect((await rec.aggregate()).storage.omittedRows).toBe(2);
    expect(await store.read({})).toHaveLength(3);
  });
  it('caps stuck appends without a retry queue, keeps ownership across clear, and flush returns incomplete', async () => {
    let writes = 0;
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rec = attempts({
      maxPending: 2,
      storeTimeoutMs: 5,
      store: {
        append() {
          writes++;
          return stalled;
        },
        read: async () => [],
      },
    });
    [1, 2, 3, 4].forEach((ms, i) => rec.onAttempt(event(ms, i)));
    expect(writes).toBe(2);
    rec.clear();
    expect(rec.storage()).toMatchObject({ pending: 2, dropped: 2, incomplete: true });
    expect(await rec.flush()).toMatchObject({ pending: 2, incomplete: true });
    release();
    await rec.flush();
    expect(rec.storage().pending).toBe(0);
  });
  it.each(['throw', 'reject'] as const)('handles a store %s once, with no raw error text retained', async (how) => {
    const rec = attempts({
      store: {
        append() {
          if (how === 'throw') throw new Error('SECRET-STORE');
          return Promise.reject(new Error('SECRET-STORE'));
        },
        read: async () => [],
      },
    });
    rec.onAttempt(event(1));
    await rec.flush();
    expect(rec.storage()).toMatchObject({ failed: 1, pending: 0, incomplete: true });
    expect(JSON.stringify(rec.storage())).not.toContain('SECRET-STORE');
  });
  it('a timed-out read keeps its bounded slot until actual settlement', async () => {
    let reads = 0;
    const rec = attempts({
      maxPending: 1,
      storeTimeoutMs: 5,
      store: {
        append() {},
        read() {
          reads++;
          return new Promise(() => {});
        },
      },
    });
    await expect(rec.aggregate()).rejects.toThrow(/read timed out/);
    await expect(rec.aggregate()).rejects.toThrow(/capacity/);
    expect(reads).toBe(1);
  });
  it('OTLP uses real histogram buckets/counts and navigable physical exemplar IDs; opaque trace IDs stay attributes only', () => {
    const rec = attempts({ exemplars: 2 });
    const real = '1234567890abcdef1234567890abcdef';
    rec.onAttempt({ ...event(4, 0), traversalContext: { ...ctx(), correlation: { traceId: real } } });
    rec.onAttempt({
      ...event(100, 1),
      traversalContext: { ...ctx('run-1', 1), correlation: { traceId: 'opaque-app-trace' } },
    });
    const metrics = rec.toOTel().resourceMetrics[0].scopeMetrics[0].metrics;
    const histogram = metrics.find((m) => m.name === 'footprint.attempt.duration')!.histogram!;
    const point = histogram.dataPoints[0];
    expect(point.count).toBe('2');
    expect(point.sum).toBe(104);
    expect(point.bucketCounts.reduce((n, v) => n + Number(v), 0)).toBe(2);
    expect(point.exemplars).toHaveLength(2);
    expect(point.exemplars.filter((e) => e.traceId !== undefined)).toEqual([
      expect.objectContaining({ traceId: real }),
    ]);
    for (const exemplar of point.exemplars) {
      expect(exemplar.filteredAttributes).toContainEqual({
        key: 'footprint.attempt.id',
        value: { stringValue: expect.stringMatching(/^step#\d+@1$/) },
      });
      expect(exemplar.filteredAttributes).toContainEqual({ key: 'footprint.run_id', value: { stringValue: 'run-1' } });
    }
  });
  it('treats helper orchestration completion as a stage role, while the provider call stays unknown after failed reconciliation', async () => {
    const rec = attempts();
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addRetryLoop('same-name', {
        touches: 'same-name',
        idempotencyKey: () => 'key',
        retry: { attempts: 2, timeoutMs: 20 },
        attempt: () => {
          throw new Error('uncertain');
        },
        reconcile: () => 'unknown',
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run().catch(() => undefined);
    const stats = rec.byTarget().get('same-name')!;
    expect(stats.byKind).toMatchObject({ stage: 1, call: 1 });
    expect(stats.effectUnknown).toBe(1);
    expect(
      rec
        .series('same-name#1')
        .attempts.find((row) => row.attemptKind === 'call' && row.retryLoop?.phase === 'attempt'),
    ).toMatchObject({ outcome: 'failed', effect: 'unknown' });
    expect(rec.series('same-name#1').decisions[0]).toMatchObject({ next: 'stop', effect: 'unknown' });
    expect(rec.slowest('same-name').every((ref) => ['stage', 'call'].includes(ref.attemptKind))).toBe(true);
  });
  it.each([{ maxRows: 0 }, { maxRows: 100001 }, { maxPending: 0 }, { exemplars: 101 }, { storeTimeoutMs: 0 }])(
    'rejects invalid limits without running an adapter',
    (options) => {
      expect(() => attempts(options)).toThrow(/invalid/);
    },
  );
});

it('records a paused leg distinctly from a fresh resumed leg without persisting pause payloads', async () => {
  const rec = attempts();
  const chart = flowChart('Seed', () => undefined, 'seed')
    .addPausableFunction(
      'Review',
      { execute: () => ({ privatePayload: 'SYNTHETIC-PAUSE-PAYLOAD' }), resume: () => undefined },
      'review',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(rec);
  await executor.run();
  expect([...rec.byRun().values()].map((run) => run.outcome)).toEqual(['paused']);
  expect(JSON.stringify(rec.toSnapshot())).not.toContain('SYNTHETIC-PAUSE-PAYLOAD');
  await executor.resume(executor.getCheckpoint()!, undefined);
  expect([...rec.byRun().values()].map((run) => run.outcome)).toEqual(['paused', 'ok']);
});
it('a malformed query is rejected before a store read and a rejected read exposes no adapter error text', async () => {
  let reads = 0;
  const rec = attempts({
    store: {
      append() {},
      read() {
        reads++;
        return Promise.reject(new Error('SECRET-READ'));
      },
    },
  });
  await expect(rec.aggregate({ since: 10, until: 1 })).rejects.toThrow(/invalid query/);
  expect(reads).toBe(0);
  await expect(rec.aggregate()).rejects.toThrow('attempts: store read failed');
  expect(reads).toBe(1);
  expect(rec.storage().pending).toBe(0);
});

it('rejects a stored logical verdict whose physical reference or target does not match the operation', async () => {
  const rows: AttemptRow[] = [];
  const store: AttemptStore = {
    append: (incoming) => {
      rows.push(...incoming);
    },
    read: async () => rows,
  };
  const rec = attempts({ store });
  rec.onAttempt(
    event(2, 0, 'run-1', {
      series: 'step#0@1.1',
      kind: 'call',
      target: 'pay',
      outcome: 'failed',
      category: 'network',
      next: 'stop',
      reason: 'exhausted',
      effect: 'unknown',
      retryLoop: { id: 'step', series: 'step#0', attempt: 1, of: 3, phase: 'attempt' },
    }),
  );
  rows.push({
    kind: 'decision',
    id: 'step',
    series: 'step#0',
    attempt: 1,
    of: 3,
    effect: 'unknown',
    reconciled: true,
    next: 'stop',
    reason: 'declined',
    runId: 'run-1',
    target: 'other',
    runtimeStageId: 'step-decide#2',
    attemptId: 'other#9@1' as never,
    startedAt: 1000,
  });
  const result = await rec.aggregate();
  expect(result.byTarget.get('pay')?.gaveUp).toBe(0);
  expect(result.storage).toMatchObject({ omittedRows: 1, incomplete: true });
});

it('never executes external store row or nested-loop accessors or coercion hooks', async () => {
  let touched = 0;
  const getter = Object.defineProperty({ kind: 'attempt' }, 'runId', {
    enumerable: true,
    get() {
      touched++;
      return 'run-1';
    },
  });
  const loopGetter = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      touched++;
      return 'step';
    },
  });
  const captured: AttemptRow[] = [];
  const live = attempts({
    store: {
      append: (rows) => {
        captured.push(...rows);
      },
      read: async () => [],
    },
  });
  live.onAttempt(event(1));
  const nested = { ...captured[0], retryLoop: loopGetter };
  const coercion = {
    ...captured[0],
    series: {
      [Symbol.toPrimitive]() {
        touched++;
        return 'step#0';
      },
    },
  };
  const rec = attempts({ store: { append() {}, read: async () => [getter, nested, coercion] as AttemptRow[] } });
  const result = await rec.aggregate();
  expect(touched).toBe(0);
  expect(result.byTarget.size).toBe(0);
  expect(result.storage).toMatchObject({ omittedRows: 3, incomplete: true });
});
it('discloses known reference-store truncation even when its row limit is lower than the recorder limit', async () => {
  const store = memoryStore({ maxRows: 1 });
  const rec = attempts({ store });
  rec.onRunStart({ traversalContext: ctx() });
  rec.onAttempt(event(1));
  rec.onRunEnd({ traversalContext: ctx() });
  const result = await rec.aggregate();
  expect(store.stats().omittedRows).toBe(2);
  expect(result.storage).toMatchObject({ omittedRows: 2, incomplete: true });
});
it('refuses zero exemplar capacity and gives every nonzero run aggregate physical evidence', () => {
  expect(() => attempts({ exemplars: 0 })).toThrow(/invalid exemplars/);
  const rec = attempts({ exemplars: 1 });
  rec.onAttempt(event(4));
  expect(rec.byRun().get('run-1')).toMatchObject({
    attempts: 1,
    exemplars: [{ id: 'step#0@1', runId: 'run-1', runtimeStageId: 'step#0' }],
  });
});

it.each(['attemptId', 'target', 'id', 'of'] as const)(
  'a mismatched stored decision %s cannot contribute a logical counter',
  async (field) => {
    const rows: AttemptRow[] = [];
    const rec = attempts({
      store: {
        append: (incoming) => {
          rows.push(...incoming);
        },
        read: async () => rows,
      },
    });
    rec.onAttempt(
      event(2, 0, 'run-1', {
        series: 'step#0@1.1',
        kind: 'call',
        target: 'pay',
        outcome: 'failed',
        category: 'network',
        next: 'stop',
        reason: 'exhausted',
        retryLoop: { id: 'step', series: 'step#0', attempt: 1, of: 3, phase: 'attempt' },
      }),
    );
    const decision = {
      kind: 'decision',
      id: 'step',
      series: 'step#0',
      attempt: 1,
      of: 3,
      effect: 'unknown',
      reconciled: true,
      next: 'stop',
      reason: 'declined',
      runId: 'run-1',
      target: 'pay',
      runtimeStageId: 'step-decide#2',
      attemptId: 'step#0@1.1@1',
      startedAt: 1000,
      [field]: field === 'of' ? 4 : 'other#9@1',
    };
    rows.push(decision as AttemptRow);
    const result = await rec.aggregate();
    expect(result.byTarget.get('pay')?.gaveUp).toBe(0);
    expect(result.storage).toMatchObject({ omittedRows: 1, incomplete: true });
  },
);
it('never executes a store array-index getter or a retention-stats getter', async () => {
  let touched = 0;
  const rows: AttemptRow[] = [];
  Object.defineProperty(rows, '0', {
    get() {
      touched++;
      return {};
    },
    enumerable: true,
  });
  const stats = Object.defineProperty({}, 'omittedRows', {
    get() {
      touched++;
      return 0;
    },
    enumerable: true,
  });
  const rec = attempts({
    store: { append() {}, read: async () => rows, stats: () => stats as { omittedRows: number } },
  });
  expect((await rec.aggregate()).storage).toMatchObject({ omittedRows: 1, incomplete: true });
  expect(touched).toBe(0);
});
