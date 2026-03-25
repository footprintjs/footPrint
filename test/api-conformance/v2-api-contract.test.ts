/**
 * API Conformance Tests — v2.0 Design Contract
 *
 * This file is the SINGLE SOURCE OF TRUTH for the v2 public API.
 * Every test here maps to a design decision from the v2 API design doc.
 * If any test fails, the release is blocked.
 *
 * Run before every release: npx vitest run test/api-conformance/
 *
 * Categories:
 *   1. Public exports — what's available from 'footprintjs'
 *   2. Removed exports — what must NOT be in 'footprintjs'
 *   3. Build phase — flowChart<T>() + .contract() + .build()
 *   4. Describe phase — chart.toOpenAPI() + chart.toMCPTool()
 *   5. Run phase — chart.recorder().redact().run()
 *   6. Recorder factories — footprintjs/recorders
 *   7. Result shape — result.state + result.output
 *   8. Naming conventions — no get* prefixes on recorder methods
 */
import { describe, expect, it } from 'vitest';

// ============================================================================
// 1. PUBLIC EXPORTS — what MUST be available from 'footprintjs'
// ============================================================================

describe('API Contract: Public Exports', () => {
  it('flowChart() is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.flowChart).toBe('function');
  });

  it('FlowChartBuilder is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.FlowChartBuilder).toBe('function');
  });

  it('FlowChartExecutor is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.FlowChartExecutor).toBe('function');
  });

  it('decide() is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.decide).toBe('function');
  });

  it('select() is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.select).toBe('function');
  });

  it('RunContext is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.RunContext).toBe('function');
  });

  it('MetricRecorder is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.MetricRecorder).toBe('function');
  });

  it('DebugRecorder is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.DebugRecorder).toBe('function');
  });

  it('ScopeFacade is exported', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.ScopeFacade).toBe('function');
  });
});

// ============================================================================
// 2. REMOVED EXPORTS — what must NOT be in 'footprintjs' main export
// ============================================================================

describe('API Contract: Removed from Main Export', () => {
  it('typedFlowChart should NOT be exported (use flowChart<T> instead)', async () => {
    const mod = await import('../../src/index');
    expect((mod as any).typedFlowChart).toBeUndefined();
  });

  it('createTypedScopeFactory IS exported (needed for custom builders)', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.createTypedScopeFactory).toBe('function');
  });

  it('setEnableNarrative should NOT exist on builder', async () => {
    const { FlowChartBuilder } = await import('../../src/index');
    const builder = new FlowChartBuilder();
    expect((builder as any).setEnableNarrative).toBeUndefined();
  });

  it('setInputSchema should NOT exist on builder (use .contract())', async () => {
    const { FlowChartBuilder } = await import('../../src/index');
    const builder = new FlowChartBuilder();
    expect((builder as any).setInputSchema).toBeUndefined();
  });

  it('setOutputSchema should NOT exist on builder (use .contract())', async () => {
    const { FlowChartBuilder } = await import('../../src/index');
    const builder = new FlowChartBuilder();
    expect((builder as any).setOutputSchema).toBeUndefined();
  });

  it('setOutputMapper should NOT exist on builder (use .contract())', async () => {
    const { FlowChartBuilder } = await import('../../src/index');
    const builder = new FlowChartBuilder();
    expect((builder as any).setOutputMapper).toBeUndefined();
  });

  it('generateOpenAPI should NOT be exported (use chart.toOpenAPI())', async () => {
    const mod = await import('../../src/index');
    expect((mod as any).generateOpenAPI).toBeUndefined();
  });

  it('defineContract should NOT be exported (use .contract())', async () => {
    const mod = await import('../../src/index');
    expect((mod as any).defineContract).toBeUndefined();
  });
});

// ============================================================================
// 3. BUILD PHASE — flowChart<T>() auto-embeds scopeFactory
// ============================================================================

describe('API Contract: Build Phase', () => {
  it('flowChart<T>() auto-embeds scopeFactory', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Test', async () => {}, 'test').build();
    expect(chart.scopeFactory).toBeDefined();
  });

  it('.contract() sets inputSchema, outputSchema, outputMapper', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Test', async () => {}, 'test')
      .contract({
        input: { type: 'object' },
        output: { type: 'object' },
        mapper: (s: any) => s,
      })
      .build();
    expect(chart.inputSchema).toBeDefined();
    expect(chart.outputSchema).toBeDefined();
    expect(chart.outputMapper).toBeDefined();
  });

  it('.build() returns RunnableFlowChart with .run(), .recorder(), .redact()', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Test', async () => {}, 'test').build();
    expect(typeof chart.run).toBe('function');
    expect(typeof chart.recorder).toBe('function');
    expect(typeof chart.redact).toBe('function');
  });

  it('.build() returns chart with .toOpenAPI() and .toMCPTool()', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Test', async () => {}, 'test').build();
    expect(typeof chart.toOpenAPI).toBe('function');
    expect(typeof chart.toMCPTool).toBe('function');
  });
});

// ============================================================================
// 4. DESCRIBE PHASE — self-describing chart
// ============================================================================

describe('API Contract: Describe Phase', () => {
  it('chart.toOpenAPI() returns OpenAPI 3.1 spec', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Process', async () => {}, 'process').build();
    const spec = chart.toOpenAPI() as any;
    expect(spec.openapi).toBe('3.1.0');
  });

  it('chart.toOpenAPI() is cached', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Process', async () => {}, 'process').build();
    expect(chart.toOpenAPI()).toBe(chart.toOpenAPI());
  });

  it('chart.toMCPTool() returns tool description', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Process', async () => {}, 'process').build();
    const tool = chart.toMCPTool();
    expect(tool.name).toBeDefined();
    expect(tool.description).toBeDefined();
  });

  it('chart.toMCPTool() is cached', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Process', async () => {}, 'process').build();
    expect(chart.toMCPTool()).toBe(chart.toMCPTool());
  });

  it('chart.description is available', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart('Process', async () => {}, 'process', undefined, 'Test desc').build();
    expect(typeof chart.description).toBe('string');
  });
});

// ============================================================================
// 5. RUN PHASE — chart.recorder().redact().run()
// ============================================================================

describe('API Contract: Run Phase', () => {
  it('chart.run() executes and returns RunResult', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart(
      'Test',
      async (scope: any) => {
        scope.x = 1;
      },
      'test',
    ).build();
    const result = await chart.run();
    expect(result.state).toBeDefined();
    expect(result.output).toBeDefined();
    expect(result.narrative).toBeDefined();
  });

  it('chart.recorder(r) returns RunContext (not FlowChart)', async () => {
    const { flowChart, MetricRecorder, RunContext } = await import('../../src/index');
    const chart = flowChart('Test', async () => {}, 'test').build();
    const ctx = chart.recorder(new MetricRecorder());
    expect(ctx).toBeInstanceOf(RunContext);
    // Must NOT have builder methods
    expect((ctx as any).addFunction).toBeUndefined();
    expect((ctx as any).toOpenAPI).toBeUndefined();
  });

  it('chart.recorder(r).recorder(r2).run() chains multiple recorders', async () => {
    const { flowChart, MetricRecorder, DebugRecorder } = await import('../../src/index');
    const chart = flowChart(
      'Test',
      async (scope: any) => {
        scope.x = 1;
      },
      'test',
    ).build();
    const m = new MetricRecorder();
    const d = new DebugRecorder();
    const result = await chart.recorder(m).recorder(d).run();
    expect(result.state).toBeDefined();
  });

  it('chart.redact(policy).run() applies redaction', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart(
      'Test',
      async (scope: any) => {
        scope.secret = 'hunter2';
      },
      'test',
    ).build();
    const result = await chart.redact({ keys: ['secret'] }).run();
    expect(result.state).toBeDefined();
  });

  it('result.state contains raw scope state', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart(
      'Test',
      async (scope: any) => {
        scope.name = 'Alice';
      },
      'test',
    ).build();
    const result = await chart.run();
    expect(result.state.name).toBe('Alice');
  });

  it('result.output uses contract mapper when available', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart(
      'Test',
      async (scope: any) => {
        scope.name = 'Bob';
        scope.age = 30;
      },
      'test',
    )
      .contract({ mapper: (s: any) => ({ greeting: 'Hi ' + s.name }) })
      .build();
    const result = await chart.run();
    expect(result.output).toEqual({ greeting: 'Hi Bob' });
  });

  it('result.narrative contains narrative lines', async () => {
    const { flowChart } = await import('../../src/index');
    const chart = flowChart(
      'Test',
      async (scope: any) => {
        scope.x = 1;
      },
      'test',
    ).build();
    const result = await chart.run();
    expect(Array.isArray(result.narrative)).toBe(true);
  });
});

// ============================================================================
// 6. RECORDER FACTORIES — footprintjs/recorders
// ============================================================================

describe('API Contract: Recorder Factories', () => {
  it('narrative() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.narrative).toBe('function');
  });

  it('metrics() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.metrics).toBe('function');
  });

  it('debug() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.debug).toBe('function');
  });

  it('manifest() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.manifest).toBe('function');
  });

  it('adaptive() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.adaptive).toBe('function');
  });

  it('milestone() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.milestone).toBe('function');
  });

  it('windowed() is exported from recorders', async () => {
    const mod = await import('../../src/recorders');
    expect(typeof mod.windowed).toBe('function');
  });

  it('narrative().lines() returns string[]', async () => {
    const { narrative } = await import('../../src/recorders');
    const trace = narrative();
    expect(typeof trace.lines).toBe('function');
    expect(Array.isArray(trace.lines())).toBe(true);
  });

  it('narrative().structured() returns entries', async () => {
    const { narrative } = await import('../../src/recorders');
    const trace = narrative();
    expect(typeof trace.structured).toBe('function');
  });

  it('metrics().reads() returns number', async () => {
    const { metrics } = await import('../../src/recorders');
    const perf = metrics();
    expect(typeof perf.reads).toBe('function');
    expect(typeof perf.reads()).toBe('number');
  });

  it('metrics().writes() returns number', async () => {
    const { metrics } = await import('../../src/recorders');
    const perf = metrics();
    expect(typeof perf.writes()).toBe('number');
  });

  it('metrics().all() returns aggregated metrics', async () => {
    const { metrics } = await import('../../src/recorders');
    const perf = metrics();
    const all = perf.all();
    expect(all).toHaveProperty('totalReads');
    expect(all).toHaveProperty('totalWrites');
  });

  it('debug().logs() returns entries', async () => {
    const { debug } = await import('../../src/recorders');
    const dbg = debug();
    expect(typeof dbg.logs).toBe('function');
    expect(Array.isArray(dbg.logs())).toBe(true);
  });
});

// ============================================================================
// 7. END-TO-END — full v2 workflow
// ============================================================================

describe('API Contract: End-to-End v2 Workflow', () => {
  it('Build -> Describe -> Run -> Read (the complete v2 story)', async () => {
    const { flowChart, decide } = await import('../../src/index');
    const { narrative, metrics } = await import('../../src/recorders');

    // BUILD
    const chart = flowChart(
      'Intake',
      async (scope: any) => {
        scope.score = 750;
      },
      'intake',
    )
      .addDeciderFunction(
        'Route',
        (scope: any) => {
          return decide(scope, [{ when: { score: { gt: 700 } }, then: 'approved' }], 'rejected');
        },
        'route',
      )
      .addFunctionBranch('approved', 'Approve', async (scope: any) => {
        scope.decision = 'Yes';
      })
      .addFunctionBranch('rejected', 'Reject', async (scope: any) => {
        scope.decision = 'No';
      })
      .setDefault('rejected')
      .end()
      .contract({
        mapper: (s: any) => ({ decision: s.decision }),
      })
      .build();

    // DESCRIBE
    const openapi = chart.toOpenAPI({ title: 'Loan API' }) as any;
    expect(openapi.openapi).toBe('3.1.0');
    const tool = chart.toMCPTool();
    expect(tool.name).toBeDefined();

    // RUN
    const trace = narrative();
    const perf = metrics();
    const result = await chart.recorder(trace).recorder(perf).run();

    // READ
    expect(result.state.decision).toBe('Yes');
    expect(result.output).toEqual({ decision: 'Yes' });
    expect(trace.lines().length).toBeGreaterThan(0);
    expect(perf.writes()).toBeGreaterThan(0);
  });
});
