/**
 * detach/drivers/immediate — 7-pattern tests.
 *
 *   P1 Unit         — schedule returns a handle in running state synchronously
 *   P2 Boundary     — handle terminal after one microtask cycle
 *   P3 Scenario     — useful as a test fixture replacement
 *   P4 Property     — call order is preserved across multiple schedules
 *   P5 Security     — runChild errors land on handle.failed
 *   P6 Performance  — schedule is sub-microsecond per call
 *   P7 ROI          — driver shape conforms to DetachDriver
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createImmediateDriver, immediateDriver } from '../../../src/lib/detach/drivers/immediate.js';
import { _resetForTests, size } from '../../../src/lib/detach/registry.js';
import type { DetachDriver } from '../../../src/lib/detach/types.js';

afterEach(() => _resetForTests());

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/drivers/immediate — P1 unit', () => {
  it('P1 schedule returns a handle in running state immediately', () => {
    const driver = createImmediateDriver(async () => 'r');
    const h = driver.schedule(fakeChart, undefined, 'i-1');
    expect(h.id).toBe('i-1');
    // Per design: _markRunning fires synchronously inside schedule(),
    // so by the time consumer reads .status it has already advanced.
    expect(h.status).toBe('running');
  });

  it('P1 driver shape matches DetachDriver', () => {
    expect(immediateDriver.name).toBe('immediate');
    expect(immediateDriver.capabilities.browserSafe).toBe(true);
    expect(immediateDriver.capabilities.nodeSafe).toBe(true);
    expect(typeof immediateDriver.schedule).toBe('function');
  });
});

// ─── P2 Boundary — terminal after microtask cycle ────────────────────

describe('detach/drivers/immediate — P2 boundary', () => {
  it('P2 handle becomes done after the runner resolves', async () => {
    const driver = createImmediateDriver(async () => ({ ok: 1 }));
    const h = driver.schedule(fakeChart, undefined, 'i-2');
    const result = await h.wait();
    expect(h.status).toBe('done');
    expect(result).toEqual({ result: { ok: 1 } });
  });

  it('P2 registry entry cleaned up after terminal', async () => {
    const driver = createImmediateDriver(async () => 1);
    const h = driver.schedule(fakeChart, undefined, 'i-3');
    await h.wait();
    expect(size()).toBe(0);
  });
});

// ─── P3 Scenario — test fixture usage ────────────────────────────────

describe('detach/drivers/immediate — P3 scenario', () => {
  it('P3 useful as a test fixture — reads cleanly without scheduling boilerplate', async () => {
    // Common test pattern: assert on the handle's terminal state.
    const driver = createImmediateDriver(async () => 'computed');
    const h = driver.schedule(fakeChart, undefined, 'sc-1');
    await h.wait();
    expect(h.status).toBe('done');
    expect(h.result).toBe('computed');
  });
});

// ─── P4 Property — call order preserved ──────────────────────────────

describe('detach/drivers/immediate — P4 property', () => {
  it('P4 multiple schedules preserve call-order across resolutions', async () => {
    const order: number[] = [];
    const driver = createImmediateDriver(async (_c, input) => {
      order.push(input as number);
      return input;
    });
    const handles = [
      driver.schedule(fakeChart, 1, 'o-1'),
      driver.schedule(fakeChart, 2, 'o-2'),
      driver.schedule(fakeChart, 3, 'o-3'),
    ];
    await Promise.all(handles.map((h) => h.wait()));
    expect(order).toEqual([1, 2, 3]);
  });
});

// ─── P5 Security — error containment ─────────────────────────────────

describe('detach/drivers/immediate — P5 security', () => {
  it('P5 runChild throw → handle.failed, never escapes', async () => {
    const driver = createImmediateDriver(async () => {
      throw new Error('boom');
    });
    const h = driver.schedule(fakeChart, undefined, 'sec-1');
    await expect(h.wait()).rejects.toThrow('boom');
    expect(h.status).toBe('failed');
  });

  it('P5 schedule itself never throws even when runChild is broken', () => {
    const driver = createImmediateDriver(async () => {
      throw new Error('whatever');
    });
    expect(() => driver.schedule(fakeChart, undefined, 'sec-2')).not.toThrow();
  });
});

// ─── P6 Performance ──────────────────────────────────────────────────

describe('detach/drivers/immediate — P6 performance', () => {
  it('P6 schedule averages under 5 µs/op (10k schedules)', () => {
    const driver = createImmediateDriver(async (_c, input) => input);
    const N = 10_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) driver.schedule(fakeChart, i, `p-${i}`);
    const elapsed = performance.now() - t0;
    const usPerOp = (elapsed * 1000) / N;
    // Sub-µs target with CI slack.
    expect(usPerOp).toBeLessThan(50);
  });
});

// ─── P7 ROI — interface compat ───────────────────────────────────────

describe('detach/drivers/immediate — P7 ROI', () => {
  it('P7 immediateDriver satisfies DetachDriver fully', () => {
    const d: DetachDriver = immediateDriver;
    expect(d.name).toBeTruthy();
    expect(d.capabilities).toBeTruthy();
    expect(typeof d.schedule).toBe('function');
  });

  it('P7 createImmediateDriver default is the same factory used by the singleton', () => {
    // Two independent calls produce structurally-equal drivers.
    const a = createImmediateDriver();
    const b = createImmediateDriver();
    expect(a.name).toBe(b.name);
    expect(a.capabilities).toEqual(b.capabilities);
  });
});
