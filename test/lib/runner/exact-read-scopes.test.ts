/** Native scope ownership: no source selection, replay or storage admission is reimplemented here. */
import { stateAt } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { type FlowChartExecutorOptions, flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { SubflowResult } from '../../../src/lib/engine/types.js';
import type { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime.js';
import { requireScopeRuntime } from '../../../src/lib/scope/runtime.js';
import { readStoredCapture } from '../../../src/trace.js';

type State = { n: number; out?: number };
const enabled = { readSources: true };
const child = () =>
  flowChart<State>(
    'Seed child',
    (s) => {
      s.n = 11;
    },
    'seed',
  )
    .addFunction(
      'Read child',
      (s) => {
        s.out = s.n;
      },
      'read',
    )
    .build();

function mounts(executor: FlowChartExecutor<any, any>): [string, SubflowResult][] {
  return Object.entries(executor.getSnapshot().subflowResults ?? {}).filter(([key]) => key.includes('#')) as [
    string,
    SubflowResult,
  ][];
}

describe('independently owned read-source scopes', () => {
  it.each([false, true])('binds nested child books to their actual local histories (sink=%s)', async (sink) => {
    const adapter = memorySink();
    const outer = flowChart('Outer', () => {}, 'outer')
      .addSubFlowChartNext('inner', child(), 'Inner')
      .build();
    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('outer', outer, 'Outer')
      .build();
    const executor = new FlowChartExecutor(chart, { ...enabled, ...(sink && { sink: adapter }) });
    await executor.run();
    const children = mounts(executor);
    expect(children).toHaveLength(2);
    for (const [mountId, result] of children) {
      const scope = result.treeContext;
      const source = scope.readSources!;
      expect(source.status).toBe('captured');
      expect(source.persistence).toBe('memory-only');
      expect(source.record!.address).toEqual(scope.logAddress);
      expect(source.record!.address.drillPath.at(-1)).toBe(mountId);
      expect(source.record!.address.logRunId).toBe(executor.getSnapshot().logAddress!.logRunId);
      expect(scope).not.toHaveProperty('capture');
      for (const row of source.record!.occurrences) {
        expect(row.runtimeStageId).toMatch(/#\d+$/);
        expect(row.source.kind).toBe('committed');
        if (row.source.kind !== 'committed') throw Error('Expected a native committed source');
        expect(
          stateAt({ commitLog: scope.history, initialState: scope.initialState } as any, row.source.commitIdx).state.n,
        ).toBe(11);
      }
    }
    const inner = children.find(([, value]) => value.treeContext.readSources!.record!.occurrences.length)!;
    expect(inner[1].treeContext.readSources!.record!.address.drillPath).toHaveLength(2);
    expect(executor.getSnapshot().readSources!.record!.occurrences).toEqual([]);
  });

  it('gives concurrent repeated definitions distinct books and attempt identities', async () => {
    let tries = 0;
    const retrying = flowChart<State>(
      'Retry',
      (s) => {
        const n = s.n;
        if (++tries === 1) throw Error('retry');
        s.out = n;
      },
      'retry',
    )
      .retry({ attempts: 2 })
      .build();
    const chart = flowChart('Fork', () => {}, 'fork')
      .addSubFlowChart('left', retrying, 'Left', { inputMapper: () => ({ n: 1 }) })
      .addSubFlowChart('right', retrying, 'Right', { inputMapper: () => ({ n: 2 }) })
      .build();
    const executor = new FlowChartExecutor(chart, enabled);
    await executor.run();
    const children = mounts(executor);
    expect(children).toHaveLength(2);
    const addresses = children.map(([, result]) => JSON.stringify(result.treeContext.readSources!.record!.address));
    expect(new Set(addresses).size).toBe(2);
    const occurrences = children.flatMap(([, result]) => result.treeContext.readSources!.record!.occurrences);
    expect(occurrences).toHaveLength(3);
    expect(occurrences.every((row) => row.source.kind === 'committed')).toBe(true);
    expect(new Set(occurrences.map((row) => row.attemptId)).size).toBe(3);
  });

  it('retains separate books for repeated entries through the same mount', async () => {
    let passes = 0;
    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('child', child(), 'Child')
      .addDeciderFunction('Route', () => (++passes < 2 ? 'again' : 'done'), 'route')
      .addFunctionBranch('again', 'Again', () => {}, 'again', { loopTo: 'child' })
      .addFunctionBranch('done', 'Done', () => {}, 'done')
      .end()
      .build();
    const executor = new FlowChartExecutor(chart, enabled);
    await executor.run();
    const children = mounts(executor);
    expect(children).toHaveLength(2);
    const books = children.map(([mount, result]) => {
      const book = result.treeContext.readSources!.record!;
      expect(book.address.drillPath).toEqual([mount]);
      expect(book.occurrences).toHaveLength(1);
      expect(book.occurrences[0].ordinal).toBe(1);
      expect(book.occurrences[0].source).toEqual({ kind: 'committed', commitIdx: 0 });
      return book;
    });
    expect(books[0].address).not.toEqual(books[1].address);
    expect(books[0].occurrences[0].runtimeStageId).not.toBe(books[1].occurrences[0].runtimeStageId);
  });

  it('seals child evidence before a retained stage handle is called late', async () => {
    let held: any;
    const inner = flowChart<State>(
      'Write',
      (s) => {
        s.n = 1;
      },
      'write',
    )
      .addFunction(
        'Read',
        (s) => {
          held = s;
          const n = s.n;
        },
        'read',
      )
      .build();
    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('child', inner, 'Child')
      .build();
    const executor = new FlowChartExecutor(chart, enabled);
    await executor.run();
    const previous = JSON.stringify(mounts(executor)[0][1].treeContext.readSources);
    const capture = (requireScopeRuntime(held).target as any)._stageContext.readSources;
    expect(capture.active).toBe(false);
    const beforeLate = JSON.stringify(capture.snapshot(2));
    expect(held.n).toBe(1);
    expect(JSON.stringify(capture.snapshot(2))).toBe(beforeLate);
    expect(JSON.stringify(mounts(executor)[0][1].treeContext.readSources)).toBe(previous);
  });

  it('marks a resumed nested seed as new segment history with earlier origins omitted', async () => {
    const leaf = flowChart<State>(
      'Prepare',
      (s) => {
        s.n = 7;
      },
      'prepare',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({}),
          resume: (s) => {
            s.out = s.n;
          },
        },
        'ask',
      )
      .addFunction(
        'Read new write',
        (s) => {
          s.n = s.out!;
        },
        'new-read',
      )
      .build();
    const outer = flowChart('Outer', () => {}, 'start')
      .addSubFlowChartNext('leaf', leaf, 'Leaf')
      .build();
    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('outer', outer, 'Outer')
      .build();
    const previous = new FlowChartExecutor(chart, enabled);
    await previous.run();
    const checkpoint = JSON.parse(JSON.stringify(previous.getCheckpoint()));
    const resumed = new FlowChartExecutor(chart, enabled);
    await resumed.resume(checkpoint, true);
    const leafScope = mounts(resumed).find(
      ([, result]) => result.treeContext.readSources!.record!.occurrences.length === 2,
    )![1].treeContext;
    expect(leafScope.readSources).toMatchObject({ status: 'partial', limitations: ['source-history-not-included'] });
    const rows = leafScope.readSources!.record!.occurrences;
    expect(rows[0].source).toEqual({ kind: 'committed', commitIdx: 0 });
    expect(rows[1].source).toEqual({ kind: 'committed', commitIdx: 1 });
    expect(leafScope.readSources!.record!.address.logRunId).toBe(resumed.getSnapshot().runId);
    expect(checkpoint).not.toHaveProperty('readSources');
  });

  it('withholds child reference channels in redacted snapshots with and without a mirror', async () => {
    for (const privacy of [false, true]) {
      const chart = flowChart('Root', () => {}, 'root')
        .addSubFlowChartNext('child', child(), 'Child')
        .build();
      const executor = new FlowChartExecutor(chart, enabled);
      if (privacy) executor.setRedactionPolicy({ keys: ['other'] });
      await executor.run();
      const plain = mounts(executor)[0][1].treeContext.readSources!;
      expect(plain.record).toBeDefined();
      const safe = executor.getSnapshot({ redact: true });
      for (const result of Object.values(safe.subflowResults!) as SubflowResult[]) {
        expect(result.treeContext.readSources).toMatchObject({ status: 'unknown' });
        expect(result.treeContext.readSources!.limitations).toContain('redacted-source-export');
        expect(result.treeContext.readSources).not.toHaveProperty('record');
      }
      expect(mounts(executor)[0][1].treeContext.readSources).toEqual(plain);
    }
  });

  it('keeps the root receipt separate from a child source book', async () => {
    const adapter = memorySink();
    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('child', child(), 'Child')
      .build();
    const executor = new FlowChartExecutor(chart, {
      ...enabled,
      captureCoverage: true,
      sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
    });
    await executor.run();
    expect(mounts(executor)[0][1].treeContext.readSources!.record!.occurrences).toHaveLength(1);
    const loaded = await readStoredCapture(adapter.entries, { runId: executor.getSnapshot().runId });
    expect(loaded.status).toBe('acknowledged');
    expect(loaded.history!.readSources!.record!.occurrences).toEqual([]);
    expect(loaded.history).not.toHaveProperty('subflowResults');
  });

  it.each([false, true])('fresh resume creates its own base and counts (sink=%s)', async (sink) => {
    const adapter = memorySink();
    const options: FlowChartExecutorOptions = { ...enabled, ...(sink && { sink: adapter }) };
    const chart = flowChart<State>(
      'Prepare',
      (s) => {
        s.n = 19;
      },
      'prepare',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({}),
          resume: (s) => {
            s.out = s.n;
          },
        },
        'ask',
      )
      .build();
    const previous = new FlowChartExecutor(chart, options);
    await previous.run();
    const old = previous.getSnapshot();
    const checkpoint = JSON.parse(JSON.stringify(previous.getCheckpoint()));
    const resumed = new FlowChartExecutor(chart, options);
    await resumed.resume(checkpoint, true);
    const view = resumed.getSnapshot();
    const source = view.readSources!;
    expect(source.runId).not.toBe(old.runId);
    expect(source.status).toBe('partial');
    expect(source.limitations).toEqual(['source-history-not-included']);
    expect(source.record!.address).toEqual(view.logAddress);
    expect(source.record!.address.logRunId).toBe(view.runId);
    expect(source.record!.occurrences).toHaveLength(1);
    expect(source.record!.occurrences[0]).toMatchObject({ ordinal: 1, source: { kind: 'base' } });
    expect(view.executionTree.readSourceCounts).toMatchObject({ observed: 1, retained: 1, kinds: { base: 1 } });
    expect(view.capture!.limitations).toContain('resumed-segment');
    expect(view.initialState!.n).toBe(19);
    expect(old.readSources!.record!.occurrences).toEqual([]);
  });

  it('keeps same-executor resume unknown and does not lend its prior book to new reads', async () => {
    const chart = flowChart<State>(
      'Read',
      (s) => {
        const n = s.n;
      },
      'read',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({}),
          resume: (s) => {
            const n = s.n;
          },
        },
        'ask',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { ...enabled, initialContext: { n: 1 } });
    await executor.run();
    const previous = executor.getSnapshot();
    await executor.resume(executor.getCheckpoint()!, true);
    expect(executor.getSnapshot().readSources).toMatchObject({
      status: 'unknown',
      limitations: ['resumed-source-ownership'],
    });
    expect(executor.getSnapshot().readSources).not.toHaveProperty('record');
    expect(previous.readSources!.record!.occurrences).toHaveLength(1);
    const runtime = (executor as any).traverser.getRuntime() as ExecutionRuntime;
    runtime.rootStageContext.getValue([], 'n');
    expect(previous.readSources!.record!.occurrences).toHaveLength(1);
  });
});
