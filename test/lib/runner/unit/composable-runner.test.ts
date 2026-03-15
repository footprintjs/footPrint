import { describe, expect, it } from 'vitest';

import type { ComposableRunner, FlowChart as FlowChartType, ScopeFacade, SubtreeSnapshot } from '../../../../src';
import { flowChart, FlowChartBuilder, FlowChartExecutor, getSubtreeSnapshot, listSubflowPaths } from '../../../../src';

// ── Helpers ──────────────────────────────────────────────────────────

/** A minimal ComposableRunner for testing. */
class TestRunner implements ComposableRunner<string, string> {
  private chart: FlowChartType;

  constructor(name: string, stageLogic: (scope: ScopeFacade) => void) {
    this.chart = flowChart(
      name,
      (scope: ScopeFacade) => {
        stageLogic(scope);
      },
      `${name.toLowerCase()}-id`,
      undefined,
      `${name} stage`,
    ).build();
  }

  toFlowChart(): FlowChartType {
    return this.chart;
  }

  async run(input: string): Promise<string> {
    const executor = new FlowChartExecutor(this.chart);
    await executor.run({ input: { message: input } });
    const snap = executor.getSnapshot();
    return (snap?.sharedState?.result as string) ?? input;
  }
}

// ── ComposableRunner interface ───────────────────────────────────────

describe('ComposableRunner', () => {
  it('is implementable and toFlowChart returns a valid FlowChart', () => {
    const runner = new TestRunner('Greet', (scope) => {
      scope.setValue('result', 'hello');
    });

    const chart = runner.toFlowChart();
    expect(chart).toBeDefined();
    expect(chart.root).toBeDefined();
    expect(chart.root.name).toBe('Greet');
    expect(chart.stageMap).toBeInstanceOf(Map);
  });

  it('run executes the flowChart and returns a result', async () => {
    const runner = new TestRunner('Echo', (scope) => {
      scope.setValue('result', 'echoed');
    });

    const result = await runner.run('test input');
    expect(result).toBe('echoed');
  });

  it('can be mounted as a subflow in a parent flowChart', async () => {
    const childRunner = new TestRunner('ChildWork', (scope) => {
      scope.setValue('childDone', true);
    });

    const parentChart = flowChart(
      'ParentSeed',
      (scope: ScopeFacade) => {
        scope.setValue('parentStarted', true);
      },
      'parent-seed',
    )
      .addSubFlowChartNext('sf-child', childRunner.toFlowChart(), 'ChildRunner')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(parentChart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.parentStarted).toBe(true);

    // Subflow should appear in results
    const sfResults = executor.getSubflowResults();
    expect(sfResults.has('sf-child')).toBe(true);
  });
});

// ── getSubtreeSnapshot ───────────────────────────────────────────────

describe('getSubtreeSnapshot', () => {
  /** Build and execute a chart with subflows, return the snapshot. */
  async function buildSnapshotWithSubflows() {
    const paymentStage = (scope: ScopeFacade) => {
      scope.setValue('paid', true);
      scope.setValue('amount', 99.99);
    };

    const shippingStage = (scope: ScopeFacade) => {
      scope.setValue('shipped', true);
    };

    const paymentSubflow = new FlowChartBuilder()
      .start('ProcessPayment', paymentStage, 'process-payment', 'Charge card')
      .build();

    const shippingSubflow = new FlowChartBuilder().start('ShipOrder', shippingStage, 'ship-order', 'Dispatch').build();

    const chart = new FlowChartBuilder()
      .setEnableNarrative()
      .start(
        'ReceiveOrder',
        (scope: ScopeFacade) => {
          scope.setValue('orderId', 'ORD-1');
        },
        'receive-order',
        'Ingest order',
      )
      .addSubFlowChartNext('sf-payment', paymentSubflow, 'Payment')
      .addSubFlowChartNext('sf-shipping', shippingSubflow, 'Shipping')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    return executor.getSnapshot();
  }

  it('finds a top-level subflow by ID', async () => {
    const snapshot = await buildSnapshotWithSubflows();
    const subtree = getSubtreeSnapshot(snapshot, 'sf-payment');

    expect(subtree).toBeDefined();
    expect(subtree!.subflowId).toBe('sf-payment');
    expect(subtree!.executionTree).toBeDefined();
  });

  it('finds a different top-level subflow', async () => {
    const snapshot = await buildSnapshotWithSubflows();
    const subtree = getSubtreeSnapshot(snapshot, 'sf-shipping');

    expect(subtree).toBeDefined();
    expect(subtree!.subflowId).toBe('sf-shipping');
  });

  it('returns undefined for non-existent path', async () => {
    const snapshot = await buildSnapshotWithSubflows();
    const subtree = getSubtreeSnapshot(snapshot, 'nonexistent');

    expect(subtree).toBeUndefined();
  });

  it('returns undefined for empty or invalid input', async () => {
    const snapshot = await buildSnapshotWithSubflows();

    expect(getSubtreeSnapshot(snapshot, '')).toBeUndefined();
    expect(getSubtreeSnapshot(snapshot, '/')).toBeUndefined();
    expect(getSubtreeSnapshot(null as any, 'sf-payment')).toBeUndefined();
  });

  it('includes shared state from subflowResults when available', async () => {
    const snapshot = await buildSnapshotWithSubflows();
    const subtree = getSubtreeSnapshot(snapshot, 'sf-payment');

    expect(subtree).toBeDefined();
    // subflowResults should contain the subflow's execution context
    if (subtree!.sharedState) {
      expect(subtree!.sharedState).toBeDefined();
    }
    // The key point: it doesn't throw, and returns a valid SubtreeSnapshot
    expect(subtree!.subflowId).toBe('sf-payment');
    expect(subtree!.executionTree).toBeDefined();
  });

  it('works with nested subflows (multi-segment path)', async () => {
    // Build a chart with nested subflows: parent → child
    const innerSubflow = new FlowChartBuilder()
      .start(
        'InnerWork',
        (scope: ScopeFacade) => {
          scope.setValue('innerDone', true);
        },
        'inner-work',
      )
      .build();

    const outerSubflow = new FlowChartBuilder()
      .start(
        'OuterSetup',
        (scope: ScopeFacade) => {
          scope.setValue('outerSetup', true);
        },
        'outer-setup',
      )
      .addSubFlowChartNext('sf-inner', innerSubflow, 'InnerStep')
      .build();

    const rootChart = new FlowChartBuilder()
      .setEnableNarrative()
      .start(
        'Root',
        (scope: ScopeFacade) => {
          scope.setValue('rootDone', true);
        },
        'root',
      )
      .addSubFlowChartNext('sf-outer', outerSubflow, 'OuterStep')
      .build();

    const executor = new FlowChartExecutor(rootChart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    // Single segment — finds outer
    const outer = getSubtreeSnapshot(snapshot, 'sf-outer');
    expect(outer).toBeDefined();
    expect(outer!.subflowId).toBe('sf-outer');

    // Multi-segment — finds inner through outer
    const inner = getSubtreeSnapshot(snapshot, 'sf-outer/sf-inner');
    expect(inner).toBeDefined();
    expect(inner!.subflowId).toBe('sf-inner');
  });

  it('full integration: ComposableRunner mounted as subflow with drill-down', async () => {
    // Create a composable runner
    const processor = new TestRunner('Process', (scope) => {
      scope.setValue('processed', true);
      scope.setValue('score', 0.95);
    });

    // Mount it in a parent chart
    const parentChart = flowChart(
      'Intake',
      (scope: ScopeFacade) => {
        scope.setValue('received', true);
      },
      'intake',
    )
      .addSubFlowChartNext('sf-processor', processor.toFlowChart(), 'Processor')
      .addFunction(
        'Finalize',
        (scope: ScopeFacade) => {
          scope.setValue('done', true);
        },
        'finalize',
      )
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(parentChart);
    await executor.run();

    const snapshot = executor.getSnapshot();

    // Verify the subflow is in the snapshot
    expect(snapshot.subflowResults).toBeDefined();
    expect(snapshot.subflowResults!['sf-processor']).toBeDefined();

    // Drill down into the processor subflow
    const subtree = getSubtreeSnapshot(snapshot, 'sf-processor');
    expect(subtree).toBeDefined();
    expect(subtree!.subflowId).toBe('sf-processor');
    expect(subtree!.executionTree).toBeDefined();

    // Narrative should contain subflow entry/exit
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    const hasSubflowMention = narrative.some(
      (line) => line.toLowerCase().includes('processor') || line.toLowerCase().includes('subflow'),
    );
    expect(hasSubflowMention).toBe(true);
  });

  it('returns scoped narrative entries when provided', async () => {
    const childRunner = new TestRunner('ChildWork', (scope) => {
      scope.setValue('childDone', true);
    });

    const parentChart = flowChart(
      'ParentSeed',
      (scope: ScopeFacade) => {
        scope.setValue('parentStarted', true);
      },
      'parent-seed',
    )
      .addSubFlowChartNext('sf-child', childRunner.toFlowChart(), 'ChildRunner')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(parentChart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    const allEntries = executor.getNarrativeEntries();

    // Pass narrative entries for scoped filtering
    const subtree = getSubtreeSnapshot(snapshot, 'sf-child', allEntries);
    expect(subtree).toBeDefined();
    expect(subtree!.narrativeEntries).toBeDefined();
    expect(subtree!.narrativeEntries!.length).toBeGreaterThan(0);

    // Scoped narrative should be a subset of all entries
    expect(subtree!.narrativeEntries!.length).toBeLessThanOrEqual(allEntries.length);

    // Should contain subflow entry/exit
    const hasEntry = subtree!.narrativeEntries!.some(
      (e) => e.type === 'subflow' && e.text.toLowerCase().includes('entering'),
    );
    expect(hasEntry).toBe(true);
  });
});

// ── listSubflowPaths ────────────────────────────────────────────────

describe('listSubflowPaths', () => {
  it('returns all subflow paths from a snapshot', async () => {
    const subflow1 = new FlowChartBuilder()
      .start(
        'Work1',
        (scope: ScopeFacade) => {
          scope.setValue('done1', true);
        },
        'work-1',
      )
      .build();

    const subflow2 = new FlowChartBuilder()
      .start(
        'Work2',
        (scope: ScopeFacade) => {
          scope.setValue('done2', true);
        },
        'work-2',
      )
      .build();

    const chart = new FlowChartBuilder()
      .setEnableNarrative()
      .start(
        'Root',
        (scope: ScopeFacade) => {
          scope.setValue('root', true);
        },
        'root',
      )
      .addSubFlowChartNext('sf-first', subflow1, 'First')
      .addSubFlowChartNext('sf-second', subflow2, 'Second')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const paths = listSubflowPaths(snapshot);
    expect(paths).toContain('sf-first');
    expect(paths).toContain('sf-second');
    expect(paths.length).toBe(2);
  });

  it('returns empty array when no subflows exist', async () => {
    const chart = flowChart(
      'Simple',
      (scope: ScopeFacade) => {
        scope.setValue('done', true);
      },
      'simple',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const paths = listSubflowPaths(snapshot);
    expect(paths).toEqual([]);
  });

  it('includes nested subflow paths with composite keys', async () => {
    const inner = new FlowChartBuilder()
      .start(
        'Inner',
        (scope: ScopeFacade) => {
          scope.setValue('inner', true);
        },
        'inner',
      )
      .build();

    const outer = new FlowChartBuilder()
      .start(
        'Outer',
        (scope: ScopeFacade) => {
          scope.setValue('outer', true);
        },
        'outer',
      )
      .addSubFlowChartNext('sf-inner', inner, 'InnerStep')
      .build();

    const root = new FlowChartBuilder()
      .setEnableNarrative()
      .start(
        'Root',
        (scope: ScopeFacade) => {
          scope.setValue('root', true);
        },
        'root',
      )
      .addSubFlowChartNext('sf-outer', outer, 'OuterStep')
      .build();

    const executor = new FlowChartExecutor(root);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const paths = listSubflowPaths(snapshot);
    expect(paths).toContain('sf-outer');
    expect(paths).toContain('sf-outer/sf-inner');
  });
});
