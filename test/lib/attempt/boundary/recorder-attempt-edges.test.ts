/**
 * The edges of the recorders' attempt rows (P1c, design §5.1).
 *
 * Test types: Boundary (a chosen decider branch that retries hangs under its decision-branch node; a combined attach
 * of the DebugRecorder never doubles a scope row on the flow channel; the metric duration spans the waits; a
 * recorder attached on the scope channel alone sees no attempt and scores as before).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { debug, metrics } from '../../../../src/recorders.js';
import { QualityRecorder, topologyRecorder } from '../../../../src/trace.js';

type S = Record<string, unknown>;

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
