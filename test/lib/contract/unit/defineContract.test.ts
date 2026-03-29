import { z } from 'zod';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import { defineContract } from '../../../../src/lib/contract/defineContract';

describe('defineContract', () => {
  const chart = flowChart('Greet', () => {}, 'greet', undefined, 'Receive the greeting')
    .addFunction('Respond', () => {}, 'respond', 'Send a response')
    .build();

  it('creates a contract with Zod schemas', () => {
    const contract = defineContract(chart, {
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      outputMapper: (scope) => ({ greeting: scope.message as string }),
    });

    // contract.chart is a prototype-linked view of chart, NOT the same reference
    // (post-fix: defineContract does not mutate the original chart)
    expect(Object.getPrototypeOf(contract.chart)).toBe(chart);
    expect(contract.inputSchema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(contract.outputSchema).toEqual({
      type: 'object',
      properties: { greeting: { type: 'string' } },
      required: ['greeting'],
    });
    expect(contract.outputMapper).toBeDefined();
  });

  it('creates a contract with raw JSON Schema', () => {
    const inputSchema = {
      type: 'object',
      properties: { score: { type: 'number' } },
      required: ['score'],
    };

    const contract = defineContract(chart, { inputSchema });

    expect(contract.inputSchema).toBe(inputSchema);
  });

  it('creates a contract without schemas', () => {
    const contract = defineContract(chart, {});

    expect(contract.inputSchema).toBeUndefined();
    expect(contract.outputSchema).toBeUndefined();
    expect(contract.outputMapper).toBeUndefined();
  });

  it('toOpenAPI generates valid spec', () => {
    const contract = defineContract(chart, {
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
    });

    const spec = contract.toOpenAPI();

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Greet');
    expect(spec.paths['/greet']).toBeDefined();
    expect(spec.paths['/greet'].post).toBeDefined();
    expect(spec.components?.schemas?.GreetInput).toBeDefined();
    expect(spec.components?.schemas?.GreetOutput).toBeDefined();
  });

  it('toOpenAPI respects custom options', () => {
    const contract = defineContract(chart, {
      inputSchema: z.object({ x: z.number() }),
    });

    const spec = contract.toOpenAPI({
      version: '2.0.0',
      basePath: '/api/v1',
    });

    expect(spec.info.version).toBe('2.0.0');
    expect(spec.paths['/api/v1/greet']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Chart isolation tests — 5-pattern (the core fix)
// ---------------------------------------------------------------------------

describe('defineContract — chart immutability (fix: no mutation on original chart)', () => {
  // Pattern 1: unit — original chart.inputSchema is not set when not pre-defined
  it('original chart.inputSchema stays undefined after defineContract', () => {
    const freshChart = flowChart('Task', () => {}, 'task').build();
    expect((freshChart as any).inputSchema).toBeUndefined();

    defineContract(freshChart, { inputSchema: z.object({ x: z.string() }) });

    // Original chart must remain unmutated
    expect((freshChart as any).inputSchema).toBeUndefined();
  });

  // Pattern 2: boundary — two contracts on the same chart use independent schemas
  it('two contracts on the same chart each see their own schema', () => {
    const sharedChart = flowChart('Shared', () => {}, 'shared').build();

    const schema1 = z.object({ a: z.string() });
    const schema2 = z.object({ b: z.number() });

    const c1 = defineContract(sharedChart, { inputSchema: schema1 });
    const c2 = defineContract(sharedChart, { inputSchema: schema2 });

    // Each contract's chart view must have its own inputSchema
    expect((c1.chart as any).inputSchema).toBe(schema1);
    expect((c2.chart as any).inputSchema).toBe(schema2);

    // And the original is still clean
    expect((sharedChart as any).inputSchema).toBeUndefined();
  });

  // Pattern 3: scenario — contract.chart inherits all chart properties via prototype
  it('contract.chart inherits root, stageMap, and methods from original chart', () => {
    const baseChart = flowChart('Base', () => {}, 'base-id').build();
    const contract = defineContract(baseChart, { inputSchema: z.object({ y: z.boolean() }) });

    // Prototype-linked: inherits everything
    expect(contract.chart.root).toBe((baseChart as any).root);
    expect(contract.chart.stageMap).toBe((baseChart as any).stageMap);

    // Methods are inherited too
    expect(typeof (contract.chart as any).recorder).toBe('function');
  });

  // Pattern 4: property — contract without inputSchema does not create a view with schema
  it('contract without inputSchema still inherits from original chart but has no own inputSchema', () => {
    const baseChart = flowChart('NoSchema', () => {}, 'no-schema').build();
    const contract = defineContract(baseChart, {});

    // No inputSchema on view
    expect((contract.chart as any).inputSchema).toBeUndefined();
    // And original is also untouched
    expect((baseChart as any).inputSchema).toBeUndefined();
  });

  // Pattern 4b: property — outputMapper isolation (RunContext.ts reads this from chart directly)
  it('outputMapper on contract.chart is the contract mapper, not the builder mapper', () => {
    const builderMapper = (s: Record<string, unknown>) => ({ built: s.x });
    const contractMapper = (s: Record<string, unknown>) => ({ contract: s.x });

    const chartWithMapper = flowChart('WithMapper', () => {}, 'with-mapper')
      .contract({ mapper: builderMapper })
      .build();

    expect((chartWithMapper as any).outputMapper).toBe(builderMapper);

    const contract = defineContract(chartWithMapper, { outputMapper: contractMapper });

    // contract.chart view must shadow with contractMapper
    expect((contract.chart as any).outputMapper).toBe(contractMapper);
    // Original chart must be unchanged
    expect((chartWithMapper as any).outputMapper).toBe(builderMapper);
  });

  // Pattern 5: security — chart built with .contract() schema is not overwritten by defineContract
  it('chart built with builder .contract() schema is shadowed on the view, not overwritten', () => {
    const builtInSchema = z.object({ built: z.boolean() });
    const overrideSchema = z.object({ override: z.string() });

    const chartWithBuiltIn = flowChart('WithBuiltIn', () => {}, 'built-in')
      .contract({ input: builtInSchema })
      .build();

    // The builder set the schema on the chart
    expect((chartWithBuiltIn as any).inputSchema).toBe(builtInSchema);

    const contract = defineContract(chartWithBuiltIn, { inputSchema: overrideSchema });

    // Contract view shadows with overrideSchema
    expect((contract.chart as any).inputSchema).toBe(overrideSchema);

    // Original chart's schema is UNCHANGED (not overwritten)
    expect((chartWithBuiltIn as any).inputSchema).toBe(builtInSchema);
  });
});
