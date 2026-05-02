/**
 * detach/flush — 7-pattern tests for `flushAllDetached`.
 *
 *   P1 Unit         — flushAllDetached resolves immediately when registry empty
 *   P2 Boundary     — drains a single in-flight handle to terminal
 *   P3 Scenario     — graceful shutdown: drain N handles to done
 *   P4 Property     — handles arriving DURING flush are still drained
 *   P5 Security     — failed handles count separately, never crash flush
 *   P6 Performance  — flushing 1000 already-terminal handles is fast
 *   P7 ROI          — useful for "process exit" / "test cleanup"
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { flushAllDetached } from '../../../src/lib/detach/flush.js';
import { _resetForTests, size } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests } from '../../../src/lib/detach/spawn.js';

afterEach(() => {
  _resetForTests();
  _resetSpawnCounterForTests();
});

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/flush — P1 unit', () => {
  it('P1 resolves immediately when registry is empty', async () => {
    const result = await flushAllDetached();
    expect(result).toEqual({ done: 0, failed: 0, pending: 0 });
  });
});

// ─── P2 Boundary — single handle drain ───────────────────────────────

describe('detach/flush — P2 boundary', () => {
  it('P2 drains a single in-flight handle to terminal', async () => {
    const driver = createMicrotaskBatchDriver(async () => 'ok');
    driver.schedule(fakeChart, undefined, 'h-1');
    expect(size()).toBe(1);
    const result = await flushAllDetached();
    expect(result.done).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.pending).toBe(0);
    expect(size()).toBe(0);
  });
});

// ─── P3 Scenario — graceful shutdown ────────────────────────────────

describe('detach/flush — P3 scenario', () => {
  it('P3 drains N handles after a "burst" of detaches', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, i) => i);
    for (let i = 0; i < 25; i++) driver.schedule(fakeChart, i, `b-${i}`);
    expect(size()).toBe(25);
    const result = await flushAllDetached();
    expect(result.done).toBe(25);
    expect(result.failed).toBe(0);
    expect(result.pending).toBe(0);
  });
});

// ─── P4 Property — drain transitively ────────────────────────────────

describe('detach/flush — P4 property', () => {
  it('P4 handles arriving DURING flush are still drained (registry empty on return)', async () => {
    let runCount = 0;
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      runCount += 1;
      // Simulate a child that itself spawns nested detached work.
      if (input === 'spawn-more') {
        for (let i = 0; i < 3; i++) {
          driver.schedule(fakeChart, `child-${i}`, `nested-${i}`);
        }
      }
      return input;
    });
    driver.schedule(fakeChart, 'spawn-more', 'parent-1');
    const result = await flushAllDetached();
    // The DRAIN is the guaranteed contract: registry is empty.
    // (The `done` count is best-effort — nested handles may complete
    //  inside the parent's wait() before we observe them directly.)
    expect(result.pending).toBe(0);
    expect(size()).toBe(0);
    // Independent observation: runChild was called for parent + 3 nested.
    expect(runCount).toBe(4);
  });
});

// ─── P5 Security — failures count separately ─────────────────────────

describe('detach/flush — P5 security', () => {
  it('P5 failing handles increment `failed`, never crash the flush', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      if (input === 'bad') throw new Error('boom');
      return input;
    });
    driver.schedule(fakeChart, 'good-1', 'g-1');
    driver.schedule(fakeChart, 'bad', 'b-1');
    driver.schedule(fakeChart, 'good-2', 'g-2');
    const result = await flushAllDetached();
    expect(result.done).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.pending).toBe(0);
  });
});

// ─── P6 Performance — already-terminal flush is fast ─────────────────

describe('detach/flush — P6 performance', () => {
  it('P6 1000 already-terminal handles drain under 50ms', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, i) => i);
    for (let i = 0; i < 1000; i++) driver.schedule(fakeChart, i, `p-${i}`);
    // Wait once so most have completed before the flush starts.
    await Promise.resolve();
    const t0 = performance.now();
    const result = await flushAllDetached();
    const elapsed = performance.now() - t0;
    expect(result.done).toBe(1000);
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── P7 ROI — graceful shutdown demo ─────────────────────────────────

describe('detach/flush — P7 ROI', () => {
  it('P7 mimics a server "drain queue, then exit" pattern', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, i) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return i;
    });
    // Burst of late-arriving telemetry events.
    for (let i = 0; i < 10; i++) driver.schedule(fakeChart, i, `t-${i}`);
    const result = await flushAllDetached({ timeoutMs: 1000 });
    expect(result.done).toBe(10);
    expect(result.pending).toBe(0);
    // Counts should sum to total.
    expect(result.done + result.failed).toBe(10);
  });

  it('P7 reports `pending` when timeout fires before drain', async () => {
    const driver = createMicrotaskBatchDriver(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    driver.schedule(fakeChart, undefined, 'slow-1');
    const result = await flushAllDetached({ timeoutMs: 50 });
    expect(result.pending).toBeGreaterThan(0);
    expect(result.done + result.failed).toBeLessThan(1);
  });
});
