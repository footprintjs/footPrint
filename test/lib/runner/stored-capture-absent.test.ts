import { readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { historyDigest } from '../../../src/lib/capture/historyData.js';
import { readStoredCapture } from '../../../src/trace.js';

async function fixture(redact = false) {
  const sink = memorySink();
  const ex = new FlowChartExecutor(
    flowChart<{ count?: number; total?: number }>(
      'Work',
      (scope) => {
        scope.total = scope.count ?? 0;
        scope.count = undefined;
      },
      'work',
    ).build(),
    {
      captureCoverage: true,
      sink: {
        adapter: sink,
        capture: {
          acknowledge: async (target) => ({ ...target, durability: 'durable' }),
        },
      },
    },
  );
  if (redact) ex.setRedactionPolicy({ keys: ['count'] });
  await ex.run();
  return { entries: JSON.parse(JSON.stringify(sink.entries)) as any[], runId: ex.getSnapshot().runId };
}

async function rehash(entries: any[], runId: string) {
  const log = readStoredRecord(entries).root(runId)!;
  const payload = entries.find((e) => e.note === 'capture-history').data;
  const body = {
    capture: payload.capture,
    executionTree: payload.executionTree,
    ...(payload.recorders !== undefined && { recorders: payload.recorders }),
    ...(payload.absent !== undefined && { absent: payload.absent }),
  };
  const basis = { commitLog: log.commitLog, ...(log.initialState !== undefined && { initialState: log.initialState }) };
  payload.target.digest = await historyDigest({ evidence: body, record: basis });
  entries.find((e) => e.note === 'capture-receipt').data.digest = payload.target.digest;
}

it('returns detached immutable absent observations through JSON, without claiming exact read sources', async () => {
  const { entries, runId } = await fixture();
  const result = await readStoredCapture(entries, { runId });
  expect(result.status).toBe('acknowledged');
  expect(result.history!.absent).toEqual([
    ['executionTree', 'stageReads', 'count'],
    ['executionTree', 'stageWrites', 'count'],
  ]);
  expect(result.history!.capture.channels.readSources).toBe('not-collected');
  const payload = entries.find((e) => e.note === 'capture-history').data;
  payload.absent[0][2] = 'tampered';
  expect(result.history!.absent![0]![2]).toBe('count');
  expect(Object.isFrozen(result.history!.absent)).toBe(true);
});

it.each(['removed', 'changed', 'added'])(
  'fingerprints absent observations: %s marker refuses admission',
  async (kind) => {
    const { entries, runId } = await fixture();
    const payload = entries.find((e) => e.note === 'capture-history').data;
    if (kind === 'removed') delete payload.absent;
    else if (kind === 'changed') payload.absent[0][2] = 'other';
    else payload.absent.push(['executionTree', 'stageWrites', 'other']);
    expect(await readStoredCapture(entries, { runId })).toEqual({ status: 'unknown', reason: 'evidence-mismatch' });
  },
);

it.each(['duplicate', 'reordered', 'out-of-scope', 'present', 'missing-map', 'wrong-type', 'too-many'])(
  'refuses rehashed %s absent evidence instead of promoting it to captured',
  async (kind) => {
    const { entries, runId } = await fixture();
    const payload = entries.find((e) => e.note === 'capture-history').data;
    if (kind === 'duplicate') payload.absent.push(payload.absent[0]);
    if (kind === 'reordered') payload.absent.reverse();
    if (kind === 'out-of-scope') payload.absent = [['recorders', 'stageReads', 'count']];
    if (kind === 'present') payload.absent = [['executionTree', 'stageWrites', 'total']];
    if (kind === 'missing-map') payload.absent = [['executionTree', 'next', 'stageReads', 'count']];
    if (kind === 'wrong-type') payload.absent = 'count';
    if (kind === 'too-many') payload.absent = Array(4097).fill(payload.absent[0]);
    await rehash(entries, runId);
    expect(await readStoredCapture(entries, { runId })).toEqual({
      status: 'unknown',
      reason: 'absent-evidence-refused',
    });
  },
);

it('collects after redaction, with no marker for values replaced by the served policy', async () => {
  const { entries, runId } = await fixture(true);
  expect(entries.find((e) => e.note === 'capture-history').data).not.toHaveProperty('absent');
  expect((await readStoredCapture(entries, { runId })).status).toBe('acknowledged');
});

it('never executes an absent-list accessor on reload', async () => {
  const { entries, runId } = await fixture();
  let calls = 0;
  Object.defineProperty(entries.find((e) => e.note === 'capture-history').data, 'absent', {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  expect((await readStoredCapture(entries, { runId })).status).toBe('unknown');
  expect(calls).toBe(0);
});
