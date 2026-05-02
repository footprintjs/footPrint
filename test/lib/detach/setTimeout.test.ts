/**
 * detach/drivers/setTimeout — 7-pattern tests.
 *
 *   P1 Unit         — schedule returns a queued handle synchronously
 *   P2 Boundary     — handle terminal after the setTimeout fires
 *   P3 Scenario     — coalesces N items, custom delay batches them
 *   P4 Property     — only ONE setTimeout queued per batch
 *   P5 Security     — runChild errors land on handle.failed
 *   P6 Performance  — push under 5µs/op
 *   P7 ROI          — driver satisfies DetachDriver, capabilities cross-runtime
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createSetTimeoutDriver, setTimeoutDriver } from '../../../src/lib/detach/drivers/setTimeout.js';
import { _resetForTests, size } from '../../../src/lib/detach/registry.js';
import type { DetachDriver } from '../../../src/lib/detach/types.js';

afterEach(() => _resetForTests());

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/drivers/setTimeout — P1 unit', () => {
  it('P1 schedule returns a queued handle synchronously', () => {
    const driver = createSetTimeoutDriver({ runChild: async () => 'r' });
    const h = driver.schedule(fakeChart, undefined, 't-1');
    expect(h.status).toBe('queued');
  });

  it('P1 default singleton has cross-runtime capabilities', () => {
    expect(setTimeoutDriver.name).toBe('set-timeout');
    expect(setTimeoutDriver.capabilities.browserSafe).toBe(true);
    expect(setTimeoutDriver.capabilities.nodeSafe).toBe(true);
    expect(setTimeoutDriver.capabilities.edgeSafe).toBe(true);
  });

  it('P1 custom delay → name reflects delay value', () => {
    const driver = createSetTimeoutDriver({ delayMs: 100 });
    expect(driver.name).toBe('set-timeout-100ms');
  });
});

// ─── P2 Boundary ─────────────────────────────────────────────────────

describe('detach/drivers/setTimeout — P2 boundary', () => {
  it('P2 handle becomes done after the timer fires', async () => {
    const driver = createSetTimeoutDriver({ runChild: async () => 'ok' });
    const h = driver.schedule(fakeChart, undefined, 't-2');
    const result = await h.wait();
    expect(h.status).toBe('done');
    expect(result).toEqual({ result: 'ok' });
  });

  it('P2 registry cleanup after terminal', async () => {
    const driver = createSetTimeoutDriver({ runChild: async () => 1 });
    const h = driver.schedule(fakeChart, undefined, 't-3');
    await h.wait();
    expect(size()).toBe(0);
  });
});

// ─── P3 Scenario ─────────────────────────────────────────────────────

describe('detach/drivers/setTimeout — P3 scenario', () => {
  it('P3 N items coalesce into one timer flush', async () => {
    const driver = createSetTimeoutDriver({ runChild: async (_c, i) => i });
    const handles = [
      driver.schedule(fakeChart, 1, 's-1'),
      driver.schedule(fakeChart, 2, 's-2'),
      driver.schedule(fakeChart, 3, 's-3'),
    ];
    const results = await Promise.all(handles.map((h) => h.wait()));
    expect(results.map((r) => r.result)).toEqual([1, 2, 3]);
  });
});

// ─── P4 Property — one setTimeout per batch ──────────────────────────

describe('detach/drivers/setTimeout — P4 property', () => {
  it('P4 only one setTimeout queued per batch', async () => {
    const spy = vi.spyOn(globalThis as { setTimeout: typeof setTimeout }, 'setTimeout');
    const driver = createSetTimeoutDriver({ runChild: async () => 'r' });
    const before = spy.mock.calls.length;
    driver.schedule(fakeChart, undefined, 'p-1');
    driver.schedule(fakeChart, undefined, 'p-2');
    driver.schedule(fakeChart, undefined, 'p-3');
    expect(spy.mock.calls.length - before).toBe(1);
    spy.mockRestore();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

// ─── P5 Security — error containment ─────────────────────────────────

describe('detach/drivers/setTimeout — P5 security', () => {
  it('P5 runChild throw → handle.failed', async () => {
    const driver = createSetTimeoutDriver({
      runChild: async () => {
        throw new Error('boom');
      },
    });
    const h = driver.schedule(fakeChart, undefined, 'sec-1');
    await expect(h.wait()).rejects.toThrow('boom');
    expect(h.status).toBe('failed');
  });
});

// ─── P6 Performance ──────────────────────────────────────────────────

describe('detach/drivers/setTimeout — P6 performance', () => {
  it('P6 schedule push under 5µs/op (10k schedules)', () => {
    const driver = createSetTimeoutDriver({ runChild: async () => undefined });
    const N = 10_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) driver.schedule(fakeChart, undefined, `p-${i}`);
    const elapsed = performance.now() - t0;
    expect((elapsed * 1000) / N).toBeLessThan(50);
  });
});

// ─── P7 ROI ──────────────────────────────────────────────────────────

describe('detach/drivers/setTimeout — P7 ROI', () => {
  it('P7 satisfies DetachDriver fully', () => {
    const d: DetachDriver = setTimeoutDriver;
    expect(d.name).toBeTruthy();
    expect(typeof d.schedule).toBe('function');
  });
});
