/**
 * Tests: chart.toOpenAPI() and chart.toMCPTool() — self-describing charts.
 */
import { describe, expect, it } from 'vitest';

import { typedFlowChart } from '../../../../src/lib/builder/typedFlowChart';

interface State {
  amount: number;
  status?: string;
}

function buildChart() {
  return typedFlowChart<State>(
    'ProcessOrder',
    async (scope) => {
      scope.amount = 99;
      scope.status = 'processed';
    },
    'process-order',
    undefined,
    'Process an incoming order',
  )
    .contract({
      input: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
      output: { type: 'object', properties: { status: { type: 'string' } } },
      mapper: (s) => ({ status: s.status }),
    })
    .build();
}

// -- Unit ------------------------------------------------------------------

describe('chart.toOpenAPI() — Unit', () => {
  it('generates OpenAPI 3.1 spec', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI({ title: 'Order API', version: '2.0.0' }) as any;

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Order API');
    expect(spec.info.version).toBe('2.0.0');
    expect(spec.paths).toBeDefined();
  });

  it('includes input schema in requestBody', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI() as any;
    const post = Object.values(spec.paths)[0] as any;

    expect(post.post.requestBody).toBeDefined();
    expect(post.post.requestBody.content['application/json'].schema.properties.amount).toBeDefined();
  });

  it('includes output schema in response', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI() as any;
    const post = Object.values(spec.paths)[0] as any;

    expect(post.post.responses['200'].content['application/json'].schema.properties.status).toBeDefined();
  });

  it('uses chart root name for path', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI() as any;
    expect(spec.paths['/processorder']).toBeDefined();
  });

  it('custom path override', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI({ path: '/api/v1/orders' }) as any;
    expect(spec.paths['/api/v1/orders']).toBeDefined();
  });

  it('cached — same object on repeated calls', () => {
    const chart = buildChart();
    const spec1 = chart.toOpenAPI();
    const spec2 = chart.toOpenAPI();
    expect(spec1).toBe(spec2); // same reference
  });

  it('works without contract (no schemas)', () => {
    const chart = typedFlowChart<State>(
      'Simple',
      async (scope) => {
        scope.amount = 1;
      },
      'simple',
    ).build();

    const spec = chart.toOpenAPI() as any;
    expect(spec.openapi).toBe('3.1.0');
    // No requestBody or response schema
    const post = Object.values(spec.paths)[0] as any;
    expect(post.post.requestBody).toBeUndefined();
  });
});

describe('chart.toMCPTool() — Unit', () => {
  it('generates MCP tool description', () => {
    const chart = buildChart();
    const tool = chart.toMCPTool();

    expect(tool.name).toBe('processorder');
    expect(tool.description).toContain('Process');
    expect(tool.inputSchema).toBeDefined();
  });

  it('includes input schema', () => {
    const chart = buildChart();
    const tool = chart.toMCPTool();
    expect((tool.inputSchema as any).properties.amount).toBeDefined();
  });

  it('cached — same object on repeated calls', () => {
    const chart = buildChart();
    const tool1 = chart.toMCPTool();
    const tool2 = chart.toMCPTool();
    expect(tool1).toBe(tool2);
  });

  it('works without contract', () => {
    const chart = typedFlowChart<State>(
      'Simple',
      async (scope) => {
        scope.amount = 1;
      },
      'simple',
    ).build();

    const tool = chart.toMCPTool();
    expect(tool.name).toBe('simple');
    expect(tool.inputSchema).toBeUndefined();
  });
});

// -- Scenario: all describe methods work together --------------------------

describe('Self-describing chart — Scenario', () => {
  it('toOpenAPI + toMCPTool + description all work on built chart', () => {
    const chart = buildChart();

    const openapi = chart.toOpenAPI() as any;
    expect(openapi.openapi).toBe('3.1.0');

    const tool = chart.toMCPTool();
    expect(tool.name).toBeDefined();

    expect(chart.description).toContain('Process');

    // toSpec and toMermaid are on the builder, not the built chart
    // They're called before .build():
    // builder.toSpec(), builder.toMermaid()

    // Built chart has buildTimeStructure (the spec):
    expect(chart.buildTimeStructure).toBeDefined();
  });
});
