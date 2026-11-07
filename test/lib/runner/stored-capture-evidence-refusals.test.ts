import { expect, it } from 'vitest';

import { historyDigest, historyEvidence } from '../../../src/lib/capture/historyData.js';
import { readStoredCapture } from '../../../src/trace.js';
import { savedFixture } from '../../helpers/storedCapture.js';

// An integrity hash has no secret. Recomputing it must not substitute for retained evidence.
async function resign(entries: Awaited<ReturnType<typeof savedFixture>>['entries']): Promise<void> {
  const payload = entries.find((entry) => entry.note === 'capture-history').data;
  const opened = entries.find((entry) => entry.kind === 'opened');
  payload.target.digest = await historyDigest({
    evidence: historyEvidence(payload),
    record: {
      commitLog: entries.filter((entry) => entry.kind === 'commit').map((entry) => entry.bundle),
      ...(opened.initialState !== undefined && { initialState: opened.initialState }),
    },
  });
  entries.find((entry) => entry.note === 'capture-receipt').data.digest = payload.target.digest;
}

it.each(['missing', 'null', 'array'])('withholds acknowledged capture when its execution tree is %s', async (kind) => {
  const { entries, runId } = await savedFixture();
  expect((await readStoredCapture(entries, { runId })).status).toBe('acknowledged');
  const payload = entries.find((entry) => entry.note === 'capture-history').data;
  expect(payload.capture.version).toBe(1);
  if (kind === 'missing') delete payload.executionTree;
  else payload.executionTree = kind === 'null' ? null : [];
  await resign(entries);
  expect(await readStoredCapture(entries, { runId })).toEqual({ status: 'unknown', reason: 'evidence-missing' });
});

it.each(['missing', 'empty', 'foreign-run', 'not-captured'])(
  'withholds a captured control claim when retained recorder evidence is %s',
  async (kind) => {
    const { entries, runId } = await savedFixture();
    expect((await readStoredCapture(entries, { runId })).status).toBe('acknowledged');
    const payload = entries.find((entry) => entry.note === 'capture-history').data;
    expect(payload.capture.channels.control).toBe('captured');
    if (kind === 'missing') delete payload.recorders;
    else if (kind === 'empty') payload.recorders = [];
    else {
      const recorder = payload.recorders.find((row: { capture?: { runId: string } }) => row.capture?.runId === runId);
      expect(recorder).toBeDefined();
      if (kind === 'foreign-run') recorder.capture.runId = 'unrelated-run';
      else recorder.capture.control = 'unknown';
    }
    await resign(entries);
    expect(await readStoredCapture(entries, { runId })).toEqual({
      status: 'unknown',
      reason: 'recorder-evidence-missing',
    });
  },
);
