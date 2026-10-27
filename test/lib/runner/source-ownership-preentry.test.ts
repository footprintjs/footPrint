import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAttemptId } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { ScopeFacade } from '../../../src/lib/scope/ScopeFacade.js';
import { fileSink, readRecordFile } from '../../../src/sinks.js';
import { readStoredCapture } from '../../../src/trace.js';

const quiet = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

describe('source ownership begins at actual function entry', () => {
  it.each([false, true])(
    'saves pre-entry factory failure as unknown without lending attempt IDs (retry=%s)',
    async (retry) => {
      const directory = mkdtempSync(join(tmpdir(), 'source-preentry-'));
      const sink = fileSink(join(directory, 'history.jsonl'));
      let entries = 0;
      const preparationAttempts: (number | undefined)[] = [];
      const failure = new Error('Local scope preparation failed');
      const builder = flowChart(
        'Never entered',
        () => {
          entries++;
        },
        'never',
      );
      if (retry) builder.retry({ attempts: 2 });
      const executor = new FlowChartExecutor(builder.setLogger(quiet).build(), {
        initialContext: { n: 4 },
        readSources: true,
        captureCoverage: true,
        sink: { adapter: sink, capture: sink },
        scopeFactory(context) {
          preparationAttempts.push(context.attempt?.attempt);
          expect(context.getValue([], 'n')).toBe(4);
          throw failure;
        },
      });
      try {
        await expect(executor.run()).rejects.toBe(failure);
        const snapshot = executor.getSnapshot();
        const source = snapshot.readSources!;
        expect(entries).toBe(0);
        expect(preparationAttempts).toEqual(retry ? [1, 2] : [undefined]);
        expect(snapshot.executionTree.readSourceInvocations).toBe(0);
        expect(source.version).toBe(2);
        if (source.version !== 2) throw Error('Expected the new producer envelope');
        expect(source.ownership).toMatchObject({ status: 'unknown', limitations: ['attempt-unavailable'] });
        expect(source.ownership.executions[0].attemptIds).toEqual([]);
        expect(source.record!.occurrences).toHaveLength(retry ? 2 : 1);
        expect(
          source.record!.occurrences.every((row) => row.attemptId === undefined && row.attemptStatus === 'unavailable'),
        ).toBe(true);
        // The real retry context and attempt records remain available; they do not prove function entry.
        if (retry) expect(snapshot.executionTree.attempts!.map((attempt) => attempt.attempt)).toEqual([1, 2]);
        expect(snapshot.sink?.capture).toEqual({ status: 'acknowledged' });
        await sink.close();
        const restored = await readStoredCapture(readRecordFile(sink.path).entries, { runId: snapshot.runId! });
        expect(restored.status).toBe('acknowledged');
        expect(restored.history!.readSources).toEqual(source);
        expect(restored.history!.capture.boundary.status).toBe('failed');
      } finally {
        await sink.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('withholds a preparation read while granting an ID only to the following actual function call', async () => {
    let entered = 0;
    const chart = flowChart<void, ScopeFacade>(
      'Read',
      (scope) => {
        entered++;
        expect(scope.getValue('n')).toBe(4);
      },
      'read',
    )
      .retry({ attempts: 2 })
      .setLogger(quiet)
      .build();
    const executor = new FlowChartExecutor(chart, {
      initialContext: { n: 4 },
      readSources: true,
      scopeFactory(context, name, input, env) {
        expect(context.attempt?.attempt).toBe(1);
        expect(context.getValue([], 'n')).toBe(4);
        return new ScopeFacade(context, name, input, env);
      },
    });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const source = snapshot.readSources!;
    expect(entered).toBe(1);
    expect(source.version).toBe(2);
    if (source.version !== 2) throw Error('Expected the new producer envelope');
    const owner = source.ownership.executions[0];
    expect(snapshot.executionTree.readSourceInvocations).toBe(1);
    expect(owner.attemptIds).toEqual([buildAttemptId(owner.runtimeStageId, 1)]);
    expect(source.record!.occurrences.map((row) => row.attemptId)).toEqual([undefined, owner.attemptIds[0]]);
    expect(source.ownership).toMatchObject({ status: 'unknown', limitations: ['attempt-unavailable'] });
  });
});
