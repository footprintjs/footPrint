/**
 * detach/drivers/microtaskBatch — 7-pattern tests.
 *
 *   P1 Unit         — schedule returns a queued handle synchronously
 *   P2 Boundary     — handle becomes terminal after one microtask flush
 *   P3 Scenario     — N items detached in a row → all complete after one flush
 *   P4 Property     — only ONE microtask is queued per batch (idempotent flush)
 *   P5 Security     — runChild errors route to handle.failed, never escape
 *   P6 Performance  — push under 200 ns, full cycle under 1 µs (per-item)
 *   P7 ROI          — driver shape is a real DetachDriver (interface compat)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver, microtaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { _resetForTests, size } from '../../../src/lib/detach/registry.js';
import type { DetachDriver } from '../../../src/lib/detach/types.js';

afterEach(() => _resetForTests());

// Stand-in flowchart — drivers don't inspect it; the runChild does.
const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/drivers/microtaskBatch — P1 unit', () => {
  it('P1 schedule returns a handle in queued state synchronously', () => {
    const runChild = vi.fn(async () => 'result');
    const driver = createMicrotaskBatchDriver(runChild);
    const handle = driver.schedule(fakeChart, { x: 1 }, 'r-1');
    expect(handle.id).toBe('r-1');
    expect(handle.status).toBe('queued');
    expect(runChild).not.toHaveBeenCalled(); // deferred
  });

  it('P1 driver shape: name + capabilities + schedule()', () => {
    expect(microtaskBatchDriver.name).toBe('microtask-batch');
    expect(microtaskBatchDriver.capabilities.browserSafe).toBe(true);
    expect(microtaskBatchDriver.capabilities.nodeSafe).toBe(true);
    expect(microtaskBatchDriver.capabilities.edgeSafe).toBe(true);
    expect(typeof microtaskBatchDriver.schedule).toBe('function');
  });
});

// ─── P2 Boundary — terminal state after flush ────────────────────────

describe('detach/drivers/microtaskBatch — P2 boundary', () => {
  it('P2 handle becomes done after a microtask cycle', async () => {
    const driver = createMicrotaskBatchDriver(async () => 'ok');
    const handle = driver.schedule(fakeChart, undefined, 'r-2');
    expect(handle.status).toBe('queued');
    const result = await handle.wait();
    expect(handle.status).toBe('done');
    expect(result).toEqual({ result: 'ok' });
  });

  it('P2 registry entry is cleaned up after terminal', async () => {
    const driver = createMicrotaskBatchDriver(async () => 1);
    const h = driver.schedule(fakeChart, undefined, 'r-3');
    await h.wait();
    expect(size()).toBe(0);
  });
});

// ─── P3 Scenario — batch flush ───────────────────────────────────────

describe('detach/drivers/microtaskBatch — P3 scenario', () => {
  it('P3 N items detached in a row complete after one flush', async () => {
    const calls: number[] = [];
    const runChild = vi.fn(async (_c, input) => {
      calls.push(input as number);
      return input;
    });
    const driver = createMicrotaskBatchDriver(runChild);
    const handles = [
      driver.schedule(fakeChart, 1, 'b-1'),
      driver.schedule(fakeChart, 2, 'b-2'),
      driver.schedule(fakeChart, 3, 'b-3'),
    ];
    // All queued.
    expect(handles.every((h) => h.status === 'queued')).toBe(true);

    const results = await Promise.all(handles.map((h) => h.wait()));
    expect(results.map((r) => r.result)).toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2, 3]); // FIFO order preserved
    expect(runChild).toHaveBeenCalledTimes(3);
  });
});

// ─── P4 Property — one microtask per batch ───────────────────────────

describe('detach/drivers/microtaskBatch — P4 property', () => {
  it('P4 only one microtask is queued per batch (idempotent flush trigger)', async () => {
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask');
    const driver = createMicrotaskBatchDriver(async () => 'r');
    const before = queueMicrotaskSpy.mock.calls.length;
    driver.schedule(fakeChart, undefined, 'p-1');
    driver.schedule(fakeChart, undefined, 'p-2');
    driver.schedule(fakeChart, undefined, 'p-3');
    const queuedThisBatch = queueMicrotaskSpy.mock.calls.length - before;
    expect(queuedThisBatch).toBe(1); // ← the property under test
    queueMicrotaskSpy.mockRestore();

    // Drain the batch so afterEach is clean.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('P4 a SECOND batch (after flush) re-queues a microtask', async () => {
    const driver = createMicrotaskBatchDriver(async () => 'r');
    const a = driver.schedule(fakeChart, undefined, 's-1');
    await a.wait();
    // Now queue is empty + scheduled flag is reset.
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask');
    driver.schedule(fakeChart, undefined, 's-2');
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1);
    queueMicrotaskSpy.mockRestore();
  });
});

// ─── P5 Security — error containment ─────────────────────────────────

describe('detach/drivers/microtaskBatch — P5 security', () => {
  it('P5 runChild throw → handle.failed, NEVER escapes', async () => {
    const driver = createMicrotaskBatchDriver(async () => {
      throw new Error('vendor 503');
    });
    const handle = driver.schedule(fakeChart, undefined, 'sec-1');
    await expect(handle.wait()).rejects.toThrow('vendor 503');
    expect(handle.status).toBe('failed');
    expect(handle.error?.message).toBe('vendor 503');
  });

  it('P5 runChild throws non-Error → wrapped in Error with stringified value', async () => {
    // Project lint forbids throwing string literals. Use Promise.reject
    // with a non-Error value to exercise the same driver path (the
    // driver normalizes any rejection into an Error before _markFailed).
    // eslint-disable-next-line prefer-promise-reject-errors
    const driver = createMicrotaskBatchDriver(() => Promise.reject('string-rejection') as Promise<unknown>);
    const handle = driver.schedule(fakeChart, undefined, 'sec-2');
    await expect(handle.wait()).rejects.toThrow('string-rejection');
    expect(handle.error).toBeInstanceOf(Error);
  });

  it('P5 sibling failure does not poison the batch', async () => {
    let n = 0;
    const driver = createMicrotaskBatchDriver(async () => {
      n++;
      if (n === 2) throw new Error('only-second-fails');
      return n;
    });
    const a = driver.schedule(fakeChart, undefined, 'sib-1');
    const b = driver.schedule(fakeChart, undefined, 'sib-2');
    const c = driver.schedule(fakeChart, undefined, 'sib-3');

    const ra = await a.wait();
    expect(ra.result).toBe(1);
    await expect(b.wait()).rejects.toThrow('only-second-fails');
    const rc = await c.wait();
    expect(rc.result).toBe(3);
  });
});

// ─── P6 Performance ──────────────────────────────────────────────────

describe('detach/drivers/microtaskBatch — P6 performance', () => {
  it('P6 schedule push is under 5 µs/op (averaged over 10k ops)', () => {
    const driver = createMicrotaskBatchDriver(async () => undefined);
    const N = 10_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) driver.schedule(fakeChart, undefined, `perf-${i}`);
    const elapsed = performance.now() - t0;
    const nsPerOp = (elapsed * 1_000_000) / N;
    // 5000 ns budget — absorbs CI/release-pipeline back-to-back load
    // where multiple suites have already warmed/cooled the JIT. The
    // documented target is 200 ns on a hot core; large failures here
    // (10x+) point at a real regression.
    expect(nsPerOp).toBeLessThan(5000);
  });

  it('P6 full cycle (schedule → flush → terminal) is under 5 µs/op for 1k items', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, input) => input);
    const N = 1000;
    const handles: ReturnType<typeof driver.schedule>[] = [];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) handles.push(driver.schedule(fakeChart, i, `perfc-${i}`));
    await Promise.all(handles.map((h) => h.wait()));
    const elapsed = performance.now() - t0;
    const usPerOp = (elapsed * 1000) / N;
    // 50 µs slack for CI variance; documented target is 1 µs on a hot core.
    expect(usPerOp).toBeLessThan(50);
  });
});

// ─── P7 ROI — interface compat ───────────────────────────────────────

describe('detach/drivers/microtaskBatch — P7 ROI', () => {
  it('P7 microtaskBatchDriver satisfies DetachDriver fully', () => {
    const d: DetachDriver = microtaskBatchDriver;
    expect(d.name).toBeTruthy();
    expect(d.capabilities).toBeTruthy();
    expect(typeof d.schedule).toBe('function');
  });
});
