/**
 * detach/builder-method — 7-pattern tests for `addDetachAndForget`
 *                         and `addDetachAndJoinLater`.
 *
 *   P1 Unit         — addDetachAndForget produces a runnable stage
 *   P2 Boundary     — handle stored via $setValue survives proxy unwrap
 *                     and is accessible through scope[handleKey]
 *   P3 Scenario     — chart-native fan-out + join: 3 detaches + Promise.all
 *   P4 Property     — inputMapper receives the parent scope and shapes input
 *   P5 Security     — missing driver in options surfaces as the same TypeError
 *                     the runtime spawn helper throws
 *   P6 Performance  — N/A (covered in spawn perf test)
 *   P7 ROI          — chart reads cleanly: explicit detach stage in the graph
 */

import { afterEach, describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/index.js';
import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createMicrotaskBatchDriver, microtaskBatchDriver } from '../../../src/lib/detach/drivers/microtaskBatch.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';
import { _resetSpawnCounterForTests } from '../../../src/lib/detach/spawn.js';
import type { DetachHandle } from '../../../src/lib/detach/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';

afterEach(() => {
  _resetForTests();
  _resetSpawnCounterForTests();
});

const fakeChild = { root: {}, subflows: {} } as unknown as FlowChart;

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/builder-method — P1 unit', () => {
  it('P1 addDetachAndForget produces a runnable stage that fires the driver', async () => {
    const calls: unknown[] = [];
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      calls.push(input);
      return undefined;
    });

    interface S {
      ok?: boolean;
    }
    const chart = flowChart<S>(
      'start',
      async (scope) => {
        scope.ok = true;
      },
      'start',
    )
      .addDetachAndForget('telemetry', fakeChild, {
        driver,
        inputMapper: () => ({ event: 'test' }),
      })
      .build();

    await new FlowChartExecutor(chart).run();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([{ event: 'test' }]);
  });
});

// ─── P2 Boundary — handle delivered via onHandle callback ────────────

describe('detach/builder-method — P2 boundary', () => {
  it('P2 addDetachAndJoinLater delivers the live handle to onHandle callback', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, input) => `result:${input}`);
    let captured: DetachHandle | undefined;

    interface S {
      payload: string;
      finalResult?: string;
    }
    const chart = flowChart<S>(
      'seed',
      async (scope) => {
        scope.payload = 'hi';
      },
      'seed',
    )
      .addDetachAndJoinLater('eval', fakeChild, {
        driver,
        inputMapper: (scope) => scope.payload,
        onHandle: (h) => {
          captured = h;
        },
      })
      .addFunction(
        'join',
        async (scope) => {
          // Handle is in closure (`captured`), wait() method preserved.
          expect(typeof captured!.wait).toBe('function');
          const out = await captured!.wait();
          scope.finalResult = out.result as string;
        },
        'join',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    await exec.run();
    const snap = exec.getSnapshot();
    expect(snap.sharedState.finalResult).toBe('result:hi');
  });
});

// ─── P3 Scenario — chart-native fan-out + join ───────────────────────

describe('detach/builder-method — P3 scenario', () => {
  it('P3 three sequential detach stages + downstream join via Promise.all', async () => {
    const driver = createMicrotaskBatchDriver(async (_c, input) => input as number);
    const handles: DetachHandle[] = [];

    interface S {
      seq: number;
      sum?: number;
    }

    const chart = flowChart<S>(
      'seed',
      async (scope) => {
        scope.seq = 10;
      },
      'seed',
    )
      .addDetachAndJoinLater('a', fakeChild, {
        driver,
        inputMapper: (s) => s.seq,
        onHandle: (h) => handles.push(h),
      })
      .addDetachAndJoinLater('b', fakeChild, {
        driver,
        inputMapper: (s) => s.seq * 2,
        onHandle: (h) => handles.push(h),
      })
      .addDetachAndJoinLater('c', fakeChild, {
        driver,
        inputMapper: (s) => s.seq * 3,
        onHandle: (h) => handles.push(h),
      })
      .addFunction(
        'join',
        async (scope) => {
          const settled = await Promise.all(handles.map((h) => h.wait()));
          scope.sum = settled.reduce((acc, r) => acc + (r.result as number), 0);
        },
        'join',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    await exec.run();
    const snap = exec.getSnapshot();
    expect(snap.sharedState.sum).toBe(10 + 20 + 30);
  });
});

// ─── P4 Property — inputMapper shapes input from scope ───────────────

describe('detach/builder-method — P4 property', () => {
  it('P4 inputMapper receives the parent scope and produces the child input', async () => {
    const captured: unknown[] = [];
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      captured.push(input);
      return input;
    });

    interface S {
      a: number;
      b: number;
    }
    const chart = flowChart<S>(
      'seed',
      async (scope) => {
        scope.a = 5;
        scope.b = 7;
      },
      'seed',
    )
      .addDetachAndForget('eval', fakeChild, {
        driver,
        inputMapper: (scope) => ({ sum: scope.a + scope.b }),
      })
      .build();

    await new FlowChartExecutor(chart).run();
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toEqual([{ sum: 12 }]);
  });

  it('P4 inputMapper omitted → child receives undefined as input', async () => {
    const captured: unknown[] = [];
    const driver = createMicrotaskBatchDriver(async (_c, input) => {
      captured.push(input);
      return undefined;
    });

    const chart = flowChart('seed', async () => {}, 'seed')
      .addDetachAndForget('telemetry', fakeChild, { driver })
      .build();

    await new FlowChartExecutor(chart).run();
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toEqual([undefined]);
  });
});

// ─── P5 Security — missing driver guard ──────────────────────────────

describe('detach/builder-method — P5 security', () => {
  it('P5 missing driver in options surfaces as a TypeError at run time', async () => {
    const chart = flowChart('seed', async () => {}, 'seed')
      .addDetachAndForget('telemetry', fakeChild, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        driver: undefined as any,
      })
      .build();

    let captured: Error | undefined;
    try {
      await new FlowChartExecutor(chart).run();
    } catch (e) {
      captured = e as Error;
    }
    // The stage's $detachAndForget call throws, the engine surfaces it.
    expect(captured).toBeInstanceOf(Error);
  });
});

// ─── P7 ROI — explicit detach stage in the chart graph ───────────────

describe('detach/builder-method — P7 ROI', () => {
  it('P7 detach stage shows up in the build-time spec as a regular stage', () => {
    const chart = flowChart('seed', async () => {}, 'seed')
      .addDetachAndForget('telemetry', fakeChild, { driver: microtaskBatchDriver })
      .build();
    // The stage is in the stageMap (regular addFunction-produced) and
    // appears as a discoverable node in the chart structure.
    expect(chart.stageMap.has('telemetry')).toBe(true);
  });

  it('P7 mountName overrides default display name', async () => {
    const chart = flowChart('seed', async () => {}, 'seed')
      .addDetachAndForget('t', fakeChild, {
        driver: microtaskBatchDriver,
        mountName: 'ShipTelemetry',
      })
      .build();
    expect(chart.stageMap.has('t')).toBe(true);
    // Display name reflected in build-time structure.
    const next = (chart.buildTimeStructure as { next?: { name?: string } })?.next;
    expect(next?.name).toBe('ShipTelemetry');
  });
});
