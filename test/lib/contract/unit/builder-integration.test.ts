import { z } from 'zod';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import { defineContract } from '../../../../src/lib/contract';

describe('Builder schema integration', () => {
  it('stores inputSchema and outputSchema on FlowChart', () => {
    const inputSchema = z.object({ name: z.string() });
    const outputSchema = z.object({ greeting: z.string() });

    const chart = flowChart('Greet', () => {}, 'greet')
      .contract({ input: inputSchema, output: outputSchema })
      .build();

    expect(chart.inputSchema).toBe(inputSchema);
    expect(chart.outputSchema).toBe(outputSchema);
  });

  it('stores outputMapper on FlowChart', () => {
    const mapper = (scope: Record<string, unknown>) => ({ result: scope.x });

    const chart = flowChart('Compute', () => {}, 'compute')
      .contract({ mapper })
      .build();

    expect(chart.outputMapper).toBe(mapper);
  });

  it('FlowChart without schemas has undefined fields', () => {
    const chart = flowChart('Plain', () => {}, 'plain').build();

    expect(chart.inputSchema).toBeUndefined();
    expect(chart.outputSchema).toBeUndefined();
    expect(chart.outputMapper).toBeUndefined();
  });

  it('works with defineContract using chart schemas', () => {
    // defineContract imported at top level

    const chart = flowChart('Process', () => {}, 'process')
      .contract({
        input: z.object({ x: z.number() }),
        output: z.object({ y: z.number() }),
        mapper: (scope) => ({ y: scope.x }),
      })
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
