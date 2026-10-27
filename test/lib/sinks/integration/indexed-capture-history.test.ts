import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readStoredRecord } from 'foottrace';
import { afterAll, describe, expect, it } from 'vitest';

import { FlowChartExecutor } from '../../../../src/index.js';
import { fileSink, openIndexedRecordFile } from '../../../../src/sinks.js';
import { controlDepRecorder, readStoredCapture } from '../../../../src/trace.js';
import { historyChart } from '../../../helpers/storedCapture.js';

const dir = mkdtempSync(join(tmpdir(), 'fp-indexed-capture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('indexed bytes retain canonical history admission', () => {
  it.each([false, true])('does not manufacture a storage receipt (acknowledge=%s)', async (acknowledge) => {
    const path = join(dir, `history-${acknowledge}.jsonl`);
    const sink = fileSink(path);
    const first = new FlowChartExecutor(historyChart(), {
      captureCoverage: true,
      writeProvenance: 'reads-prefix',
      sink: acknowledge ? { adapter: sink, capture: sink } : sink,
    });
    first.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    let firstRun: string;
    try {
      await first.run();
      firstRun = first.getSnapshot().runId;
      const unrelated = new FlowChartExecutor(historyChart(), { sink });
      await unrelated.run();
    } finally {
      await sink.close();
    }
    const address = { logRunId: firstRun!, drillPath: [] };
    const opened = await openIndexedRecordFile(path, { allowedScopes: [address] });
    if (opened.status !== 'ready') throw Error(`Index refused: ${opened.reason}`);
    try {
      const loaded = await opened.reader.readScope(address);
      if (loaded.status !== 'loaded') throw Error(`Scope refused: ${loaded.reason}`);
      const record = readStoredRecord(loaded.entries);
      expect(record.logs.size).toBe(1);
      expect(record.root(firstRun!)?.complete).toBe(true);
      const capture = await readStoredCapture(loaded.entries, { runId: firstRun! });
      expect(capture.status).toBe(acknowledge ? 'acknowledged' : 'unknown');
      if (!acknowledge) expect(capture).toMatchObject({ reason: 'receipt-missing' });
      else if (capture.status === 'acknowledged') {
        expect(capture.history.capture.version).toBe(1);
        expect(capture.history.capture.persistence).toBe('memory-only');
        expect(capture.history.runId).toBe(firstRun!);
      }
      expect(loaded.bytesRead).toBeLessThan(opened.reader.stats.preparationBytes);
    } finally {
      await opened.reader.close();
    }
  });
});
