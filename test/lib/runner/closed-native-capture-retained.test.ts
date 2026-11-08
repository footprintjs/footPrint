import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { historyDigest, historyEvidence } from '../../../src/lib/capture/historyData.js';
import { readStoredCapture } from '../../../src/trace.js';

it.each(['empty-tree', 'ghost-stage', 'wrong-attempt', 'cut-count', 'missing-primary-commit'])(
  'refuses %s after recomputing the exact checksum',
  async (fault) => {
    const adapter = memorySink();
    const original = new Error('original');
    const ex = new FlowChartExecutor(
      flowChart('Seed', () => undefined, 'seed')
        .addFunction(
          'Fail',
          () => {
            throw original;
          },
          'fail',
        )
        .build(),
      {
        captureCoverage: true,
        captureExtent: true,
        captureClosure: true,
        sink: { adapter, capture: { acknowledge: async (t) => ({ ...t, durability: 'durable' }) } },
      },
    );
    await expect(ex.run()).rejects.toBe(original);
    const entries = JSON.parse(JSON.stringify(adapter.entries));
    const evidence = entries.find((e: any) => e.note === 'capture-history').data;
    if (fault === 'empty-tree') evidence.executionTree = {};
    if (fault === 'ghost-stage') {
      evidence.closure.selectedFailure.runtimeStageId = 'ghost#999';
      evidence.closure.selectedFailure.attemptId = 'ghost#999@1';
      evidence.capture.boundary.failure.stage.runtimeStageId = 'ghost#999';
    }
    if (fault === 'wrong-attempt') evidence.closure.selectedFailure.attemptId = 'fail#1@2';
    if (fault === 'cut-count') delete evidence.executionTree.next.nativeInvocations;
    const cut = ex.getClosedCapture();
    expect(cut.status).toBe('closed');
    if (cut.status !== 'closed') throw new Error('fixture');
    const log = JSON.parse(JSON.stringify(cut.record.commitLog));
    if (fault === 'missing-primary-commit') {
      log[1].phase = 'repeat';
      const commitEntries = entries.filter((e: any) => e.kind === 'commit');
      // The transport entry is named by the record writer, not reconstructed by this test.
      const entry = commitEntries[1];
      if (Object.hasOwn(entry, 'bundle')) entry.bundle.phase = 'repeat';
      else if (Object.hasOwn(entry, 'commit')) entry.commit.phase = 'repeat';
      else throw new Error('unexpected test record entry');
    }
    const digest = await historyDigest({
      evidence: historyEvidence(evidence),
      record: {
        commitLog: log,
        ...(cut.record.initialState !== undefined && { initialState: cut.record.initialState }),
      },
    });
    evidence.target.digest = digest;
    entries.find((e: any) => e.note === 'capture-receipt').data.digest = digest;
    expect(await readStoredCapture(entries, { runId: ex.getSnapshot().runId })).toEqual({
      status: 'unknown',
      reason: 'closure-evidence-refused',
    });
  },
);
