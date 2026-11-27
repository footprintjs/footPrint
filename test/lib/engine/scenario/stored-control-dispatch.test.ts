import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRunEvidence, readStoredRecord } from 'foottrace';
import { couldHaveChanged, type SavedSkippedChartAuthority, type TrustedSavedChartBinding } from 'foottrace/cause';
import { memorySink } from 'foottrace/write';
import { afterAll, describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder/index.js';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode.js';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser.js';
import type { StageFunction } from '../../../../src/lib/engine/types.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';
import { runPolicy } from '../../../../src/lib/memory/runPolicy.js';
import { canBindStoredControl, installStoredControl } from '../../../../src/lib/memory/storedControlEvidence.js';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime.js';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade.js';
import { indexedFileSink, openPublishedRecordFile } from '../../../../src/sinks.js';
import { FlowChartExecutor } from '../../../../src/index.js';
import {
  declareSkippedWriterPaths,
  liveSkippedChartOf,
  skippedWriterCaptureOptions,
} from '../../../../src/skipped-writers.js';

const silent = { log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const dir = mkdtempSync(join(tmpdir(), 'fp-dispatch-proof-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.each(['full', 'delta'] as const)('native stored dispatch (%s)', (commitValues) => {
  it('binds the skipped writer to the exact trusted indexed recording', async () => {
    async function publish(path: 'other' | 'target') {
      let runningSnapshot: object | undefined;
      const chart = flowChart(
        'Start',
        () => {
          runningSnapshot = executor.getSnapshot();
        },
        'start',
      )
        .addDeciderFunction('Choose', () => 'send', 'choose')
        .addFunctionBranch('send', 'Send', () => {}, 'send-stage')
        .addFunctionBranch(
          'skip',
          'Skip',
          (scope) => {
            scope.$setValue(path, 1);
          },
          'skip-stage',
        )
        .end()
        .build();
      declareSkippedWriterPaths(chart.root.next!.children![1], [path]);
      const audience = 'native-chart-proof';
      const payload = join(dir, `${commitValues}-${path}-bound.jsonl`);
      const sidecar = join(dir, `${commitValues}-${path}-bound.index.json`);
      const sink = indexedFileSink(payload, { audience });
      const executor = new FlowChartExecutor(chart, skippedWriterCaptureOptions({ sink, commitValues }));
      let publication: Awaited<ReturnType<typeof sink.seal>>;
      try {
        await executor.run();
        publication = await sink.seal(sidecar);
      } finally {
        await sink.close();
      }
      const snapshot = executor.getSnapshot();
      expect(runningSnapshot).toBeDefined();
      expect(liveSkippedChartOf(runningSnapshot!)).toBeUndefined();
      expect(liveSkippedChartOf({ ...snapshot })).toBeUndefined();
      const liveChart = liveSkippedChartOf(snapshot);
      expect(liveChart?.stages.find((stage) => stage.stageId === 'skip')?.writes).toEqual([path]);
      const address = { logRunId: snapshot.runId, drillPath: [] };
      const opened = await openPublishedRecordFile(payload, sidecar, publication, {
        audience,
        allowedScopes: [address],
      });
      if (opened.status !== 'ready') throw new Error(`Cannot open publication: ${opened.reason}`);
      try {
        const loaded = await opened.reader.readScope(address);
        if (loaded.status !== 'loaded') throw new Error(`Cannot read root: ${loaded.reason}`);
        const recording = readStoredRecord(loaded.entries);
        const log = recording.log(address);
        if (!log?.complete) throw new Error('Expected a complete stored root record');
        expect(log.commitLog).toEqual(snapshot.commitLog);
        const closed = log.meta.closed?.skippedChart as
          | (Omit<TrustedSavedChartBinding, 'recordingVersion'> & { readonly graph: unknown })
          | undefined;
        if (!closed) throw new Error('Expected the native closing chart witness');
        const { graph, ...boundAtCapture } = closed;
        expect(graph).toEqual(liveChart);
        const capture = {
          recordingVersion: publication.indexDigest,
          runId: snapshot.runId,
          address,
          from: 0,
          to: log.commitLog.length,
        } as const;
        const binding = { ...boundAtCapture, recordingVersion: publication.indexDigest };
        const authority: SavedSkippedChartAuthority = {
          lookup: (subject, scope) =>
            subject === recording && scope.logRunId === address.logRunId && scope.drillPath.length === 0
              ? { capture, binding }
              : undefined,
        };
        return { recording, address, graph, authority, beforeIdx: log.commitLog.length };
      } finally {
        await opened.reader.close();
      }
    }

    const earlier = await publish('other');
    const later = await publish('target');
    const query = (run: typeof earlier, chart: unknown) =>
      couldHaveChanged(run.recording, 'target', run.beforeIdx, {
        address: run.address,
        chart,
        authority: run.authority,
      });
    expect((await query(earlier, earlier.graph)).candidates).toEqual([]);
    expect((await query(later, later.graph)).candidates).toMatchObject([
      { binding: 'host-attested', writers: [{ stageId: 'skip', basis: 'declared' }] },
    ]);
    expect(await query(earlier, later.graph)).toMatchObject({ candidates: [], gaps: ['chart-binding'] });
    expect(await query(later, earlier.graph)).toMatchObject({ candidates: [], gaps: ['chart-binding'] });
  });

  it('keeps a paused snapshot and its resumed leg outside the original chart binding', async () => {
    const chart = flowChart('Start', () => {}, 'start')
      .addPausableFunction('Approve', { execute: () => ({ question: 'Continue?' }), resume: () => {} }, 'approve')
      .addFunction('Finish', () => {}, 'finish')
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, skippedWriterCaptureOptions({ sink, commitValues }));
    await executor.run();
    const paused = executor.getSnapshot();
    expect(executor.isPaused()).toBe(true);
    expect(liveSkippedChartOf(paused)).toBeUndefined();

    await executor.resume(executor.getCheckpoint()!, true);
    expect(executor.isPaused()).toBe(false);
    expect(liveSkippedChartOf(paused)).toBeUndefined();
    expect(liveSkippedChartOf(executor.getSnapshot())).toBeUndefined();
  });

  it('withholds the captured chart when a stage supplies runtime children', async () => {
    const child = { id: 'runtime-child', name: 'Runtime child', fn: () => {} };
    const chart = flowChart('Start', () => ({ id: 'runtime', name: 'Runtime', children: [child] }), 'start').build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, skippedWriterCaptureOptions({ sink, commitValues }));
    await executor.run();

    expect(executor.getSnapshot().commitLog.map((commit) => commit.runtimeStageId)).toContain('runtime-child#1');
    const closed = sink.entries.find((entry) => entry.kind === 'closed');
    expect(closed).toBeDefined();
    expect(closed?.meta).not.toHaveProperty('skippedChart');
    expect(liveSkippedChartOf(executor.getSnapshot())).toBeUndefined();
  });

  it.each([false, true])('enables the exact captured chart only through opt-in %s', async (enabled) => {
    const ran: string[] = [];
    const chart = flowChart('Start', () => {}, 'start')
      .addDeciderFunction('Choose', () => 'send', 'choose')
      .addFunctionBranch(
        'send',
        'Send',
        () => {
          ran.push('send');
        },
        'send-stage',
      )
      .end()
      .build();
    const authored = chart.root.next!.children![0];
    const memory = memorySink();
    const options = {
      commitValues,
      sink: {
        ...memory,
        opened(entry: Parameters<typeof memory.opened>[0]) {
          memory.opened(entry);
          authored.name = 'Changed after opening';
          const changed = () => {
            ran.push('changed');
          };
          authored.fn = changed;
          chart.stageMap.set(authored.id, changed);
        },
      },
    } as const;
    const executor = new FlowChartExecutor(chart, enabled ? skippedWriterCaptureOptions(options) : options);
    await executor.run();

    const opened = memory.entries.find((entry) => entry.kind === 'opened');
    const decisions = memory.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.decision');
    if (enabled) {
      expect(opened).toMatchObject({ collects: { v: 2, reads: 'off' } });
      expect(decisions).toMatchObject([{ data: { chosen: 'Send' } }]);
      expect(ran).toEqual(['send']);
    } else {
      expect(opened).not.toHaveProperty('collects');
      expect(decisions).toEqual([]);
      expect(ran).toEqual(['changed']);
    }
    expect(authored.name).toBe('Changed after opening');
  });

  it.each([
    { returned: 'send', duplicate: false, ran: 'send', label: 'Send', fellBack: undefined },
    { returned: 'unmatched', duplicate: false, ran: 'default', label: 'Default', fellBack: true },
    { returned: 'send', duplicate: true, ran: 'send', label: undefined, fellBack: undefined },
    { returned: 'send', duplicate: false, ran: 'send', label: undefined, fellBack: undefined, redacted: true },
  ])('records only an unambiguous executed choice for $returned (duplicate=$duplicate)', async (sample) => {
    const ran: string[] = [];
    const root: StageNode = {
      id: 'choose',
      name: 'Choose',
      deciderFn: true,
      children: [
        { id: 'send', name: 'Send' },
        { id: 'default', name: sample.duplicate ? 'Send' : 'Default' },
      ],
    };
    const stageMap = new Map<string, StageFunction>([
      ['choose', () => sample.returned],
      [
        'send',
        () => {
          ran.push('send');
        },
      ],
      [
        'default',
        () => {
          ran.push('default');
        },
      ],
    ]);
    const sink = memorySink();
    const address = { logRunId: 'native-dispatch', drillPath: [] };
    const rule = 'redacted' in sample ? new RedactionRule({ keys: ['private'] }) : undefined;
    const runtime = new ExecutionRuntime('Choose', 'choose', undefined, {}, runPolicy({ commitValues }, rule), {
      address,
      sink,
      collects: { reads: 'off' },
    });
    installStoredControl(runtime.executionHistory);
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: (context, name) => new ScopeFacade(context, name),
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silent,
    });
    await traverser.execute();

    expect(ran).toEqual([sample.ran]);
    expect(canBindStoredControl(runtime.executionHistory)).toBe(sample.label !== undefined);
    const decision = sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.decision');
    if (sample.label === undefined) {
      expect(decision).toEqual([]);
    } else {
      expect(decision).toMatchObject([{ data: { id: 'choose#0', chosen: sample.label, by: 'plain' } }]);
      const entry = decision[0];
      if (entry.kind !== 'note') throw new Error('Expected native decision note');
      expect(entry.data.fellBack).toBe(sample.fellBack);
      expect(sink.entries.findIndex((row) => row === entry)).toBeGreaterThan(
        sink.entries.findIndex((row) => row.kind === 'commit' && row.bundle.runtimeStageId === 'choose#0'),
      );
    }
  });

  it.each([
    { selected: ['email', 'push'], chosen: ['Email', 'Push'] },
    { selected: [], chosen: [] },
    { selected: ['missing'], chosen: undefined },
  ])('preserves the selector dispatch $selected', async ({ selected, chosen }) => {
    const ran: string[] = [];
    const children = [
      { id: 'email', name: 'Email' },
      { id: 'sms', name: 'SMS' },
      { id: 'push', name: 'Push' },
    ];
    const root: StageNode = { id: 'choose', name: 'Choose', selectorFn: true, children };
    const stageMap = new Map<string, StageFunction>([['choose', () => selected]]);
    for (const child of children)
      stageMap.set(child.id, () => {
        ran.push(child.name);
      });
    const sink = memorySink();
    const runtime = new ExecutionRuntime('Choose', 'choose', undefined, {}, runPolicy({ commitValues }), {
      address: { logRunId: 'native-selection', drillPath: [] },
      sink,
      collects: { reads: 'off' },
    });
    installStoredControl(runtime.executionHistory);
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: (context, name) => new ScopeFacade(context, name),
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silent,
    });
    if (chosen === undefined) await expect(traverser.execute()).rejects.toThrow();
    else await traverser.execute();

    const notes = sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.decision');
    expect(ran.sort()).toEqual([...(chosen ?? [])].sort());
    if (chosen === undefined) expect(notes).toEqual([]);
    else expect(notes).toMatchObject([{ data: { id: 'choose#0', by: 'select', chosen, total: 3 } }]);
  });

  it('withholds the chart binding after running a function-bearing dynamic continuation', async () => {
    const ran: string[] = [];
    const chart = flowChart(
      'Start',
      () => ({
        name: 'Return',
        next: {
          name: 'Dynamic',
          fn: () => {
            ran.push('dynamic');
          },
        },
      }),
      'start',
    ).build();
    const sink = memorySink();
    const runtime = new ExecutionRuntime('Start', 'start', undefined, {}, runPolicy({ commitValues }), {
      address: { logRunId: 'dynamic-return', drillPath: [] },
      sink,
      collects: { reads: 'off' },
    });
    installStoredControl(runtime.executionHistory);
    await new FlowchartTraverser({
      root: chart.root,
      stageMap: chart.stageMap,
      scopeFactory: chart.scopeFactory!,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silent,
    }).execute();

    expect(ran).toEqual(['dynamic']);
    expect(canBindStoredControl(runtime.executionHistory)).toBe(false);
    expect(sink.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.loop')).toEqual([]);
  });

  it.each(['static', 'dynamic'] as const)(
    'records a %s return only when the chart declares that edge',
    async (kind) => {
      const chart = flowChart<{ visits: number }>(
        'Seed',
        (scope) => {
          scope.visits = 0;
        },
        'seed',
      )
        .addFunction(
          'Tick',
          (scope) => {
            scope.visits++;
          },
          'tick',
        )
        .addDeciderFunction('Check', (scope) => (scope.visits < 3 ? 'again' : 'done'), 'check')
        .addFunctionBranch(
          'again',
          'Again',
          () => (kind === 'dynamic' ? { name: 'Return', next: { id: 'tick', name: 'Tick' } } : undefined),
          undefined,
          kind === 'static' ? { loopTo: 'tick' } : undefined,
        )
        .addFunctionBranch('done', 'Done', () => {})
        .end()
        .build();
      const payload = join(dir, `${commitValues}-${kind}.jsonl`);
      const sidecar = join(dir, `${commitValues}-${kind}.index.json`);
      const address = { logRunId: 'native-return', drillPath: [] };
      const audience = 'native-return-proof';
      const sink = indexedFileSink(payload, { audience });
      const runtime = new ExecutionRuntime('Seed', 'seed', undefined, {}, runPolicy({ commitValues }), {
        address,
        sink,
        collects: { reads: 'off' },
      });
      installStoredControl(runtime.executionHistory);
      const traverser = new FlowchartTraverser({
        root: chart.root,
        stageMap: chart.stageMap,
        scopeFactory: chart.scopeFactory!,
        executionRuntime: runtime,
        scopeProtectionMode: 'off',
        logger: silent,
      });
      let publication: Awaited<ReturnType<typeof sink.seal>>;
      try {
        await traverser.execute();
        runtime.closeRecord('ok');
        publication = await sink.seal(sidecar);
      } finally {
        await sink.close();
      }

      expect(runtime.globalStore.getState()).toMatchObject({ visits: 3 });
      expect(canBindStoredControl(runtime.executionHistory)).toBe(kind === 'static');
      const opened = await openPublishedRecordFile(payload, sidecar, publication, {
        audience,
        allowedScopes: [address],
      });
      if (opened.status !== 'ready') throw new Error(`Cannot open publication: ${opened.reason}`);
      const saved = await (async () => {
        try {
          const loaded = await opened.reader.readScope(address);
          if (loaded.status !== 'loaded') throw new Error(`Cannot read root: ${loaded.reason}`);
          return readStoredRecord(loaded.entries);
        } finally {
          await opened.reader.close();
        }
      })();
      const log = saved.log(address);
      if (!log?.complete) throw new Error('Expected a complete stored root record');
      expect(log.commitLog).toEqual(runtime.executionHistory.list());
      const notes = log.entries.filter((entry) => entry.kind === 'note' && entry.note === 'run.loop');
      expect(notes).toHaveLength(kind === 'static' ? 2 : 0);
      for (const note of notes) {
        if (note.kind !== 'note') throw new Error('Expected native return note');
        expect(note.data.target).toBe('tick');
        const source = log.entries.findIndex(
          (row) => row.kind === 'commit' && row.bundle.runtimeStageId === note.data.id,
        );
        const resumed = log.entries.findIndex(
          (row, index) => index > source && row.kind === 'commit' && row.bundle.stageId === 'tick',
        );
        expect(source).toBeGreaterThanOrEqual(0);
        expect(log.entries.indexOf(note)).toBeGreaterThan(source);
        expect(resumed).toBeGreaterThan(log.entries.indexOf(note));
      }
      const decisions = readRunEvidence(saved, 'native-return').decisions;
      expect(decisions.status).toBe('collected');
      expect(decisions.rows.map(({ chosen }) => chosen)).toEqual(['Again', 'Again', 'Done']);
    },
  );
});
