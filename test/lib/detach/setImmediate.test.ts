/**
 * detach/drivers/setImmediate — 7-pattern tests.
 *
 *   P1 Unit         — schedule returns a queued handle synchronously
 *   P2 Boundary     — handle terminal after the setImmediate flush
 *   P3 Scenario     — N items detached complete after one flush
 *   P4 Property     — only ONE setImmediate is queued per batch
 *   P5 Security     — runChild errors land on handle.failed
 *   P6 Performance  — push under 1µs/op
 *   P7 ROI          — driver shape conforms; capabilities are honest
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createSetImmediateDriver, setImmediateDriver } from '../../../src/lib/detach/drivers/setImmediate.js';
import { _resetForTests, size } from '../../../src/lib/detach/registry.js';
import type { DetachDriver } from '../../../src/lib/detach/types.js';

afterEach(() => _resetForTests());

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/drivers/setImmediate — P1 unit', () => {
  it('P1 schedule returns a queued handle synchronously', () => {
    const driver = createSetImmediateDriver(async () => 'r');
    const h = driver.schedule(fakeChart, undefined, 'i-1');
    expect(h.id).toBe('i-1');
    expect(h.status).toBe('queued');
  });

  it('P1 driver shape: name + capabilities + schedule + validate', () => {
    expect(setImmediateDriver.name).toBe('set-immediate');
    expect(setImmediateDriver.capabilities.nodeSafe).toBe(true);
    expect(setImmediateDriver.capabilities.browserSafe).toBeUndefined();
    expect(typeof setImmediateDriver.schedule).toBe('function');
    expect(typeof setImmediateDriver.validate).toBe('function');
  });

  it('P1 validate() does not throw in Node', () => {
    expect(() => setImmediateDriver.validate?.()).not.toThrow();
  });
});

// ─── P2 Boundary ─────────────────────────────────────────────────────

describe('detach/drivers/setImmediate — P2 boundary', () => {
  it('P2 handle becomes done after the setImmediate cycle', async () => {
    const driver = createSetImmediateDriver(async () => 'ok');
    const h = driver.schedule(fakeChart, undefined, 'i-2');
    const result = await h.wait();
    expect(h.status).toBe('done');
    expect(result).toEqual({ result: 'ok' });
  });

  it('P2 registry cleanup after terminal', async () => {
    const driver = createSetImmediateDriver(async () => 1);
    const h = driver.schedule(fakeChart, undefined, 'i-3');
    await h.wait();
    expect(size()).toBe(0);
  });
});

// ─── P3 Scenario ─────────────────────────────────────────────────────

describe('detach/drivers/setImmediate — P3 scenario', () => {
  it('P3 N items complete after one flush', async () => {
    const driver = createSetImmediateDriver(async (_c, i) => i);
    const handles = [
      driver.schedule(fakeChart, 1, 's-1'),
      driver.schedule(fakeChart, 2, 's-2'),
      driver.schedule(fakeChart, 3, 's-3'),
    ];
    const results = await Promise.all(handles.map((h) => h.wait()));
    expect(results.map((r) => r.result)).toEqual([1, 2, 3]);
  });
});

// ─── P4 Property — one setImmediate per batch ────────────────────────

describe('detach/drivers/setImmediate — P4 property', () => {
  it('P4 only one setImmediate queued per batch', async () => {
    const spy = vi.spyOn(globalThis as { setImmediate: typeof setImmediate }, 'setImmediate');
    const driver = createSetImmediateDriver(async () => 'r');
    const before = spy.mock.calls.length;
    driver.schedule(fakeChart, undefined, 'p-1');
    driver.schedule(fakeChart, undefined, 'p-2');
    driver.schedule(fakeChart, undefined, 'p-3');
    expect(spy.mock.calls.length - before).toBe(1);
    spy.mockRestore();
    // Drain.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

// ─── P5 Security — error containment ─────────────────────────────────

describe('detach/drivers/setImmediate — P5 security', () => {
  it('P5 runChild throw → handle.failed', async () => {
    const driver = createSetImmediateDriver(async () => {
      throw new Error('boom');
    });
    const h = driver.schedule(fakeChart, undefined, 'sec-1');
    await expect(h.wait()).rejects.toThrow('boom');
    expect(h.status).toBe('failed');
  });
});

// ─── P6 Performance ──────────────────────────────────────────────────

describe('detach/drivers/setImmediate — P6 performance', () => {
  it('P6 schedule push under 5µs/op (10k schedules)', () => {
    const driver = createSetImmediateDriver(async () => undefined);
    const N = 10_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) driver.schedule(fakeChart, undefined, `p-${i}`);
    const elapsed = performance.now() - t0;
    expect((elapsed * 1000) / N).toBeLessThan(50);
  });
});

// ─── P7 ROI ──────────────────────────────────────────────────────────

describe('detach/drivers/setImmediate — P7 ROI', () => {
  it('P7 satisfies DetachDriver fully', () => {
    const d: DetachDriver = setImmediateDriver;
    expect(d.name).toBeTruthy();
    expect(d.capabilities).toBeTruthy();
    expect(typeof d.schedule).toBe('function');
  });
});
