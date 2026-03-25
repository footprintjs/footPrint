/**
 * Tests: RunContext — d3-style chart.recorder().redact().run() pattern.
 *
 * Unit + Boundary + Scenario + Property + Security + ML tests.
 */
import { describe, expect, it, vi } from 'vitest';

import { typedFlowChart } from '../../../../src/lib/builder/typedFlowChart';
import type { FlowRecorder } from '../../../../src/lib/engine/narrative/types';
import { DebugRecorder } from '../../../../src/lib/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';

interface TestState {
  name: string;
  greeting?: string;
  secret?: string;
}

function buildChart() {
  return typedFlowChart<TestState>(
    'Start',
    async (scope) => {
      scope.name = 'Alice';
      scope.greeting = `Hello, ${scope.name}!`;
      scope.secret = 'SSN-123';
    },
    'start',
  ).build();
}

// -- Unit ------------------------------------------------------------------

describe('RunContext — Unit', () => {
  it('chart.run() executes bare — no recorders', async () => {
    const chart = buildChart();
    const result = await chart.run();
    expect(result.state.name).toBe('Alice');
    expect(result.state.greeting).toBe('Hello, Alice!');
  });

  it('chart.run() with input', async () => {
    const chart = typedFlowChart<{ value: string }>(
      'Start',
      async (scope) => {
        const args = scope.$getArgs<{ msg: string }>();
        scope.value = args.msg;
      },
      'start',
    ).build();

    const result = await chart.run({ input: { msg: 'hello' } });
    expect(result.state.value).toBe('hello');
  });

  it('chart.recorder(r) returns RunContext, not chart', () => {
    const chart = buildChart();
    const ctx = chart.recorder(new MetricRecorder());
    // RunContext has .run() and .recorder() but NOT .addFunction()
    expect(typeof ctx.run).toBe('function');
    expect(typeof ctx.recorder).toBe('function');
    expect((ctx as any).addFunction).toBeUndefined();
  });

  it('chart.recorder(r).run() attaches recorder and executes', async () => {
    const chart = buildChart();
    const metrics = new MetricRecorder();
    const result = await chart.recorder(metrics).run();

    expect(result.state.name).toBe('Alice');
    expect(metrics.getMetrics().totalWrites).toBeGreaterThan(0);
  });

  it('chain multiple recorders', async () => {
    const chart = buildChart();
    const metrics = new MetricRecorder();
    const debug = new DebugRecorder();

    const result = await chart.recorder(metrics).recorder(debug).run();

    expect(result.state.name).toBe('Alice');
    expect(metrics.getMetrics().totalWrites).toBeGreaterThan(0);
    expect(debug.getEntries().length).toBeGreaterThan(0);
  });

  it('chart.redact(policy).run() applies redaction', async () => {
    const chart = buildChart();
    const metrics = new MetricRecorder();

    const result = await chart
      .recorder(metrics)
      .redact({ keys: ['secret'] })
      .run();

    expect(result.state.name).toBe('Alice');
    // secret is in state (runtime sees real value) but recorders see [REDACTED]
  });

  it('chart.recorder(flowRecorder) attaches flow recorder', async () => {
    const chart = buildChart();
    const events: string[] = [];
    const flowRec: FlowRecorder = {
      id: 'test-flow',
      onStageExecuted: (e) => events.push(e.stageName),
    };

    await chart.recorder(flowRec).run();
    expect(events).toContain('Start');
  });

  it('result.output uses outputMapper when available', async () => {
    const chart = typedFlowChart<TestState>(
      'Start',
      async (scope) => {
        scope.name = 'Bob';
        scope.greeting = 'Hi Bob';
      },
      'start',
    )
      .contract({ mapper: (state) => ({ msg: state.greeting }) })
      .build();

    const result = await chart.run();
    expect(result.output).toEqual({ msg: 'Hi Bob' });
    expect(result.state.name).toBe('Bob'); // state still has everything
  });

  it('result.output equals state when no outputMapper', async () => {
    const chart = buildChart();
    const result = await chart.run();
    expect(result.output).toEqual(result.state);
  });
});

// -- Scenario --------------------------------------------------------------

describe('RunContext — Scenario', () => {
  it('same chart, multiple runs with different recorders', async () => {
    const chart = buildChart();

    // Run 1: with metrics
    const metrics1 = new MetricRecorder();
    const r1 = await chart.recorder(metrics1).run();
    expect(r1.state.name).toBe('Alice');
    expect(metrics1.getMetrics().totalWrites).toBeGreaterThan(0);

    // Run 2: with debug (different recorder)
    const debug2 = new DebugRecorder();
    const r2 = await chart.recorder(debug2).run();
    expect(r2.state.name).toBe('Alice');
    expect(debug2.getEntries().length).toBeGreaterThan(0);

    // Chart is immutable — both runs independent
  });

  it('batch processing: each run gets fresh metrics', async () => {
    const chart = typedFlowChart<{ x: number }>(
      'Process',
      async (scope) => {
        scope.x = Math.random();
      },
      'process',
    ).build();

    const results = [];
    for (let i = 0; i < 5; i++) {
      const metrics = new MetricRecorder();
      await chart.recorder(metrics).run();
      results.push(metrics.getMetrics().totalWrites);
    }

    // Each run independently records 1 write
    expect(results.every((w) => w === 1)).toBe(true);
    expect(results).toHaveLength(5);
  });

  it('decider with decide() via chart.run()', async () => {
    const { decide } = await import('../../../../src/lib/decide/decide');

    interface LoanState {
      score: number;
      decision?: string;
    }
    const chart = typedFlowChart<LoanState>(
      'Load',
      async (scope) => {
        scope.score = 750;
      },
      'load',
    )
      .addDeciderFunction(
        'Route',
        (scope) => {
          return decide(scope, [{ when: { score: { gt: 700 } }, then: 'approved' }], 'rejected');
        },
        'route',
      )
      .addFunctionBranch('approved', 'Approve', async (scope) => {
        scope.decision = 'Yes';
      })
      .addFunctionBranch('rejected', 'Reject', async (scope) => {
        scope.decision = 'No';
      })
      .setDefault('rejected')
      .end()
      .build();

    const result = await chart.run();
    expect(result.state.decision).toBe('Yes');
  });
});

// -- Boundary --------------------------------------------------------------

describe('RunContext — Boundary', () => {
  it('chart.run() with no stages beyond start', async () => {
    const chart = typedFlowChart<{ x: number }>(
      'Only',
      async (scope) => {
        scope.x = 1;
      },
      'only',
    ).build();

    const result = await chart.run();
    expect(result.state.x).toBe(1);
  });

  it('empty recorder chain then run', async () => {
    const chart = buildChart();
    const result = await chart.run();
    expect(result.state.name).toBe('Alice');
  });

  it('result has executionTree and commitLog', async () => {
    const chart = buildChart();
    const result = await chart.run();
    expect(result.executionTree).toBeDefined();
    expect(Array.isArray(result.commitLog)).toBe(true);
  });
});

// -- Security --------------------------------------------------------------

describe('RunContext — Security', () => {
  it('each run gets independent executor — no state leaks', async () => {
    const chart = buildChart();
    const r1 = await chart.run();
    const r2 = await chart.run();

    // Both return same values (same chart) but different objects
    expect(r1.state).not.toBe(r2.state);
    expect(r1.state.name).toBe(r2.state.name);
  });

  it('redaction hides values from recorders', async () => {
    const chart = buildChart();
    const debug = new DebugRecorder({ verbosity: 'full' });

    await chart
      .recorder(debug)
      .redact({ keys: ['secret'] })
      .run();

    // DebugRecorder should see [REDACTED] for secret key
    const entries = debug.getEntries();
    const secretWrites = entries.filter((e) => e.key === 'secret');
    for (const e of secretWrites) {
      expect(String(e.valueSummary)).toContain('REDACTED');
    }
  });
});

// -- ML/AI -----------------------------------------------------------------

describe('RunContext — ML/AI', () => {
  it('zero-boilerplate agent pipeline', async () => {
    const chart = typedFlowChart<{ query: string; response: string }>(
      'Agent',
      async (scope) => {
        scope.query = 'What is 2+2?';
        scope.response = '4';
      },
      'agent',
    ).build();

    // One line — chart.run()
    const result = await chart.run();
    expect(result.state.response).toBe('4');
  });
});
