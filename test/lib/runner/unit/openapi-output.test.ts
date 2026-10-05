import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';

import { flowChart } from '../../../../src/index';

const input = {
  type: 'object',
  properties: { amount: { type: 'number' } },
  required: ['amount'],
};
const output = {
  type: 'object',
  properties: { status: { type: 'string' } },
};

function builder() {
  return flowChart('Order', () => {}, 'Order V2!', { description: 'Receive an order' }).addFunction(
    'Assess',
    () => {},
    'assess',
    'Assess the order',
  );
}

// Exact serialized public output is the compatibility boundary. These snapshots
// were captured before removing the unused contract-local generator.
describe('chart.toOpenAPI() — serialized public output', () => {
  it.each([
    { name: 'no schemas', contract: {} },
    { name: 'raw input only', contract: { input } },
    { name: 'raw output only', contract: { output } },
    { name: 'raw input and output', contract: { input, output } },
  ])('$name', ({ contract }) => {
    const chart = builder().contract(contract).build();
    expect(JSON.stringify(chart.toOpenAPI())).toMatchSnapshot();
  });

  it.each([
    {
      name: 'Zod 3',
      input: z3.object({ amount: z3.number(), note: z3.string().optional() }),
      output: z3.object({ accepted: z3.boolean() }),
    },
    {
      name: 'Zod 4',
      input: z.object({ amount: z.number(), note: z.string().optional() }),
      output: z.object({ accepted: z.boolean() }),
    },
  ])('normalizes $name schemas', ({ input, output }) => {
    const chart = builder().contract({ input, output }).build();

    expect(JSON.stringify(chart.toOpenAPI())).toMatchSnapshot();
  });

  it('overrides info metadata and path while retaining the chart operation description', () => {
    const chart = builder().contract({ input, output }).build();
    expect(
      JSON.stringify(
        chart.toOpenAPI({
          title: 'Order API',
          version: '2.3.0',
          description: 'External API documentation',
          path: '/api/orders',
        }),
      ),
    ).toMatchSnapshot();
  });

  it('falls back to /execute when a stage id contains no path characters', () => {
    const chart = flowChart('Symbols', () => {}, '!!!').build();
    expect(JSON.stringify(chart.toOpenAPI())).toMatchSnapshot();
  });

  it('preserves explicit empty metadata and path options', () => {
    const chart = builder().build();
    expect(JSON.stringify(chart.toOpenAPI({ title: '', version: '', description: '', path: '' }))).toMatchSnapshot();
  });

  it('caches only calls without options and isolates parameterized results', () => {
    const chart = builder().contract({ input, output }).build();
    const cached = chart.toOpenAPI();
    const originalBytes = JSON.stringify(cached);
    const options = { title: 'Separate API', path: '/separate' };

    const first = chart.toOpenAPI(options);
    const second = chart.toOpenAPI(options);
    const emptyOptions = chart.toOpenAPI({});

    expect(first).not.toBe(second);
    expect(first).not.toBe(cached);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).toMatchSnapshot();
    expect(emptyOptions).not.toBe(cached);
    expect(JSON.stringify(emptyOptions)).toBe(originalBytes);
    expect(chart.toOpenAPI()).toBe(cached);
    expect(chart.toOpenAPI(undefined)).toBe(cached);
    expect(JSON.stringify(chart.toOpenAPI())).toBe(originalBytes);

    const anotherChart = builder().contract({ input, output }).build();
    expect(anotherChart.toOpenAPI()).not.toBe(cached);
    expect(JSON.stringify(anotherChart.toOpenAPI())).toBe(originalBytes);
  });
});
