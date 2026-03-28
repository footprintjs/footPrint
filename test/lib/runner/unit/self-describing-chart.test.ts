/**
 * Tests: chart.toOpenAPI() and chart.toMCPTool() — self-describing charts.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/index';

interface State {
  amount: number;
  status?: string;
}

function buildChart() {
  return flowChart<State>(
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

  it('uses chart root id for path', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI() as any;
    expect(spec.paths['/process-order']).toBeDefined();
  });

  it('custom path override', () => {
    const chart = buildChart();
    const spec = chart.toOpenAPI({ path: '/api/v1/orders' }) as any;
    expect(spec.paths['/api/v1/orders']).toBeDefined();
  });

  it('cached — same object on repeated no-options calls', () => {
    const chart = buildChart();
    const spec1 = chart.toOpenAPI();
    const spec2 = chart.toOpenAPI();
    expect(spec1).toBe(spec2); // same reference
  });

  it('parameterized calls are NOT cached — different options produce different results', () => {
    const chart = buildChart();
    const spec1 = chart.toOpenAPI({ title: 'A' }) as any;
    const spec2 = chart.toOpenAPI({ title: 'B' }) as any;
    expect(spec1.info.title).toBe('A');
    expect(spec2.info.title).toBe('B');
  });

  it('works without contract (no schemas)', () => {
    const chart = flowChart<State>(
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

  it('slugifies root.id with special characters for safe path', () => {
    // IDs with spaces or unusual chars are slugified
    const chart = flowChart<State>(
      'My Stage',
      async (scope) => {
        scope.amount = 1;
      },
      'my stage', // id with space
    ).build();
    const spec = chart.toOpenAPI() as any;
    // space should become hyphen
    expect(spec.paths['/my-stage']).toBeDefined();
  });
});

describe('chart.toMCPTool() — Unit', () => {
  it('generates MCP tool description', () => {
    const chart = buildChart();
    const tool = chart.toMCPTool();

    expect(tool.name).toBe('process-order');
    expect(tool.description).toContain('Process');
    expect(tool.inputSchema).toBeDefined();
  });

  it('name uses root.id (explicit machine-readable id, not display name)', () => {
    // flowChart('ProcessOrder', fn, 'process-order') → name must be 'process-order', not 'processorder'
    const chart = buildChart();
    const tool = chart.toMCPTool();
    expect(tool.name).toBe('process-order');
    expect(tool.name).not.toBe('processorder');
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

  it('always emits inputSchema (MCP spec requires it)', () => {
    const chart = flowChart<State>(
      'Simple',
      async (scope) => {
        scope.amount = 1;
      },
      'simple',
    ).build();

    const tool = chart.toMCPTool();
    expect(tool.name).toBe('simple');
    // MCP spec: inputSchema must be present even without a contract
    expect(tool.inputSchema).toBeDefined();
    expect((tool.inputSchema as any).type).toBe('object');
  });

  it('default inputSchema has additionalProperties: false (MCP RECOMMENDED)', () => {
    const chart = flowChart<State>(
      'Simple',
      async (scope) => {
        scope.amount = 1;
      },
      'simple',
    ).build();

    const tool = chart.toMCPTool();
    expect((tool.inputSchema as any).additionalProperties).toBe(false);
  });

  it('sanitizes MCP-invalid characters in root.id', () => {
    // Spaces and slashes are not in MCP name allowlist [A-Za-z0-9_\-.]
    const chart = flowChart<State>(
      'My Stage',
      async (scope) => {
        scope.amount = 1;
      },
      'my stage', // id with space — not valid MCP name char
    ).build();

    const tool = chart.toMCPTool();
    // Space replaced with underscore; leading/trailing underscores trimmed
    expect(tool.name).toBe('my_stage');
    expect(tool.name).not.toContain(' ');
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
