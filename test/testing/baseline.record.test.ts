import { commitValueAtWithBasis, readStoredRecord, stateAt } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { FlowChartExecutor, RLENarrativeFlowRecorder, WindowedNarrativeFlowRecorder } from '../../src/index.js';
import { askChart, dataChart, jsonCheckpoint, report, scenario } from './baseline.fixtures.js';

describe.each(['full', 'delta'] as const)('saved reader baseline: %s commits', (commitValues) => {
  it('preserves named values, reasons and the final fold through the existing record codec', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(dataChart(), { sink, commitValues });
    await executor.run();
    const live = executor.getSnapshot();
    const saved = readStoredRecord(JSON.parse(JSON.stringify(sink.entries))).root(live.runId);
    expect(saved).toBeDefined();
    expect(saved!.complete).toBe(true);
    const queries = ['present', 'deleted', 'never-written'];
    const rows = queries.map((key) => ({
      key,
      live: commitValueAtWithBasis(live.commitLog, live.commitLog.length - 1, key, { initialState: live.initialState }),
      saved: commitValueAtWithBasis(saved!.commitLog, saved!.commitLog.length - 1, key, {
        initialState: saved!.initialState,
      }),
    }));
    report('record.values.' + commitValues, 'comparison', { rows, complete: saved!.complete, gaps: saved!.gaps });
    for (const row of rows) expect(row.saved).toEqual(row.live);
    expect(rows[0].live.value).toBe(2);
    expect(rows[1].live.basis).toContain('deleted');
    expect(rows[2].live.basis).toContain('never-written');
    expect(stateAt(saved!.source(), saved!.commitLog.length - 1).state).toEqual(live.sharedState);
  });

  it('keeps missing and incomplete records explicitly distinct from successful empty evidence', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(dataChart(), { sink, commitValues });
    await executor.run();
    const id = executor.getSnapshot().runId;
    const noClose = sink.entries.filter((entry) => entry.kind !== 'closed');
    const partial = readStoredRecord(noClose).root(id);
    const absent = readStoredRecord([]).root(id);
    report('record.incomplete.' + commitValues, 'availability', {
      missingRoot: absent === undefined,
      partialComplete: partial?.complete,
      partialOutcome: partial?.outcome,
      keptCommits: partial?.commitLog.length,
    });
    expect(absent).toBeUndefined();
    expect(partial).toBeDefined();
    expect(partial!.complete).toBe(false);
  });

  it.each(['same', 'fresh'] as const)('selects the real log address on %s-executor resume', async (mode) => {
    const firstSink = memorySink();
    const first = new FlowChartExecutor(askChart(), { sink: firstSink, commitValues });
    await first.run();
    const before = first.getSnapshot();
    const checkpoint = jsonCheckpoint(first);
    const sink = mode === 'same' ? firstSink : memorySink();
    const executor = mode === 'same' ? first : new FlowChartExecutor(askChart(), { sink, commitValues });
    await executor.resume(checkpoint, 'accepted');
    const after = executor.getSnapshot();
    const address = mode === 'same' ? before.runId : after.runId;
    const saved = readStoredRecord(sink.entries).root(address);
    report('record.resume.' + mode + '.' + commitValues, 'lifecycle', {
      originalRunId: before.runId,
      resumedRunId: after.runId,
      address: after.logAddress,
      opened: saved?.meta.opened,
      closed: saved?.meta.closed,
      notes: saved?.notes,
    });
    expect(after.runId).not.toBe(before.runId);
    expect(saved).toBeDefined();
    expect(saved!.complete).toBe(true);
    expect(stateAt(saved!.source(), saved!.commitLog.length - 1).state).toEqual(after.sharedState);
    if (mode === 'same') {
      expect(sink.entries.filter((entry) => entry.kind === 'opened')).toHaveLength(1);
      expect(saved!.notes.map((note) => note.kind)).toContain('resume');
    } else {
      expect(saved!.meta.opened).toMatchObject({ resumedFrom: before.runId });
      expect(saved!.initialState).toEqual(checkpoint.sharedState);
    }
  });

  it('keeps two hidden-value variants identical on the named permitted query', async () => {
    const observations = [];
    for (const hidden of ['fixture-hidden-a', 'fixture-hidden-b']) {
      const sink = memorySink();
      const executor = new FlowChartExecutor(dataChart(hidden), { sink, commitValues });
      executor.setRedactionPolicy({ keys: ['secret'] });
      await executor.run();
      const live = executor.getSnapshot({ redact: true });
      const saved = readStoredRecord(sink.entries).root(live.runId)!;
      observations.push({
        publicValue: commitValueAtWithBasis(saved.commitLog, saved.commitLog.length - 1, 'present', {
          initialState: saved.initialState,
        }),
        hiddenAnswer: commitValueAtWithBasis(saved.commitLog, saved.commitLog.length - 1, 'secret', {
          initialState: saved.initialState,
        }),
      });
    }
    report('record.hidden-pair.' + commitValues, 'comparison', observations);
    expect(observations[0]).toEqual(observations[1]);
  });
});

describe.each(['window', 'rle'] as const)('named narrative availability: %s', (mode) => {
  it('retains state parity while explicitly disclosing the unavailable saved sentence query', async () => {
    const sink = memorySink();
    const recorder = mode === 'window' ? new WindowedNarrativeFlowRecorder(1, 1) : new RLENarrativeFlowRecorder();
    const executor = new FlowChartExecutor(scenario('direct', 'handler', 10), { sink });
    executor.attachFlowRecorder(recorder);
    await executor.run();
    const live = executor.getSnapshot();
    const saved = readStoredRecord(sink.entries).root(live.runId)!;
    const sentences = recorder.getSentences();
    const persistedRecorder = live.recorders?.find((row) => row.id === recorder.id);
    report('record.narrative.' + mode, 'query-unavailable', {
      query: mode + '.getSentences',
      liveSentences: sentences,
      snapshotRecorderPresent: persistedRecorder !== undefined,
      savedQueryAvailable: typeof Reflect.get(saved, 'getSentences') === 'function',
      reason: 'plain-record-has-no-narrative-recorder-snapshot',
      stateQueryStillMeasured: true,
      ...(recorder instanceof WindowedNarrativeFlowRecorder
        ? { liveSuppressedCount: recorder.getSuppressedCount() }
        : {}),
    });
    expect(sentences.length).toBeGreaterThan(0);
    expect(persistedRecorder).toBeUndefined();
    expect(typeof Reflect.get(saved, 'getSentences')).toBe('undefined');
    expect(stateAt(saved.source(), saved.commitLog.length - 1).state).toEqual(live.sharedState);
  });
});
