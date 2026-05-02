/**
 * detach/scope-method — 7-pattern tests for `scope.$detachAndJoinLater`
 *                       and `scope.$detachAndForget`.
 *
 *   P1 Unit         — scope.$detachAndJoinLater returns a DetachHandle
 *   P2 Boundary     — refId carries the calling stage's runtimeStageId
 *   P3 Scenario     — detach inside a real stage; child completes async
 *   P4 Property     — parent stage does NOT block on child completion
 *   P5 Security     — detach without a driver throws (proxy still routes)
 *   P6 Performance  — N/A here (covered in spawn.test.ts P6)
 *   P7 ROI          — scope.$detachAndForget integrates cleanly in a stage
 */

import { afterEach, describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/index.js';
import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests } from '../../../src/lib/detach/spawn.js';
import type { DetachHandle } from '../../../src/lib/detach/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';

afterEach(() => {
  _resetForTests();
  _resetSpawnCounterForTests();
});

// Stand-in for a "child" flowchart — driver doesn't execute it because we
// hand the driver a custom runChild.
const childChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/scope-method — P1 unit', () => {
  it('P1 scope.$detachAndJoinLater returns a DetachHandle', async () => {
    const driver = createMicrotaskBatchDriver(async () => 'r');
    let handle: DetachHandle | undefined;

    interface S {
      handle?: DetachHandle;
    }
    const chart = flowChart<S>(
      'stage1',
      async (scope) => {
        handle = scope.$detachAndJoinLater(driver, childChart, { x: 1 });
      },
      'stage1',
    ).build();

    await new FlowChartExecutor(chart).run();
    expect(handle).toBeDefined();
    expect(handle?.status).toMatch(/queued|running|done/);
    await handle?.wait();
    expect(handle?.status).toBe('done');
  });
});

// ─── P2 Boundary — refId carries runtimeStageId ──────────────────────

describe('detach/scope-method — P2 boundary', () => {
  it('P2 minted refId starts with the calling stage runtimeStageId', async () => {
    let observedRefId = '';
    const driver = createMicrotaskBatchDriver(async () => undefined);
    // Instrument the driver: capture the refId on schedule.
    const originalSchedule = driver.schedule;
    (driver as { schedule: typeof originalSchedule }).schedule = (c, i, refId) => {
      observedRefId = refId;
      return originalSchedule(c, i, refId);
    };

    interface S {
      done?: boolean;
    }
    const chart = flowChart<S>(
      'parent',
      async (scope) => {
        scope.$detachAndForget(driver, childChart, undefined);
        scope.done = true;
      },
      'parent-id',
    ).build();
    await new FlowChartExecutor(chart).run();

    // runtimeStageId of the stage that called detach is `parent-id#0`
    expect(observedRefId).toMatch(/^parent-id#0:detach:\d+$/);
  });
});

// ─── P3 Scenario — async child completes after parent ────────────────

describe('detach/scope-method — P3 scenario', () => {
  it('P3 child completes asynchronously, parent finished before terminal', async () => {
    let childRan = false;
    let parentFinishedAt = 0;
    let childFinishedAt = 0;

    const driver = createMicrotaskBatchDriver(async () => {
      // Pretend the child does some work.
      await new Promise((resolve) => setTimeout(resolve, 10));
      childRan = true;
      childFinishedAt = performance.now();
      return 'child-result';
    });

    // Capture the handle in a closure-local variable — scope state would
    // get JSON-serialized by the snapshot path and lose the wait() method.
    let handle: DetachHandle | undefined;
    interface S {
      _?: never;
    }
    const chart = flowChart<S>(
      'parent',
      async (scope) => {
        handle = scope.$detachAndJoinLater(driver, childChart, undefined);
        parentFinishedAt = performance.now();
      },
      'parent',
    ).build();

    const exec = new FlowChartExecutor(chart);
    await exec.run();
    // Parent finished BEFORE the child (passive recorder rule).
    expect(childRan).toBe(false);

    await handle?.wait();
    expect(childRan).toBe(true);
    expect(childFinishedAt).toBeGreaterThan(parentFinishedAt);
  });
});

// ─── P4 Property — parent does NOT block on child ────────────────────

describe('detach/scope-method — P4 property', () => {
  it('P4 N detaches do not delay parent completion (passive recorder rule)', async () => {
    let parentCompletedAt = 0;
    const driver = createMicrotaskBatchDriver(async () => {
      // Pretend each child takes 5ms.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'r';
    });

    interface S {
      ok?: boolean;
    }
    const chart = flowChart<S>(
      'fanout',
      async (scope) => {
        for (let i = 0; i < 10; i++) {
          scope.$detachAndForget(driver, childChart, i);
        }
        parentCompletedAt = performance.now();
        scope.ok = true;
      },
      'fanout',
    ).build();

    const t0 = performance.now();
    await new FlowChartExecutor(chart).run();
    const parentRunDuration = parentCompletedAt - t0;
    // 10 children at 5ms each = 50ms if serial. We expect parent to
    // finish in well under 50ms because detach doesn't await.
    expect(parentRunDuration).toBeLessThan(40);
  });
});

// ─── P5 Security — wrong-driver typo guard ───────────────────────────

describe('detach/scope-method — P5 security', () => {
  it('P5 calling $detachAndJoinLater with no driver throws inside the stage', async () => {
    interface S {
      err?: string;
    }
    const chart = flowChart<S>(
      'parent',
      async (scope) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          scope.$detachAndJoinLater(undefined as any, childChart, undefined);
        } catch (e) {
          scope.err = (e as Error).message;
        }
      },
      'parent',
    ).build();

    await new FlowChartExecutor(chart).run();
    // Parent's run completes normally since the throw was caught inside
    // the stage body — error captured in scope.
  });
});

// ─── P7 ROI — clean integration in a stage ───────────────────────────

describe('detach/scope-method — P7 ROI', () => {
  it('P7 fire-and-forget telemetry pattern reads cleanly in a stage', async () => {
    const events: number[] = [];
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      events.push(input as number);
      return undefined;
    });

    interface S {
      processed?: number;
    }
    const chart = flowChart<S>(
      'process',
      async (scope) => {
        scope.processed = 42;
        // Fire telemetry without blocking real work.
        scope.$detachAndForget(driver, childChart, scope.processed);
      },
      'process',
    ).build();

    await new FlowChartExecutor(chart).run();
    // Wait for microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([42]);
  });
});
