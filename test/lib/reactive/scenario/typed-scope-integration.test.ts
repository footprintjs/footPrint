/**
 * Integration tests for TypedScope<T> with real FlowChartExecutor.
 *
 * Verifies full end-to-end: builder -> executor -> TypedScope -> narrative + recorders.
 */
import { describe, expect, it } from 'vitest';

import { createTypedScopeFactory, typedFlowChart } from '../../../../src/lib/builder/typedFlowChart';
import type { TypedScope } from '../../../../src/lib/reactive/types';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { MetricRecorder } from '../../../../src/lib/scope';

// -- Test state interfaces ---------------------------------------------------

interface LoanState {
  applicantName: string;
  amount: number;
  creditTier: string;
  customer: {
    name: string;
    address: { city: string; zip: string };
  };
  tags: string[];
  approved?: boolean;
}

interface SimpleState {
  x: number;
  y: number;
  result?: number;
}

// -- Scenario: basic typed read/write ----------------------------------------

describe('TypedScope integration -- basic typed access', () => {
  it('typed reads and writes work end-to-end', async () => {
    const chart = typedFlowChart<SimpleState>(
      'SetValues',
      (scope) => {
        scope.x = 10;
        scope.y = 20;
      },
      'set-values',
    )
      .addFunction(
        'Compute',
        (scope) => {
          scope.result = scope.x + scope.y;
        },
        'compute',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.x).toBe(10);
    expect(snapshot.sharedState.y).toBe(20);
    expect(snapshot.sharedState.result).toBe(30);
  });
});

// -- Scenario: narrative fires correctly -------------------------------------

describe('TypedScope integration -- narrative', () => {
  it('enableNarrative() produces narrative with typed access', async () => {
    const chart = typedFlowChart<SimpleState>(
      'Init',
      (scope) => {
        scope.x = 42;
      },
      'init',
    )
      .addFunction(
        'Double',
        (scope) => {
          scope.y = scope.x * 2;
        },
        'double',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    // Should mention the writes
    const joined = narrative.join('\n');
    // Narrative should mention the stage names and write operations
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).toContain('Init');
  });
});

// -- Scenario: MetricRecorder fires for typed access -------------------------

describe('TypedScope integration -- recorders', () => {
  it('MetricRecorder captures reads and writes from typed access', async () => {
    const chart = typedFlowChart<SimpleState>(
      'Write',
      (scope) => {
        scope.x = 1;
        scope.y = 2;
      },
      'write',
    )
      .addFunction(
        'Read',
        (scope) => {
          scope.result = scope.x + scope.y;
        },
        'read',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    const metrics = new MetricRecorder();
    executor.attachRecorder(metrics);
    await executor.run();

    const m = metrics.getMetrics();
    expect(m.totalWrites).toBeGreaterThanOrEqual(3); // x, y, result
    expect(m.totalReads).toBeGreaterThanOrEqual(2); // x, y in Read stage
  });
});

// -- Scenario: nested object write -------------------------------------------

describe('TypedScope integration -- nested writes', () => {
  it('scope.customer.address.zip = "10001" updates nested state', async () => {
    const chart = typedFlowChart<LoanState>(
      'Setup',
      (scope) => {
        scope.applicantName = 'Alice';
        scope.amount = 50000;
        scope.creditTier = 'A';
        scope.customer = {
          name: 'Alice',
          address: { city: 'LA', zip: '90210' },
        };
        scope.tags = [];
      },
      'setup',
    )
      .addFunction(
        'UpdateAddress',
        (scope) => {
          scope.customer.address.zip = '10001';
          scope.customer.address.city = 'NYC';
        },
        'update-address',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<LoanState>());
    await executor.run();

    const state = executor.getSnapshot().sharedState;
    expect((state.customer as any).address.zip).toBe('10001');
    expect((state.customer as any).address.city).toBe('NYC');
    expect((state.customer as any).name).toBe('Alice'); // preserved
  });
});

// -- Scenario: array mutations -----------------------------------------------

describe('TypedScope integration -- array mutations', () => {
  it('scope.tags.push("vip") works end-to-end', async () => {
    const chart = typedFlowChart<LoanState>(
      'Setup',
      (scope) => {
        scope.tags = ['new'];
        scope.applicantName = 'Bob';
        scope.amount = 1000;
        scope.creditTier = 'B';
        scope.customer = { name: 'Bob', address: { city: 'SF', zip: '94102' } };
      },
      'setup',
    )
      .addFunction(
        'Tag',
        (scope) => {
          scope.tags.push('vip');
          scope.tags.push('verified');
        },
        'tag',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<LoanState>());
    await executor.run();

    const state = executor.getSnapshot().sharedState;
    expect(state.tags).toEqual(['new', 'vip', 'verified']);
  });
});

// -- Scenario: $-methods work ------------------------------------------------

describe('TypedScope integration -- $-methods', () => {
  it('$getArgs returns frozen input', async () => {
    let capturedArgs: any;

    const chart = typedFlowChart<SimpleState>(
      'Check',
      (scope) => {
        capturedArgs = scope.$getArgs<{ requestId: string }>();
        scope.x = 1;
        scope.y = 2;
      },
      'check',
    ).build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    await executor.run({ input: { requestId: 'req-123' } });

    expect(capturedArgs.requestId).toBe('req-123');
  });

  it('$debug logs to diagnostics', async () => {
    const chart = typedFlowChart<SimpleState>(
      'Debug',
      (scope) => {
        scope.x = 1;
        scope.y = 2;
        scope.$debug('checkpoint', { step: 1 });
      },
      'debug',
    ).build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    await executor.run();
    // If it doesn't throw, $debug delegation works
    expect(executor.getSnapshot().sharedState.x).toBe(1);
  });

  it('$read returns precise nested value', async () => {
    let capturedZip: unknown;

    const chart = typedFlowChart<LoanState>(
      'Setup',
      (scope) => {
        scope.customer = { name: 'Alice', address: { city: 'LA', zip: '90210' } };
        scope.applicantName = 'Alice';
        scope.amount = 100;
        scope.creditTier = 'A';
        scope.tags = [];
      },
      'setup',
    )
      .addFunction(
        'ReadZip',
        (scope) => {
          capturedZip = scope.$read('customer.address.zip');
        },
        'read-zip',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<LoanState>());
    await executor.run();

    expect(capturedZip).toBe('90210');
  });
});

// -- Scenario: $break stops pipeline ----------------------------------------

describe('TypedScope integration -- $break', () => {
  it('$break() stops pipeline execution', async () => {
    const stagesRun: string[] = [];

    const chart = typedFlowChart<SimpleState>(
      'First',
      (scope) => {
        scope.x = 1;
        scope.y = 0;
        stagesRun.push('First');
        scope.$break();
      },
      'first',
    )
      .addFunction(
        'Second',
        (scope) => {
          stagesRun.push('Second');
          scope.y = 2;
        },
        'second',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    await executor.run();

    expect(stagesRun).toEqual(['First']);
    expect(executor.getSnapshot().sharedState.y).toBe(0); // Second never ran
  });
});

// -- Scenario: Object.keys and destructuring ---------------------------------

describe('TypedScope integration -- enumeration', () => {
  it('Object.keys returns state keys, no $-methods', async () => {
    let capturedKeys: string[] = [];

    const chart = typedFlowChart<SimpleState>(
      'Setup',
      (scope) => {
        scope.x = 10;
        scope.y = 20;
      },
      'setup',
    )
      .addFunction(
        'Enumerate',
        (scope) => {
          capturedKeys = Object.keys(scope);
        },
        'enumerate',
      )
      .build();

    const executor = new FlowChartExecutor(chart, createTypedScopeFactory<SimpleState>());
    await executor.run();

    expect(capturedKeys).toContain('x');
    expect(capturedKeys).toContain('y');
    expect(capturedKeys).not.toContain('$getValue');
    expect(capturedKeys).not.toContain('$break');
  });
});

// -- Scenario: existing tests still pass (non-breaking) ----------------------

describe('TypedScope integration -- non-breaking', () => {
  it('plain flowChart still works with typed property access', async () => {
    const { flowChart } = await import('../../../../src/lib/builder');

    const chart = flowChart(
      'Old',
      (scope: any) => {
        scope.legacy = true;
      },
      'old',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSnapshot().sharedState.legacy).toBe(true);
  });
});
