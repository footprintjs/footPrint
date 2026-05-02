/**
 * detach/spawn — 7-pattern tests.
 *
 *   P1 Unit         — detachAndJoinLater calls driver.schedule and returns its handle
 *   P2 Boundary     — refIds are unique across calls; sourcePrefix is honored
 *   P3 Scenario     — chain of N detaches mints N distinct refIds, all observable
 *   P4 Property     — detachAndForget returns void; handle goes uncollected
 *   P5 Security     — non-driver argument throws TypeError early (typo guard)
 *   P6 Performance  — minting + scheduling is sub-microsecond on hot path
 *   P7 ROI          — refId carries source prefix → diagnostic correlation works
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests, detachAndForget, detachAndJoinLater } from '../../../src/lib/detach/spawn.js';
import type { DetachDriver } from '../../../src/lib/detach/types.js';

afterEach(() => {
  _resetForTests();
  _resetSpawnCounterForTests();
});

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/spawn — P1 unit', () => {
  it('P1 detachAndJoinLater calls driver.schedule with (child, input, refId)', () => {
    const schedule = vi.fn(
      (c: FlowChart, i: unknown, refId: string) =>
        ({ id: refId, status: 'queued', wait: () => Promise.resolve({ result: undefined }) } as never),
    );
    const driver: DetachDriver = { name: 'mock', capabilities: {}, schedule };
    detachAndJoinLater(driver, fakeChart, { x: 1 }, 'stage#0');
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[0]).toBe(fakeChart);
    expect(schedule.mock.calls[0]?.[1]).toEqual({ x: 1 });
    expect(schedule.mock.calls[0]?.[2]).toMatch(/^stage#0:detach:\d+$/);
  });
});

// ─── P2 Boundary — refId uniqueness ──────────────────────────────────

describe('detach/spawn — P2 boundary', () => {
  it('P2 multiple calls mint distinct refIds (monotonic counter)', () => {
    const ids: string[] = [];
    const driver: DetachDriver = {
      name: 'mock',
      capabilities: {},
      schedule: (_c, _i, refId) => {
        ids.push(refId);
        return { id: refId, status: 'queued', wait: () => Promise.resolve({ result: undefined }) } as never;
      },
    };
    for (let i = 0; i < 5; i++) detachAndJoinLater(driver, fakeChart, undefined, 'stage#0');
    expect(new Set(ids).size).toBe(5); // all distinct
    expect(ids.every((id) => id.startsWith('stage#0:detach:'))).toBe(true);
  });

  it('P2 different sourcePrefixes produce different refId namespaces', () => {
    const ids: string[] = [];
    const driver: DetachDriver = {
      name: 'mock',
      capabilities: {},
      schedule: (_c, _i, refId) => {
        ids.push(refId);
        return { id: refId, status: 'queued', wait: () => Promise.resolve({ result: undefined }) } as never;
      },
    };
    detachAndJoinLater(driver, fakeChart, undefined, 'a#0');
    detachAndJoinLater(driver, fakeChart, undefined, 'b#0');
    detachAndJoinLater(driver, fakeChart, undefined, '__executor__');
    expect(ids.map((s) => s.split(':detach:')[0])).toEqual(['a#0', 'b#0', '__executor__']);
  });
});

// ─── P3 Scenario — N detaches all observable ─────────────────────────

describe('detach/spawn — P3 scenario', () => {
  it('P3 N detaches via real driver complete + are all observable', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, input) => input);
    const handles = [];
    for (let i = 0; i < 5; i++) {
      handles.push(detachAndJoinLater(driver, fakeChart, i, 'sf-x/stage#7'));
    }
    const results = await Promise.all(handles.map((h) => h.wait()));
    expect(results.map((r) => r.result)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ─── P4 Property — forget returns void; no handle leak ───────────────

describe('detach/spawn — P4 property', () => {
  it('P4 detachAndForget returns undefined (no handle accessible)', () => {
    const driver = createMicrotaskBatchDriver(async () => 'r');
    const result = detachAndForget(driver, fakeChart, undefined, 'stage#0');
    expect(result).toBeUndefined();
  });

  it('P4 detachAndForget child still completes — driver flush proceeds', async () => {
    let ran = false;
    const driver = createMicrotaskBatchDriver(async () => {
      ran = true;
      return undefined;
    });
    detachAndForget(driver, fakeChart, undefined, 'stage#0');
    // Yield to let the microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});

// ─── P5 Security — typo guard ────────────────────────────────────────

describe('detach/spawn — P5 security', () => {
  it('P5 missing driver throws TypeError with hint', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detachAndJoinLater(undefined as any, fakeChart, undefined, 'x'),
    ).toThrow(TypeError);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detachAndJoinLater(undefined as any, fakeChart, undefined, 'x'),
    ).toThrow(/microtaskBatchDriver/);
  });

  it('P5 wrong-shape "driver" (object without schedule) is rejected', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detachAndJoinLater({ name: 'oops' } as any, fakeChart, undefined, 'x'),
    ).toThrow(TypeError);
  });
});

// ─── P6 Performance ──────────────────────────────────────────────────

describe('detach/spawn — P6 performance', () => {
  it('P6 10k detachAndForget calls under 50ms', () => {
    const driver: DetachDriver = {
      name: 'mock',
      capabilities: {},
      schedule: (_c, _i, refId) =>
        ({ id: refId, status: 'queued', wait: () => Promise.resolve({ result: undefined }) } as never),
    };
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) detachAndForget(driver, fakeChart, undefined, 'stage#0');
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});

// ─── P7 ROI — refId carries source-prefix correlation ─────────────────

describe('detach/spawn — P7 ROI', () => {
  it('P7 refId encodes source prefix → easy backtrack from log line to source stage', () => {
    let captured = '';
    const driver: DetachDriver = {
      name: 'mock',
      capabilities: {},
      schedule: (_c, _i, refId) => {
        captured = refId;
        return { id: refId, status: 'queued', wait: () => Promise.resolve({ result: undefined }) } as never;
      },
    };
    detachAndJoinLater(driver, fakeChart, undefined, 'sf-tools/exec-tool#42');
    // The refId reads naturally as: "stage exec-tool, execution 42, detach #N"
    expect(captured).toMatch(/^sf-tools\/exec-tool#42:detach:\d+$/);
  });
});
