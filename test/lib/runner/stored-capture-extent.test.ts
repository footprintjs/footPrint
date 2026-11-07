import { readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { historyDigest, historyEvidence } from '../../../src/lib/capture/historyData.js';
import { readStoredCapture } from '../../../src/trace.js';

const fixture = async () => {
  const sink = memorySink();
  const ex = new FlowChartExecutor(flowChart('Work', () => undefined, 'work').build(), {
    captureCoverage: true,
    captureExtent: true,
    sink: { adapter: sink, capture: { acknowledge: async (r) => ({ ...r, durability: 'durable' }) } },
  });
  await ex.run();
  return { entries: JSON.parse(JSON.stringify(sink.entries)) as any[], runId: ex.getSnapshot().runId };
};

async function rewriteDigest(entries: any[], runId: string): Promise<void> {
  const payload = entries.find((entry) => entry.note === 'capture-history').data;
  const log = readStoredRecord(entries).root(runId)!;
  const digest = await historyDigest({
    evidence: historyEvidence(payload),
    record: { commitLog: log.commitLog, ...(log.initialState !== undefined && { initialState: log.initialState }) },
  });
  payload.target.digest = digest;
  entries.find((entry) => entry.note === 'capture-receipt').data.digest = digest;
}

it('binds the sidecar to the exact evidence digest', async () => {
  const { entries, runId } = await fixture();
  const extent = entries.find((entry) => entry.note === 'capture-history').data.captureExtent;
  extent.invocations.started++;
  extent.invocations.settled++;
  expect(await readStoredCapture(entries, { runId })).toEqual({ status: 'unknown', reason: 'evidence-mismatch' });
});

it.each(['closed', 'extent', 'owner', 'cut', 'reason', 'counts', 'extra'])(
  'refuses coherent-digest %s sidecar forgery',
  async (mutation) => {
    const { entries, runId } = await fixture();
    const extent = entries.find((entry) => entry.note === 'capture-history').data.captureExtent;
    if (mutation === 'closed') extent.status = 'closed';
    if (mutation === 'extent') extent.extentId = 'foreign';
    if (mutation === 'owner') extent.runId = 'foreign';
    if (mutation === 'cut') extent.commits.to++;
    if (mutation === 'reason') extent.limitations.push('assured');
    if (mutation === 'counts') extent.invocations.pending++;
    if (mutation === 'extra') extent.complete = true;
    await rewriteDigest(entries, runId);
    expect(await readStoredCapture(entries, { runId })).toEqual({
      status: 'unknown',
      reason: 'extent-evidence-refused',
    });
  },
);

it('does not treat a coherent inert rewrite as authenticated producer evidence', async () => {
  const { entries, runId } = await fixture();
  const extent = entries.find((entry) => entry.note === 'capture-history').data.captureExtent;
  extent.invocations.started++;
  extent.invocations.settled++;
  await rewriteDigest(entries, runId);
  const result = await readStoredCapture(entries, { runId });
  expect(result.status).toBe('acknowledged');
  expect(result.history?.captureExtent?.status).toBe('unverified');
  expect(result.history?.captureExtent?.limitations).toContain('closure-not-attested');
});

it('refuses sidecar accessors before invoking hidden stored code', async () => {
  const { entries, runId } = await fixture();
  const extent = entries.find((entry) => entry.note === 'capture-history').data.captureExtent;
  const getter = vi.fn(() => 'closed');
  Object.defineProperty(extent, 'status', { enumerable: true, get: getter });
  expect(await readStoredCapture(entries, { runId })).toMatchObject({ status: 'unknown' });
  expect(getter).not.toHaveBeenCalled();
});
