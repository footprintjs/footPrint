import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildSync } from 'esbuild';
import { readStoredRecord, stateAt } from 'foottrace';
import { afterAll, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
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

it.each(['read', 'write', 'clear'] as const)(
  'preserves an undefined %s event through a real fsynced file',
  async (kind) => {
    const sink = fileSink(join(dir, 'absent-' + kind + '.jsonl'));
    try {
      const ex = new FlowChartExecutor(
        flowChart<{ count?: number; total?: number }>(
          'Work',
          (scope) => {
            if (kind === 'read') {
              const seen = scope.count;
              scope.total = (seen ?? 0) + 1;
            } else {
              scope.count = undefined;
              scope.total = 1;
            }
          },
          'work',
        ).build(),
        {
          captureCoverage: true,
          readTracking: 'full',
          ...(kind === 'clear' && { initialContext: { count: 2 } }),
          sink: { adapter: sink, capture: sink },
        },
      );
      await ex.run();
      const channel = kind === 'read' ? 'stageReads' : 'stageWrites';
      expect(Object.hasOwn(ex.getSnapshot().executionTree[channel]!, 'count')).toBe(true);
      expect(ex.getSnapshot().sink!.capture!.status).toBe('acknowledged');
      const { entries, unreadable } = readRecordFile(sink.path);
      expect(unreadable).toEqual([]);
      const saved = await readStoredCapture(entries, { runId: ex.getSnapshot().runId });
      expect(saved.status).toBe('acknowledged');
      expect(saved.history!.absent).toContainEqual(['executionTree', channel, 'count']);
      expect(Object.isFrozen(saved.history!.absent)).toBe(true);
      expect(Object.isFrozen(saved.history!.absent![0])).toBe(true);
      if (kind === 'clear') {
        expect(saved.history!.initialState!.count).toBe(2);
        const state = stateAt(saved.history, saved.history!.commitLog.length - 1).state;
        expect(Object.hasOwn(state!, 'count')).toBe(true);
        expect(state!.count).toBeUndefined();
      }
    } finally {
      await sink.close();
    }
  },
);
