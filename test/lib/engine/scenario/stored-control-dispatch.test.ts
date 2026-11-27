import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readRunEvidence, readStoredRecord } from 'foottrace';
import { type SavedSkippedChartAuthority, type TrustedSavedChartBinding, couldHaveChanged } from 'foottrace/cause';
import { EventLog, memorySink } from 'foottrace/write';
import { afterAll, describe, expect, it } from 'vitest';

import { FlowChartExecutor } from '../../../../src/index.js';
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
import { liveSkippedChartOf } from '../../../../src/skipped-writer-state.js';
import {
  declareSkippedWriterPaths,
  readSkippedWriters,
  skippedWriterCaptureOptions,
} from '../../../../src/skipped-writers.js';

const silent = { log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const dir = mkdtempSync(join(tmpdir(), 'fp-dispatch-proof-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it.skipIf(typeof couldHaveChanged === 'function')(
  'returns a gap when the installed peer has no skipped evaluator',
  async () => {
    const chart = flowChart('Start', () => {}, 'start')
      .addFunction('Finish', () => {}, 'finish')
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink }));
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(await readSkippedWriters(snapshot, 'target', snapshot.commitLog.length)).toEqual({
      candidates: [],
      gaps: ['not-collected'],
    });
    expect(sink.entries.find((entry) => entry.kind === 'closed')?.meta).not.toHaveProperty('skippedChart');
  },
);

it.skipIf(typeof couldHaveChanged !== 'function')(
  'refuses a substituted log from another physical Foottrace copy',
  async () => {
    const require = createRequire(import.meta.url);
    const foreign = join(dir, 'foreign', 'node_modules', 'foottrace');
    cpSync(dirname(require.resolve('foottrace/package.json')), foreign, { recursive: true });
    const loadForeign = createRequire(join(dir, 'foreign', 'consumer.cjs'));
    const ForeignLog = (loadForeign('foottrace/write') as typeof import('foottrace/write')).EventLog;
    expect(ForeignLog).not.toBe(EventLog);

    const chart = flowChart('Start', () => {}, 'start')
      .addFunction('Finish', () => {}, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink: memorySink() }));
    await executor.run();
    const native = executor.getSnapshot();
    const runtime = executor.getRuntime() as ExecutionRuntime;
    const prior = runtime.executionHistory;
    const lookalike = new ForeignLog({});
    lookalike.bindAddress(native.logAddress!.logRunId, []);
    for (const bundle of native.commitLog) lookalike.record({ ...bundle });
    runtime.executionHistory = lookalike;
    try {
      const substituted = executor.getSnapshot();
      expect(substituted.commitLog).toHaveLength(native.commitLog.length);
      expect(await readSkippedWriters(substituted, 'target', substituted.commitLog.length)).toEqual({
        candidates: [],
        gaps: ['chart-binding'],
      });
    } finally {
      runtime.executionHistory = prior;
    }
  },
);

describe.skipIf(typeof couldHaveChanged !== 'function').each(['full', 'delta'] as const)(
  'native stored dispatch (%s)',
  (commitValues) => {
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
        const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
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
          return { recording, address, graph, authority, snapshot, beforeIdx: log.commitLog.length };
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
      const saved = await query(later, later.graph);
      expect(saved.candidates).toMatchObject([
        { binding: 'host-attested', writers: [{ stageId: 'skip', basis: 'declared' }] },
      ]);
      expect(await readSkippedWriters(later.snapshot, 'target', later.beforeIdx)).toEqual({
        candidates: saved.candidates.map((candidate) => ({ ...candidate, binding: 'native' })),
        gaps: saved.gaps,
      });
      expect(await readSkippedWriters({ ...later.snapshot }, 'target', later.beforeIdx)).toEqual({
        candidates: [],
        gaps: ['chart-binding'],
      });
      expect(await query(earlier, later.graph)).toMatchObject({ candidates: [], gaps: ['chart-binding'] });
      expect(await query(later, earlier.graph)).toMatchObject({ candidates: [], gaps: ['chart-binding'] });
    });

    it('uses the whole log after an exact same-executor resume of the preserved chart', async () => {
      const chart = flowChart('Start', () => {}, 'start')
        .addDeciderFunction('Choose', () => 'send', 'choose')
        .addFunctionBranch('send', 'Send', () => {}, 'send-stage')
        .addFunctionBranch('skip', 'Skip', (scope) => scope.$setValue('target', 1), 'skip-stage')
        .end()
        .addPausableFunction('Approve', { execute: () => ({ question: 'Continue?' }), resume: () => {} }, 'approve')
        .addFunction('Finish', () => {}, 'finish')
        .build();
      declareSkippedWriterPaths(chart.root.next!.children![1], ['target']);
      const sink = memorySink();
      const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
      await executor.run();
      const paused = executor.getSnapshot();
      expect(executor.isPaused()).toBe(true);
      expect(await readSkippedWriters(paused, 'target', paused.commitLog.length)).toEqual({
        candidates: [],
        gaps: ['chart-binding'],
      });

      await executor.resume(executor.getCheckpoint()!, true);
      expect(executor.isPaused()).toBe(false);
      expect(liveSkippedChartOf(paused)).toBeUndefined();
      const completed = executor.getSnapshot();
      const live = await readSkippedWriters(completed, 'target', completed.commitLog.length);
      expect(live.candidates).toMatchObject([{ binding: 'native', writers: [{ stageId: 'skip' }] }]);
      const stored = readStoredRecord(sink.entries);
      const root = stored.root(paused.runId)!;
      const bound = root.meta.closed!.skippedChart as unknown as Omit<TrustedSavedChartBinding, 'recordingVersion'> & {
        readonly graph: unknown;
      };
      expect(bound.from).toBe(0);
      const { graph, ...binding } = bound;
      const capture = { ...binding, recordingVersion: 'same-executor-resume' };
      const saved = await couldHaveChanged(stored, 'target', completed.commitLog.length, {
        address: root.address,
        chart: graph,
        authority: { lookup: (subject) => (subject === stored ? { capture, binding: capture } : undefined) },
      });
      expect(live).toEqual({
        candidates: saved.candidates.map((candidate) => ({ ...candidate, binding: 'native' })),
        gaps: saved.gaps,
      });
    });

    it.each([
      { declaration: ['other'], basis: undefined },
      { declaration: ['target'], basis: 'declared' },
      { declaration: undefined, basis: 'observed' },
    ])('checks a repeated writer against its declaration $declaration', async ({ declaration, basis }) => {
      let pass = 0;
      const chart = flowChart('Start', () => {}, 'start')
        .addDeciderFunction('Choose', () => (pass++ === 0 ? 'skipper' : 'keep'), 'choose')
        .addFunctionBranch('skipper', 'Skipper', (scope) => scope.$setValue('target', 1), 'skipper', {
          loopTo: 'start',
        })
        .addFunctionBranch('keep', 'Keep', () => {}, 'keep')
        .end()
        .build();
      declareSkippedWriterPaths(chart.root, []);
      declareSkippedWriterPaths(chart.root.next!, []);
      declareSkippedWriterPaths(chart.root.next!.children![1], []);
      if (declaration) declareSkippedWriterPaths(chart.root.next!.children![0], declaration);
      const sink = memorySink();
      const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(snapshot.commitLog).toHaveLength(6);
      expect(snapshot.commitLog[2]).toMatchObject({ stageId: 'skipper', trace: [{ path: 'target' }] });
      const answer = await readSkippedWriters(snapshot, 'target', snapshot.commitLog.length);
      const closed = sink.entries.find((entry) => entry.kind === 'closed');
      if (basis) {
        expect(answer.candidates).toMatchObject([{ binding: 'native', writers: [{ stageId: 'skipper', basis }] }]);
        expect(closed?.meta).toHaveProperty('skippedChart');
      } else {
        expect(answer).toEqual({ candidates: [], gaps: ['declaration-mismatch'] });
        expect(liveSkippedChartOf(snapshot)).toBeUndefined();
        expect(closed?.meta).not.toHaveProperty('skippedChart');
      }
    });

    it('refuses to bind a copied checkpoint resumed on a changed authored chart', async () => {
      const chart = flowChart('Start', () => {}, 'start')
        .addDeciderFunction('Choose', () => 'send', 'choose')
        .addFunctionBranch('send', 'Send', () => {}, 'send-stage')
        .addFunctionBranch('skip', 'Skip', (scope) => scope.$setValue('target', 1), 'skip-stage')
        .end()
        .addPausableFunction('Approve', { execute: () => ({ question: 'Continue?' }), resume: () => {} }, 'approve')
        .addFunction('Finish', () => {}, 'finish')
        .build();
      declareSkippedWriterPaths(chart.root.next!.children![1], ['target']);
      const sink = memorySink();
      const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
      await executor.run();
      expect(executor.isPaused()).toBe(true);

      const copy = structuredClone(executor.getCheckpoint()!);
      const added = (scope: ScopeFacade) => scope.$setValue('target', 2);
      chart.root.next!.children!.push({ id: 'added', name: 'Added', fn: added });
      chart.stageMap.set('added', added);
      await executor.resume(copy, true);
      expect(executor.isPaused()).toBe(false);
      const completed = executor.getSnapshot();
      expect(await readSkippedWriters(completed, 'target', completed.commitLog.length)).toEqual({
        candidates: [],
        gaps: ['not-collected'],
      });
      expect(sink.entries.find((entry) => entry.kind === 'closed')?.meta).not.toHaveProperty('skippedChart');
    });

    it.each(['selector', 'early loop exit'] as const)('agrees with saved evidence for a %s', async (kind) => {
      const start = flowChart('Start', () => {}, 'start');
      const control =
        kind === 'selector'
          ? start.addSelectorFunction('Pick', () => ['done'], 'pick')
          : start.addDeciderFunction('Pick', () => 'done', 'pick');
      const skip = (scope: ScopeFacade) => scope.$setValue('target', 1);
      const chart = (
        kind === 'selector'
          ? control.addFunctionBranch('again', 'Again', skip, 'again')
          : control.addFunctionBranch('again', 'Again', skip, 'again', { loopTo: 'start' })
      )
        .addFunctionBranch('done', 'Done', () => {}, 'done')
        .end()
        .build();
      declareSkippedWriterPaths(chart.root, []);
      declareSkippedWriterPaths(chart.root.next!.children![0], ['target']);
      declareSkippedWriterPaths(chart.root.next!.children![1], []);
      const sink = memorySink();
      const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
      await executor.run();
      const snapshot = executor.getSnapshot();
      const stored = readStoredRecord(JSON.parse(JSON.stringify(sink.entries)));
      const root = stored.root(snapshot.runId)!;
      const bound = root.meta.closed!.skippedChart as unknown as Omit<TrustedSavedChartBinding, 'recordingVersion'> & {
        readonly graph: unknown;
      };
      const { graph, ...binding } = bound;
      const capture = { ...binding, recordingVersion: 'served-record' };
      const saved = await couldHaveChanged(stored, 'target', snapshot.commitLog.length, {
        address: root.address,
        chart: graph,
        authority: { lookup: (subject) => (subject === stored ? { capture, binding: capture } : undefined) },
      });
      expect(saved.candidates).toMatchObject([{ writers: [{ stageId: 'again' }] }]);
      expect(await readSkippedWriters(snapshot, 'target', snapshot.commitLog.length)).toEqual({
        candidates: saved.candidates.map((candidate) => ({ ...candidate, binding: 'native' })),
        gaps: saved.gaps,
      });
    });

    it('withholds a binding after a late privacy mark', async () => {
      const chart = flowChart('Start', () => {}, 'start')
        .addFunction('Mark', (scope) => scope.$setValue('private', 'masked-fact', true), 'mark')
        .build();
      const sink = memorySink();
      const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
      await executor.run();
      const snapshot = executor.getSnapshot();
      const result = await readSkippedWriters(snapshot, 'private', snapshot.commitLog.length);
      expect(result).toEqual({ candidates: [], gaps: ['chart-binding'] });
      expect(JSON.stringify(sink.entries)).not.toContain('masked-fact');
    });

    it('reports a gap when the bounded local evidence is too large', async () => {
      const chart = flowChart('Start', (scope) => scope.$setValue('large', 'x'.repeat(800_000)), 'start').build();
      const executor = new FlowChartExecutor(
        chart,
        await skippedWriterCaptureOptions({ sink: memorySink(), commitValues }),
      );
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(await readSkippedWriters(snapshot, 'large', snapshot.commitLog.length)).toEqual({
        candidates: [],
        gaps: ['truncated'],
      });
    });

    it('withholds the captured chart when a stage supplies runtime children', async () => {
      const child = { id: 'runtime-child', name: 'Runtime child', fn: () => {} };
      const chart = flowChart('Start', () => ({ id: 'runtime', name: 'Runtime', children: [child] }), 'start').build();
      const sink = memorySink();
      const executor = new FlowChartExecutor(chart, await skippedWriterCaptureOptions({ sink, commitValues }));
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
      const executor = new FlowChartExecutor(chart, enabled ? await skippedWriterCaptureOptions(options) : options);
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
      const rule = Object.hasOwn(sample, 'redacted') ? new RedactionRule({ keys: ['private'] }) : undefined;
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
  },
);
