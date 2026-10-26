/** Optional source capture cannot reject a chart supported by the native log. */
import type { LogAddress } from 'foottrace';
import { createReadSourceRecord, memorySink, SharedMemory } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { SubflowResult } from '../../../src/lib/engine/types.js';

const injected = vi.hoisted(() => ({ failChild: false, error: undefined as unknown }));
vi.mock('foottrace/write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('foottrace/write')>();
  return {
    ...actual,
    createReadSourceRecord: (...args: Parameters<typeof actual.createReadSourceRecord>) => {
      if (injected.failChild && args[1].drillPath.length > 0) throw injected.error;
      return actual.createReadSourceRecord(...args);
    },
  };
});

const quiet = { info() {}, log() {}, debug() {}, error() {}, warn() {} };
const scenarios = [
  { name: 'one ordinary mount', depth: 1, id: 'm', unsupportedFrom: Infinity },
  { name: 'native maximum drill depth', depth: 16, id: 'm', unsupportedFrom: Infinity },
  { name: 'one beyond native drill depth', depth: 17, id: 'm', unsupportedFrom: 17 },
  { name: 'deeper descendants beyond native drill depth', depth: 20, id: 'm', unsupportedFrom: 17 },
  { name: 'long admitted mount address', depth: 1, id: 'm'.repeat(1020), unsupportedFrom: Infinity },
  { name: 'long refused mount and descendants', depth: 3, id: 'm'.repeat(1024), unsupportedFrom: 1 },
  { name: 'multibyte admitted mount address', depth: 1, id: 'é'.repeat(511), unsupportedFrom: Infinity },
  { name: 'multibyte refused mount address', depth: 1, id: 'é'.repeat(512), unsupportedFrom: 1 },
];

function nativeAddressSupported(address: LogAddress): boolean {
  // An independent native writer control, not an engine implementation of address ceilings.
  try {
    const book = createReadSourceRecord(new SharedMemory(), address);
    book.retire();
    return true;
  } catch {
    return false;
  }
}

function nestedChart(depth: number, id: string, leaf: () => void) {
  let chart = flowChart<{ n: number }>(
    'Leaf',
    (s) => {
      leaf();
      s.n = 41;
      const read = s.n;
      expect(read).toBe(41);
    },
    'leaf',
  ).build();
  for (let index = 0; index < depth; index++) {
    chart = flowChart<{ n: number }>('Root', () => {}, 'root')
      .addSubFlowChartNext(id, chart, 'Mount')
      .setLogger(quiet)
      .build();
  }
  return chart;
}

describe.each([false, true])('native source-address admission (sink=%s)', (sink) => {
  describe.each([false, true])('readSources=%s', (readSources) => {
    it.each(scenarios)('$name preserves execution, local log identity and honest unknown sources', async (scenario) => {
      let executed = 0;
      const chart = nestedChart(scenario.depth, scenario.id, () => executed++);
      const adapter = memorySink();
      const executor = new FlowChartExecutor(chart, { readSources, ...(sink && { sink: adapter }) });
      await executor.run();
      expect(executed).toBe(1);
      const snapshot = executor.getSnapshot();
      const mounts = Object.entries(snapshot.subflowResults ?? {}).filter(([key]) => key.includes('#')) as [
        string,
        SubflowResult,
      ][];
      expect(mounts).toHaveLength(scenario.depth);
      for (const [mount, result] of mounts) {
        const context = result.treeContext;
        const address = context.logAddress!;
        expect(address.logRunId).toBe(snapshot.logAddress!.logRunId);
        expect(address.drillPath.at(-1)).toBe(mount);
        const supported = address.drillPath.length < scenario.unsupportedFrom;
        if (readSources) {
          expect(nativeAddressSupported(address)).toBe(supported);
          if (supported) {
            expect(context.readSources!.record!.address).toEqual(address);
          } else {
            expect(context.readSources).toMatchObject({
              status: 'unknown',
              limitations: ['source-address-unsupported'],
            });
            expect(context.readSources).not.toHaveProperty('record');
          }
        } else {
          expect(context).not.toHaveProperty('readSources');
        }
        if (sink) {
          expect(
            adapter.entries.some(
              (entry) => entry.kind === 'opened' && JSON.stringify(entry.address) === JSON.stringify(address),
            ),
          ).toBe(true);
          expect(
            adapter.entries.some(
              (entry) =>
                entry.kind === 'closed' &&
                entry.outcome === 'ok' &&
                JSON.stringify(entry.address) === JSON.stringify(address),
            ),
          ).toBe(true);
        }
      }
      const leaf = mounts.find(([, result]) => result.treeContext.logAddress!.drillPath.length === scenario.depth)![1];
      expect(leaf.treeContext.globalContext.n).toBe(41);
      if (sink) expect(snapshot.sink!.failed).toBe(0);
      expect(executor.getSnapshot({ redact: true }).readSources?.record).toBeUndefined();
    });
  });
});

describe('address refusal does not absorb startup or configuration failures', () => {
  it.each([false, true])('fresh resume below a refused address still omits earlier history (sink=%s)', async (sink) => {
    let chart = flowChart<{ n: number; out?: number }>(
      'Seed',
      (s) => {
        s.n = 9;
      },
      'seed',
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
    for (let index = 0; index < 17; index++) {
      chart = flowChart<{ n: number; out?: number }>('Root', () => {}, 'root')
        .addSubFlowChartNext('m', chart, 'Mount')
        .setLogger(quiet)
        .build();
    }
    const previous = new FlowChartExecutor(chart);
    await previous.run();
    const checkpoint = JSON.parse(JSON.stringify(previous.getCheckpoint()));
    const executor = new FlowChartExecutor(chart, { readSources: true, ...(sink && { sink: memorySink() }) });
    await executor.resume(checkpoint, true);
    const leaf = (Object.values(executor.getSnapshot().subflowResults!) as SubflowResult[]).find(
      (result) => result.treeContext.logAddress!.drillPath.length === 17,
    )!.treeContext;
    expect(leaf.globalContext.out).toBe(9);
    expect(leaf.readSources).toMatchObject({ status: 'unknown' });
    expect(leaf.readSources!.limitations).toEqual(
      expect.arrayContaining(['source-address-unsupported', 'source-history-not-included']),
    );
    expect(leaf.readSources).not.toHaveProperty('record');
  });

  it.each([false, true])(
    'preserves the actual child factory exception even with the admission error message (sink=%s)',
    async (sink) => {
      const original = new TypeError('read sources: invalid data');
      injected.failChild = true;
      injected.error = original;
      try {
        const executor = new FlowChartExecutor(
          nestedChart(1, 'm', () => {}),
          {
            readSources: true,
            ...(sink && { sink: memorySink() }),
          },
        );
        await expect(executor.run()).rejects.toBe(original);
      } finally {
        injected.failChild = false;
        injected.error = undefined;
      }
    },
  );

  it.each([false, true])(
    'keeps an invalid source configuration fatal before a refused mount (sink=%s)',
    async (sink) => {
      let executed = 0;
      const executor = new FlowChartExecutor(
        nestedChart(1, 'm'.repeat(1024), () => executed++),
        {
          readSources: { limits: { maxBytes: 0 } },
          ...(sink && { sink: memorySink() }),
        },
      );
      await expect(executor.run()).rejects.toThrow('read sources: invalid limits');
      expect(executed).toBe(0);
    },
  );

  it.each([false, true])('preserves native base cloning failures (sink=%s)', (sink) => {
    expect(
      () =>
        new FlowChartExecutor(
          nestedChart(1, 'm', () => {}),
          {
            readSources: true,
            initialContext: { uncloneable: () => {} },
            ...(sink && { sink: memorySink() }),
          },
        ),
    ).toThrowError(expect.objectContaining({ name: 'DataCloneError' }));
  });
});
