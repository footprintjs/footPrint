import { z } from 'zod';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';

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
});
