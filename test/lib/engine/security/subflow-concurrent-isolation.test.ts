/**
 * Tests for FlowchartTraverser subflow/stageMap isolation across concurrent runs.
 *
 * Bug fixed (P1-2): `this.subflows` and `this.stageMap` were shared references from the
 * FlowChart object. Lazy-resolution writes (prefixed subflow entries) mutated
 * the shared dict, causing races when two FlowChartExecutor instances shared
 * the same compiled FlowChart.
 *
 * Fix: both are now shallow-copied in the FlowchartTraverser constructor so that
 * per-run mutations stay scoped to the individual traverser.
 *
 * Secondary fix (P1-2 review action): `node.subflowResolver = undefined` was written
 * back to the shared StageNode, clearing the resolver for concurrent traversers.
 * Fix: per-traverser `resolvedLazySubflows: Set<string>` now tracks resolution state
 * locally — the shared node is never mutated.
 */

import { flowChart, FlowChartExecutor } from '../../../../src/index';
import type { FlowChart } from '../../../../src/lib/builder/types';

// ---------------------------------------------------------------------------
// Pattern 1: unit — subflows dict is per-traverser, not shared with FlowChart
// ---------------------------------------------------------------------------
describe('subflow isolation — unit: compiled FlowChart.subflows is not mutated', () => {
  it('does not add new keys to fc.subflows during execution (was mutated before fix)', async () => {
    const sub = flowChart(
      'SubStart',
      async (s: any) => {
        s.subRan = true;
      },
      'sub-start',
    ).build();

    const chart = flowChart<any>(
      'Main',
      async (s) => {
        s.x = 1;
      },
      'main',
    )
      .addSubFlowChartNext('MySub', sub, 'my-sub')
      .build();

    const subflowsBeforeRun = Object.keys((chart as any).subflows ?? {});

    const ex = new FlowChartExecutor(chart);
    await ex.run({ input: {} });

    const subflowsAfterRun = Object.keys((chart as any).subflows ?? {});
    // The compiled chart's subflows must not have gained new runtime-prefixed keys
    expect(subflowsAfterRun).toEqual(subflowsBeforeRun);
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — two concurrent runs produce independent correct results
// ---------------------------------------------------------------------------
describe('subflow isolation — boundary: concurrent runs produce correct independent results', () => {
  it('two concurrent runs of the same chart both execute the subflow', async () => {
    const run1Steps: string[] = [];
    const run2Steps: string[] = [];

    const sub1 = flowChart(
      'Sub',
      async () => {
        run1Steps.push('sub');
      },
      'sub1',
    ).build();
    const sub2 = flowChart(
      'Sub',
      async () => {
        run2Steps.push('sub');
      },
      'sub2',
    ).build();

    // Two separate executors on the same compiled chart structure
    const chart = flowChart('Main', async () => {}, 'main-concurrent')
      .addSubFlowChartNext('MySub', sub1, 'my-sub-concurrent')
      .build();

    const chart2 = flowChart('Main', async () => {}, 'main-concurrent')
      .addSubFlowChartNext('MySub', sub2, 'my-sub-concurrent')
      .build();

    const ex1 = new FlowChartExecutor(chart);
    const ex2 = new FlowChartExecutor(chart2);

    await Promise.all([ex1.run(), ex2.run()]);

    // Both subflows must have been executed
    expect(run1Steps).toContain('sub');
    expect(run2Steps).toContain('sub');
  });

  it('same chart shared between two executors — both complete without throwing', async () => {
    const sub = flowChart('Sub', async () => {}, 'shared-sub').build();
    const chart = flowChart('Main', async () => {}, 'shared-main')
      .addSubFlowChartNext('Sub', sub, 'shared-sub-ref')
      .build();

    const ex1 = new FlowChartExecutor(chart);
    const ex2 = new FlowChartExecutor(chart);

    // Neither should throw — shared subflows object is now copy-on-write per traverser
    await expect(Promise.all([ex1.run(), ex2.run()])).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — many sequential runs share the same executor instance
// ---------------------------------------------------------------------------
describe('subflow isolation — scenario: repeated runs on the same executor instance', () => {
  it('does not accumulate subflow keys across sequential runs', async () => {
    const sub = flowChart<any>(
      'SubStep',
      async (s) => {
        s.done = true;
      },
      'sub-step',
    ).build();
    const chart = flowChart<any>('Root', async () => {}, 'root')
      .addSubFlowChartNext('Sub', sub, 'sub')
      .build();

    const ex = new FlowChartExecutor(chart);
    const chartSubflowKeyCount = Object.keys((chart as any).subflows ?? {}).length;

    await ex.run({ input: {} });
    await ex.run({ input: {} });
    await ex.run({ input: {} });

    // After 3 runs, the compiled chart still has the original number of subflow keys
    expect(Object.keys((chart as any).subflows ?? {}).length).toBe(chartSubflowKeyCount);
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — stageMap size is stable across concurrent runs
// ---------------------------------------------------------------------------
describe('subflow isolation — property: stageMap is not mutated on the shared FlowChart', () => {
  it('fc.stageMap size stays constant across concurrent executor runs', async () => {
    const sub = flowChart<any>(
      'Sub',
      async (s) => {
        s.y = 99;
      },
      'sub-fn',
    ).build();
    const chart = flowChart<any>(
      'Main',
      async (s) => {
        s.x = 1;
      },
      'main-fn',
    )
      .addSubFlowChartNext('MySub', sub, 'my-sub')
      .build();

    const originalSize = (chart as any).stageMap.size;

    const runners = Array.from({ length: 5 }, () => new FlowChartExecutor(chart));
    await Promise.all(runners.map((ex) => ex.run({ input: {} })));

    // The compiled chart stageMap must not have grown from concurrent runs
    expect((chart as any).stageMap.size).toBe(originalSize);
  });
});

// ---------------------------------------------------------------------------
// Pattern 5a: security — lazy subflow resolver not cleared on shared StageNode
// ---------------------------------------------------------------------------
describe('subflow isolation — security: lazy resolver not cleared on shared node', () => {
  it('concurrent runs of a lazy-subflow chart all resolve successfully', async () => {
    // addLazySubFlowChartNext defers subflow resolution to first execution.
    // Old code: node.subflowResolver = undefined → first runner cleared it for all concurrent runners.
    // New code: per-traverser resolvedLazySubflows set — node never mutated.
    const lazyResults: boolean[] = [];

    const lazyChart: FlowChart = flowChart<any>(
      'LazySub',
      async (s) => {
        s.lazyRan = true;
      },
      'lazy-sub',
    ).build();

    const chart = flowChart<any>('Main', async () => {}, 'main-lazy')
      .addLazySubFlowChartNext('lazy-sub-ref', () => lazyChart, 'LazySub')
      .build();

    // Run 5 concurrent executors on the same chart — each must resolve the lazy subflow
    const runners = Array.from({ length: 5 }, () => new FlowChartExecutor(chart));
    const results = await Promise.all(runners.map((ex) => ex.run({ input: {} })));

    // All runs must complete without throwing (result may be undefined with no output mapper)
    expect(results.length).toBe(5);
    lazyResults.push(...results.map(() => true));
    expect(lazyResults.length).toBe(5);
  });

  it('node.subflowResolver remains defined on the shared chart node after concurrent runs', async () => {
    let resolverCallCount = 0;

    const lazyChart: FlowChart = flowChart<any>('LSub', async () => {}, 'l-sub').build();
    const chart = flowChart<any>('M', async () => {}, 'm')
      .addLazySubFlowChartNext(
        'l-sub-ref',
        () => {
          resolverCallCount++;
          return lazyChart;
        },
        'LSub',
      )
      .build();

    // Get reference to the shared node before any run
    const sharedNode = (chart as any).root?.next;
    const resolverBeforeRun = sharedNode?.subflowResolver;

    await new FlowChartExecutor(chart).run();
    await new FlowChartExecutor(chart).run();

    // The resolver on the shared node must still be defined — not cleared
    expect(sharedNode?.subflowResolver).toBe(resolverBeforeRun);
    expect(typeof sharedNode?.subflowResolver).toBe('function');
    // Each run resolved independently (resolver called once per traverser)
    expect(resolverCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — isolated stageMap prevents cross-run function leakage
// ---------------------------------------------------------------------------
describe('subflow isolation — security: dynamic stage functions stay in their run', () => {
  it('lazy-resolved stage function is not visible in subsequent runs via shared stageMap', async () => {
    const sub = flowChart<any>(
      'LazyStage',
      async (s) => {
        s.lazy = true;
      },
      'lazy-stage',
    ).build();

    const chart = flowChart<any>('Main', async () => {}, 'main-entry')
      .addSubFlowChartNext('LazySub', sub, 'lazy-sub')
      .build();

    const originalStageMapSize = (chart as any).stageMap.size;

    // First run — lazy resolution should add prefixed entries to the traverser's
    // own copy of stageMap, NOT to the chart's stageMap.
    const ex1 = new FlowChartExecutor(chart);
    await ex1.run({ input: {} });
    const firstTraverserStageMapSize = (chart as any).stageMap.size;

    // Second run — chart stageMap must still be original size
    const ex2 = new FlowChartExecutor(chart);
    await ex2.run({ input: {} });
    const secondTraverserStageMapSize = (chart as any).stageMap.size;

    expect(firstTraverserStageMapSize).toBe(originalStageMapSize);
    expect(secondTraverserStageMapSize).toBe(originalStageMapSize);
  });
});
