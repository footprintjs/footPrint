import { z } from 'zod';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import { defineContract } from '../../../../src/lib/contract/defineContract';

describe('defineContract', () => {
  const chart = flowChart('Greet', () => {}, undefined, 'Receive the greeting')
    .addFunction('Respond', () => {}, undefined, 'Send a response')
    .build();

  it('creates a contract with Zod schemas', () => {
    const contract = defineContract(chart, {
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      outputMapper: (scope) => ({ greeting: scope.message as string }),
    });

    expect(contract.chart).toBe(chart);
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
