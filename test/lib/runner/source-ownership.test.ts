import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAttemptId } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { fileSink, readRecordFile } from '../../../src/sinks.js';
import { readStoredCapture } from '../../../src/trace.js';
import {
  ownershipChart as chart,
  resignOwnership as resign,
  savedOwnership as saved,
} from '../../helpers/sourceOwnership.js';

describe('native source ownership evidence', () => {
  it('records actual native invocations independently of reads, including zero-read executions', async () => {
    const { snapshot } = await saved();
    const sources = snapshot.readSources as any;
    expect(sources.version).toBe(2);
    expect(sources.ownership).toMatchObject({
      version: 1,
      runId: snapshot.runId,
      logAddress: snapshot.logAddress,
      segment: sources.record.segment,
      commits: sources.commits,
      status: 'captured',
      limitations: [],
    });
    expect(sources.ownership.executions).toEqual(
      snapshot.commitLog.map((commit, index) => ({
        runtimeStageId: commit.runtimeStageId,
        stateAddress: [],
        firstCommit: index,
        attemptIds: [buildAttemptId(commit.runtimeStageId, 1)],
      })),
    );
    expect(sources.record.occurrences).toHaveLength(1);
    expect(sources.record.occurrences[0].attemptId).toBe(buildAttemptId(snapshot.commitLog[1].runtimeStageId, 1));
    // Direct invocation facts do not invent timing, outcomes or full policy-attempt records.
    expect(snapshot.executionTree.attempts).toBeUndefined();
  });

  it('retains each real retry invocation while discarded reads keep their actual attempt identity', async () => {
    let tries = 0;
    const flow = flowChart<{ n: number }>(
      'Retry',
      (scope) => {
        const n = scope.n;
        if (++tries < 3) throw new Error('retry locally');
      },
      'retry',
    )
      .retry({ attempts: 3 })
      .build();
    const executor = new FlowChartExecutor(flow, { initialContext: { n: 7 }, readSources: true });
    await executor.run();
    const sources = executor.getSnapshot().readSources as any;
    const execution = sources.ownership.executions[0];
    const ids = [1, 2, 3].map((number) => buildAttemptId(execution.runtimeStageId, number));
    expect(execution.attemptIds).toEqual(ids);
    expect(sources.record.occurrences.map((row: any) => row.attemptId)).toEqual(ids);
  });

  it('persists the independently captured ownership with the same real file receipt and fingerprint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-owner-'));
    const sink = fileSink(join(directory, 'history.jsonl'));
    try {
      const executor = new FlowChartExecutor(chart(), {
        readSources: true,
        captureCoverage: true,
        sink: { adapter: sink, capture: sink },
      });
      await executor.run();
      expect(executor.getSnapshot().sink?.capture).toEqual({ status: 'acknowledged' });
      await sink.close();
      const result = await readStoredCapture(readRecordFile(sink.path).entries, {
        runId: executor.getSnapshot().runId!,
      });
      expect(result.status).toBe('acknowledged');
      expect(result.history?.readSources).toEqual(executor.getSnapshot().readSources);
      expect((result.history?.readSources as any).ownership.status).toBe('captured');
    } finally {
      await sink.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'missing owner',
    'wrong address',
    'foreign attempt',
    'missing row attempt',
    'wrong boundary',
    'wrong run',
    'duplicate owner',
    'missing ownership',
    'zero-read attempt removed',
    'native count removed',
  ])('refuses %s even when the storage editor recomputes the unkeyed fingerprint', async (attack) => {
    const { snapshot, entries } = await saved();
    const source = entries.find((entry) => entry.note === 'capture-history').data.readSources;
    // These mutations must target real produced metadata, rather than fabricate a fixture the producer never emits.
    expect(source.ownership.status).toBe('captured');
    if (attack === 'missing owner') source.ownership.executions.pop();
    if (attack === 'wrong address') source.ownership.executions[1].stateAddress = ['runs', 'other'];
    if (attack === 'foreign attempt') source.ownership.executions[1].attemptIds = [buildAttemptId('other#99', 1)];
    if (attack === 'missing row attempt') delete source.record.occurrences[0].attemptId;
    if (attack === 'wrong boundary') source.ownership.executions[1].firstCommit++;
    if (attack === 'wrong run') source.ownership.runId = 'other-run';
    if (attack === 'duplicate owner') source.ownership.executions.push(source.ownership.executions[0]);
    if (attack === 'missing ownership') delete source.ownership;
    if (attack === 'zero-read attempt removed') source.ownership.executions[2].attemptIds.pop();
    if (attack === 'native count removed')
      delete entries.find((entry) => entry.note === 'capture-history').data.executionTree.readSourceInvocations;
    await resign(entries);
    expect(await readStoredCapture(entries, { runId: snapshot.runId! })).toEqual({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it('withholds ownership and paths from a redacted export', async () => {
    const { executor } = await saved();
    const sources = executor.getSnapshot({ redact: true }).readSources as any;
    expect(sources.version).toBe(2);
    expect(sources.ownership).toMatchObject({ status: 'unknown', executions: [], limitations: ['redacted-export'] });
    expect(sources.record).toBeUndefined();
  });
});
