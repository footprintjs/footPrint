/**
 * The edges of the recorders' attempt rows (P1c, design §5.1).
 *
 * Test types: Boundary (a chosen decider branch that retries hangs under its decision-branch node; a combined attach
 * of the DebugRecorder never doubles a scope row on the flow channel; the metric duration spans the waits; a
 * recorder attached on the scope channel alone sees no attempt and scores as before; parallel siblings — an async
 * sibling ending after a child that gave up keeps both quality rows apart, and a parallel subflow's manifest row
 * lands on its own entry though siblings exit out of stack order).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { debug, manifest, metrics } from '../../../../src/recorders.js';
import { QualityRecorder, topologyRecorder } from '../../../../src/trace.js';

type S = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function flaky(fails: number) {
  let calls = 0;
  return (scope: S) => {
    calls += 1;
    if (calls <= fails) throw new Error(`boom ${calls}`);
    scope.value = calls;
  };
}

describe('Topology placement', () => {
  it('a chosen branch that retries hangs under its decision-branch node', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addDeciderFunction('Route', () => 'left', 'route')
      .addFunctionBranch('left', 'Left', flaky(1), undefined, { retry: { attempts: 2 } })
      .addFunctionBranch('right', 'Right', () => undefined)
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    const topo = topologyRecorder();
    executor.attachCombinedRecorder(topo);
    await executor.run();
    const [series] = topo.getByKind('attempt-series');
    const parent = topo.getTopology().nodes.find((n) => n.id === series.parentId);
    expect(parent?.kind).toBe('decision-branch');
    expect(series.attemptSummary?.count).toBe(2);
    expect(series.metadata).toEqual({ stageId: 'left' });
  });
});

describe('DebugRecorder on both channels', () => {
  it('a combined attach logs one pause row, not one per channel', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addPausableFunction('Gate', { execute: () => ({ question: 'ok?' }), resume: () => undefined }, 'gate')
      .build();
    const executor = new FlowChartExecutor(chart);
    const dbg = debug({ verbosity: 'minimal' });
    executor.attachCombinedRecorder(dbg);
    await executor.run();
    expect(dbg.getEntries().filter((e) => e.type === 'pause')).toHaveLength(1);
  });
});

describe('MetricRecorder duration', () => {
  it('spans every attempt and the wait between them', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction('Flaky', flaky(1), 'flaky')
      .retry({ attempts: 2, backoffMs: 30 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const met = metrics();
    executor.attachScopeRecorder(met);
    await executor.run();
    const [, flakyMetrics] = [...met.getMap()].find(([id]) => id.startsWith('flaky#'))!;
    expect(flakyMetrics.attempts).toBe(2);
    expect(flakyMetrics.duration).toBeGreaterThanOrEqual(25);
  });
});

describe('a scope-only attach', () => {
  it('QualityRecorder on the scope channel sees no attempt and scores as before', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addListOfFunction([
        { id: 'gives-up', name: 'Gives up', fn: flaky(9), retry: { attempts: 2 } },
        { id: 'fine', name: 'Fine', fn: () => undefined },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 1 }));
    executor.attachScopeRecorder(quality);
    await executor.run();
    expect(quality.values().some((e) => e.drop !== undefined)).toBe(false);
    expect(quality.values().map((e) => e.stageId)).not.toContain('gives-up');
  });
});

describe('parallel siblings', () => {
  it('Quality: an async sibling ending after a child that gave up never takes its row', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addListOfFunction([
        {
          id: 'slow',
          name: 'Slow',
          fn: async (scope: S) => {
            scope.r = 1;
            await sleep(20);
            scope.w = 1;
          },
        },
        {
          id: 'gives',
          name: 'Gives',
          fn: async (scope: S) => {
            if (scope.seed === 'never') return;
            await sleep(1);
            throw new Error('down');
          },
          retry: { attempts: 2 },
        },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 1 }));
    executor.attachCombinedRecorder(quality);
    await executor.run();
    const rows = Object.fromEntries([...quality.getMap()].map(([id, e]) => [id.split('#')[0], e]));
    expect(rows.gives).toMatchObject({ stageName: 'Gives', score: 0, drop: 'attempts', keysRead: ['seed'] });
    expect(rows.slow).toMatchObject({ stageName: 'Slow', score: 1, keysWritten: ['r', 'w'] });
    expect(rows.slow.drop).toBeUndefined();
  });

  it('Manifest: a parallel subflow that retried keeps its row on its own entry', async () => {
    let calls = 0;
    const a = flowChart<S>('A work', () => undefined, 'a-work').build();
    const b = flowChart<S>(
      'B work',
      async () => {
        calls += 1;
        await sleep(5);
        if (calls === 1) throw new Error('first');
      },
      'b-work',
    )
      .retry({ attempts: 2 })
      .build();
    // Two parallel subflow children: A exits first, but B entered after it, so A's exit pops B off the stack.
    const parallel = flowChart<S>('Seed', () => undefined, 'seed')
      .addSubFlowChart('sf-a', a, 'A')
      .addSubFlowChart('sf-b', b, 'B')
      .build();
    const executor = new FlowChartExecutor(parallel);
    const man = manifest();
    executor.attachCombinedRecorder(man);
    await executor.run();
    // The tree's NESTING of parallel siblings is the stack's (out of scope here); the row is on B's own entry.
    type Entry = ReturnType<typeof man.getManifest>[number];
    const flat = (entries: Entry[]): Entry[] => entries.flatMap((e) => [e, ...flat(e.children)]);
    const entryB = flat(man.getManifest()).find((e) => e.subflowId === 'sf-b');
    expect(entryB?.attempts?.map((r) => [r.stageId, r.attempts.count])).toEqual([['sf-b/b-work', 2]]);
    expect(man.getRootAttempts()).toEqual([]);
  });
});
