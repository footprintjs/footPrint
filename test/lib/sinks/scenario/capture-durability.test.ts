import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildSync } from 'esbuild';
import { readStoredRecord } from 'foottrace';
import { afterAll, expect, it } from 'vitest';

import { FlowChartExecutor } from '../../../../src/index.js';
import { fileSink, readRecordFile } from '../../../../src/sinks.js';
import { controlDepRecorder, readStoredCapture } from '../../../../src/trace.js';
import { minimalChildEnv } from '../../../helpers/childProcessEnv.js';
import { historyChart } from '../../../helpers/storedCapture.js';

const dir = mkdtempSync(join(tmpdir(), 'fp-capture-durable-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('acknowledges fsynced evidence using the explicit local file capability', async () => {
  const sink = fileSink(join(dir, 'complete.jsonl'));
  try {
    const ex = new FlowChartExecutor(historyChart(), { captureCoverage: true, sink: { adapter: sink, capture: sink } });
    ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    await ex.run();
    const { entries, unreadable } = readRecordFile(sink.path);
    expect(unreadable).toEqual([]);
    const history = await readStoredCapture(entries, { runId: ex.getSnapshot().runId });
    expect(history.status).toBe('acknowledged');
    expect(history.history!.capture).toEqual(ex.getSnapshot().capture);
  } finally {
    await sink.close();
  }
});

it('a real killed writer with a closed log but no receipt still has unknown durable capture', async () => {
  const file = join(dir, 'killed.jsonl');
  const child = join(dir, 'child.cjs');
  buildSync({
    entryPoints: [resolve(__dirname, '../fixtures/killed-before-capture-receipt.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: child,
    logLevel: 'silent',
  });
  const processResult = spawnSync(process.execPath, [child, file], {
    encoding: 'utf8',
    timeout: 10_000,
    env: minimalChildEnv(process.env),
  });
  expect(processResult.signal).toBe('SIGKILL');
  const { entries, unreadable } = readRecordFile(file);
  expect(unreadable).toEqual([]);
  const stored = readStoredRecord(entries);
  const root = [...stored.logs.values()][0]!;
  expect(root.complete).toBe(true);
  expect(root.notes.some((n) => n.kind === 'capture-history')).toBe(true);
  expect(await readStoredCapture(entries, { runId: root.address.logRunId })).toMatchObject({
    status: 'unknown',
    reason: 'receipt-missing',
  });
});
