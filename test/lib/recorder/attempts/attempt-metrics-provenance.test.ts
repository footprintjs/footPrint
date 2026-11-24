import { describe, expect, it } from 'vitest';

import type { FlowAttemptEvent } from '../../../../src/index.js';
import { type AttemptRow, type PhysicalAttemptRow, attempts, memoryStore } from '../../../../src/recorders.js';

const target = 'tools.lookup';
const provenanceAttribute = 'footprint.attempt.provenance';

function observed(ordinal: number, changes: Partial<FlowAttemptEvent['record']> = {}): FlowAttemptEvent {
  return {
    stageName: 'Dispatch',
    stageId: 'dispatch',
    traversalContext: {
      runId: 'run-1',
      stageId: 'dispatch',
      runtimeStageId: 'dispatch#0',
      stageName: 'Dispatch',
      depth: 0,
    },
    record: {
      series: `dispatch#0@1.${ordinal}`,
      kind: 'observed',
      target,
      attempt: 1,
      of: 1,
      startedAt: 1000 + ordinal,
      durationMs: ordinal * 10,
      outcome: 'failed',
      category: 'timeout',
      next: 'done',
      reason: 'answered',
      decision: { rules: [], chosen: 'done', default: 'done' },
      ...changes,
    },
  };
}

function nativeFailures(recorder: ReturnType<typeof attempts>): void {
  recorder.onAttempt(observed(1, { provenance: 'declared' }));
  recorder.onAttempt(observed(2, { of: 2, next: 'retry', reason: 'retryable' }));
  recorder.onAttempt(observed(2, { attempt: 2, of: 2, next: 'stop', reason: 'exhausted' }));
}

function provenanceCounts(output: ReturnType<ReturnType<typeof attempts>['toOTel']>) {
  const metrics = output.resourceMetrics[0].scopeMetrics[0].metrics;
  const counts = metrics.find((metric) => metric.name === 'footprint.attempt.count')?.sum?.dataPoints ?? [];
  return Object.fromEntries(
    counts.map((point) => [
      point.attributes.find((item) => item.key === provenanceAttribute)?.value.stringValue,
      point.asDouble,
    ]),
  );
}

describe('attempt metric failure provenance', () => {
  it('counts both origins while keeping the declared failure out of retry and give-up metrics', () => {
    const recorder = attempts();
    nativeFailures(recorder);
    const stats = recorder.byTarget().get(target);
    expect(stats).toMatchObject({
      count: 3,
      byOutcome: { failed: 3, timeout: 0 },
      byCategory: { timeout: 3 },
      byCategoryProvenance: { timeout: { declared: 1, classified: 2, unknown: 0 } },
      retries: 1,
      seriesRetried: 1,
      gaveUp: 1,
    });
    expect(stats?.exemplars.gaveUp.map((ref) => ref.id)).toEqual(['dispatch#0@1.2@2']);
    expect(recorder.series('dispatch#0@1.1').attempts[0]).toMatchObject({
      outcome: 'failed',
      category: 'timeout',
      provenance: 'declared',
    });
    expect(provenanceCounts(recorder.toOTel())).toEqual({ declared: 1, classified: 2 });
  });

  it('retains exact origins after reopening, with missing legacy origin reported as unknown', async () => {
    const store = memoryStore();
    const writer = attempts({ store });
    const run = { traversalContext: observed(1).traversalContext };
    writer.onRunStart(run);
    nativeFailures(writer);
    writer.onRunEnd(run);
    const rows = await store.read({});
    const physical = rows.filter((row): row is PhysicalAttemptRow => row.kind === 'attempt');
    expect(physical.map((row) => row.provenance)).toEqual(['declared', 'classified', 'classified']);
    const latest = physical.find((row) => row.id === 'dispatch#0@1.2@2');
    if (!latest) throw new Error('Expected a stored classified failure');
    const legacy = { ...latest, runId: 'legacy' };
    delete legacy.provenance;
    store.append([legacy, legacy]);

    const reader = attempts({ store });
    expect(reader.byTarget().size).toBe(0);
    const summary = await reader.aggregate();
    expect(summary.storage.incomplete).toBe(false);
    expect(summary.byTarget.get(target)).toMatchObject({
      count: 4,
      retries: 1,
      gaveUp: 2,
      byCategoryProvenance: { timeout: { declared: 1, classified: 2, unknown: 1 } },
    });
    expect(summary.byRun.get('legacy')?.exemplars[0]).toMatchObject({ category: 'timeout', provenance: 'unknown' });
    expect(summary.byRun.get('run-1')).toMatchObject({ outcome: 'ok', attempts: 3, retries: 1, gaveUp: 1 });
    const { metrics: exported, storage } = await reader.toStoredOTel();
    expect(storage).toEqual(summary.storage);
    expect(provenanceCounts(exported)).toEqual({ declared: 1, classified: 2, unknown: 1 });
    expect(provenanceCounts((await reader.toStoredOTel({ runId: 'legacy' })).metrics)).toEqual({ unknown: 1 });
    const histogram = exported.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (metric) => metric.name === 'footprint.attempt.duration',
    )?.histogram;
    expect(histogram?.dataPoints).toHaveLength(3);
    for (const point of histogram?.dataPoints ?? []) {
      const source = point.attributes.find((item) => item.key === provenanceAttribute);
      expect(source).toBeDefined();
      for (const exemplar of point.exemplars) expect(exemplar.filteredAttributes).toContainEqual(source);
    }
  });

  it('omits unrecognized provenance and contradictory stored claims without evaluating accessors', async () => {
    const recorder = attempts();
    recorder.onAttempt(observed(1, { provenance: 'declared' }));
    const native = recorder.series('dispatch#0@1.1').attempts[0];
    if (!native) throw new Error('Expected a declared dispatch row');
    let read = false;
    const accessor = Object.defineProperty({ ...native }, 'provenance', {
      get() {
        read = true;
        return 'declared';
      },
    });
    const invalid = [
      { ...native, provenance: 'provider' },
      { ...native, category: undefined },
      { ...native, outcome: 'timeout' },
      { ...native, next: 'retry', reason: 'retryable' },
      { ...native, attemptKind: 'call' },
      { ...native, effect: 'unknown' },
      { ...native, provenance: 'classified', outcome: 'ok' },
      { ...native, provenance: 'unknown', category: undefined },
      accessor,
    ];
    const unsupportedDecision: AttemptRow = {
      kind: 'decision',
      id: 'retry-loop',
      series: 'dispatch#0',
      attempt: 1,
      of: 1,
      effect: 'unknown',
      reconciled: false,
      next: 'stop',
      reason: 'exhausted',
      runId: native.runId,
      target: native.target,
      runtimeStageId: native.runtimeStageId,
      attemptId: native.id,
      startedAt: native.startedAt,
    };
    const reader = attempts({
      store: { append() {}, read: async () => [native, ...invalid, unsupportedDecision] as AttemptRow[] },
    });
    const summary = await reader.aggregate();
    expect(summary.storage).toMatchObject({ incomplete: true, omittedRows: invalid.length + 1 });
    expect(summary.byTarget.get(target)).toMatchObject({ count: 1, retries: 0, gaveUp: 0 });
    const { metrics, storage } = await reader.toStoredOTel();
    expect(storage).toEqual(summary.storage);
    expect(provenanceCounts(metrics)).toEqual({ declared: 1 });
    expect(read).toBe(false);
  });
});
