import { z } from 'zod';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';

describe('Builder schema integration', () => {
  it('stores inputSchema and outputSchema on FlowChart', () => {
    const inputSchema = z.object({ name: z.string() });
    const outputSchema = z.object({ greeting: z.string() });

    const chart = flowChart('Greet', () => {})
      .setInputSchema(inputSchema)
      .setOutputSchema(outputSchema)
      .build();

    expect(chart.inputSchema).toBe(inputSchema);
    expect(chart.outputSchema).toBe(outputSchema);
  });

  it('stores outputMapper on FlowChart', () => {
    const mapper = (scope: Record<string, unknown>) => ({ result: scope.x });

    const chart = flowChart('Compute', () => {})
      .setOutputMapper(mapper)
      .build();

    expect(chart.outputMapper).toBe(mapper);
  });

  it('FlowChart without schemas has undefined fields', () => {
    const chart = flowChart('Plain', () => {}).build();

    expect(chart.inputSchema).toBeUndefined();
    expect(chart.outputSchema).toBeUndefined();
    expect(chart.outputMapper).toBeUndefined();
  });

  it('works with defineContract using chart schemas', () => {
    const { defineContract } = require('../../../../src/lib/contract');

    const chart = flowChart('Process', () => {})
      .setInputSchema(z.object({ x: z.number() }))
      .setOutputSchema(z.object({ y: z.number() }))
      .setOutputMapper((scope) => ({ y: scope.x }))
      .build();

    // Can create contract using the schemas stored on the chart
    const contract = defineContract(chart, {
      inputSchema: chart.inputSchema,
      outputSchema: chart.outputSchema,
      outputMapper: chart.outputMapper,
    });

    expect(contract.inputSchema).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
    });
  });
});
