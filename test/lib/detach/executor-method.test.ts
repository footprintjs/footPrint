/**
 * detach/executor-method — 7-pattern tests for `executor.detachAndJoinLater`
 *                          and `executor.detachAndForget`.
 *
 *   P1 Unit         — executor.detachAndJoinLater returns a DetachHandle
 *   P2 Boundary     — refId uses the synthetic `__executor__` source-prefix
 *   P3 Scenario     — detach from outside any chart; await result
 *   P4 Property     — bare-executor and scope-method paths share the same spawn helper
 *   P5 Security     — TypeError on missing driver — same as scope path
 *   P6 Performance  — N/A (covered in spawn.test.ts P6)
 *   P7 ROI          — useful for "I have a chart and want to fire other things alongside"
 */

import { afterEach, describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/index.js';
import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests } from '../../../src/lib/detach/spawn.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';

afterEach(() => {
  _resetForTests();
  _resetSpawnCounterForTests();
});

const childChart = { root: {}, subflows: {} } as unknown as FlowChart;

// A trivial host chart; the executor instance is the unit under test.
const hostChart = flowChart('noop', async () => {}, 'noop').build();

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/executor-method — P1 unit', () => {
  it('P1 executor.detachAndJoinLater returns a DetachHandle', async () => {
    const driver = createMicrotaskBatchDriver(async () => 'r');
    const exec = new FlowChartExecutor(hostChart);
    const h = exec.detachAndJoinLater(driver, childChart, undefined);
    expect(h.id).toMatch(/^__executor__:detach:\d+$/);
    expect(h.status).toBe('queued');
    const result = await h.wait();
    expect(result).toEqual({ result: 'r' });
  });
});

// ─── P2 Boundary — synthetic prefix ──────────────────────────────────

describe('detach/executor-method — P2 boundary', () => {
  it('P2 refId uses __executor__ prefix (no source stage available)', () => {
    let captured = '';
    const driver = createMicrotaskBatchDriver(async () => undefined);
    const original = driver.schedule;
    (driver as { schedule: typeof original }).schedule = (c, i, refId) => {
      captured = refId;
      return original(c, i, refId);
    };
    const exec = new FlowChartExecutor(hostChart);
    exec.detachAndForget(driver, childChart, undefined);
    expect(captured).toMatch(/^__executor__:detach:\d+$/);
  });
});

// ─── P3 Scenario — fire from outside any chart ───────────────────────

describe('detach/executor-method — P3 scenario', () => {
  it('P3 fire 3 detaches, await all', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, i) => i);
    const exec = new FlowChartExecutor(hostChart);
    const handles = [
      exec.detachAndJoinLater(driver, childChart, 'a'),
      exec.detachAndJoinLater(driver, childChart, 'b'),
      exec.detachAndJoinLater(driver, childChart, 'c'),
    ];
    const results = await Promise.all(handles.map((h) => h.wait()));
    expect(results.map((r) => r.result)).toEqual(['a', 'b', 'c']);
  });
});

// ─── P4 Property — same spawn helper for both paths ──────────────────

describe('detach/executor-method — P4 property', () => {
  it('P4 bare-executor refIds and scope-method refIds coexist (different prefixes)', async () => {
    const observed: string[] = [];
    const driver = createMicrotaskBatchDriver(async () => undefined);
    const original = driver.schedule;
    (driver as { schedule: typeof original }).schedule = (c, i, refId) => {
      observed.push(refId);
      return original(c, i, refId);
    };

    interface S {
      _?: never;
    }
    const chart = flowChart<S>(
      'host',
      async (scope) => {
        scope.$detachAndForget(driver, childChart, undefined);
      },
      'host',
    ).build();

    const exec = new FlowChartExecutor(chart);
    exec.detachAndForget(driver, childChart, undefined); // bare-executor
    await exec.run(); // scope-method fires inside `host` stage
    exec.detachAndForget(driver, childChart, undefined); // bare-executor again

    const prefixes = observed.map((s) => s.split(':detach:')[0]);
    expect(prefixes).toEqual(['__executor__', 'host#0', '__executor__']);
  });
});

// ─── P5 Security — typo guard ────────────────────────────────────────

describe('detach/executor-method — P5 security', () => {
  it('P5 missing driver throws TypeError', () => {
    const exec = new FlowChartExecutor(hostChart);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec.detachAndJoinLater(undefined as any, childChart, undefined),
    ).toThrow(TypeError);
  });
});

// ─── P7 ROI — useful for fan-out from outside a chart ────────────────

describe('detach/executor-method — P7 ROI', () => {
  it('P7 useful for "fire side-effect chart alongside main chart"', async () => {
    const sideEffects: string[] = [];
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      sideEffects.push(input as string);
      return undefined;
    });
    const exec = new FlowChartExecutor(hostChart);
    // Fire side-effects, then run the main chart.
    exec.detachAndForget(driver, childChart, 'analytics-1');
    exec.detachAndForget(driver, childChart, 'audit-1');
    await exec.run();
    // Yield for microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(sideEffects.sort()).toEqual(['analytics-1', 'audit-1']);
  });
});
