import { z } from 'zod';

import { normalizeSchema, zodToJsonSchema } from '../../../../src/lib/contract/schema';

describe('zodToJsonSchema', () => {
  it('converts string', () => {
    expect(zodToJsonSchema(z.string() as any)).toEqual({ type: 'string' });
  });

  it('converts number', () => {
    expect(zodToJsonSchema(z.number() as any)).toEqual({ type: 'number' });
  });

  it('converts boolean', () => {
    expect(zodToJsonSchema(z.boolean() as any)).toEqual({ type: 'boolean' });
  });

  it('converts enum', () => {
    const result = zodToJsonSchema(z.enum(['a', 'b', 'c']) as any);
    expect(result).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
  });

  it('converts literal (single value)', () => {
    const result = zodToJsonSchema(z.literal('foo') as any);
    expect(result).toEqual({ type: 'string', enum: ['foo'] });
  });

  it('converts object with required and optional fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      email: z.string().optional(),
    });
    const result = zodToJsonSchema(schema as any);
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        email: { type: 'string' },
      },
      required: ['name', 'age'],
    });
  });

  it('converts object with all optional fields (no required array)', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().optional(),
    });
    const result = zodToJsonSchema(schema as any);
    expect(result).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
    });
  });

  it('converts array', () => {
    const result = zodToJsonSchema(z.array(z.string()) as any);
    expect(result).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('converts nested objects', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
      }),
    });
    const result = zodToJsonSchema(schema as any);
    expect(result.properties).toEqual({
      user: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
  });

  it('preserves descriptions', () => {
    const schema = z.object({
      name: z.string().describe('The user name'),
    });
    const result = zodToJsonSchema(schema as any);
    expect((result.properties as any).name.description).toBe('The user name');
  });

  it('handles default values in object fields', () => {
    const schema = z.object({
      retries: z.number().default(3),
    });
    const result = zodToJsonSchema(schema as any);
    expect((result.properties as any).retries.default).toBe(3);
  });

  it('converts top-level default', () => {
    const result = zodToJsonSchema(z.string().default('hello') as any);
    expect(result).toEqual({ type: 'string', default: 'hello' });
  });

  it('converts nullable', () => {
    const result = zodToJsonSchema(z.string().nullable() as any);
    expect(result).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('converts top-level optional', () => {
    const result = zodToJsonSchema(z.string().optional() as any);
    expect(result).toEqual({ type: 'string' });
  });

  it('converts union', () => {
    const result = zodToJsonSchema(z.union([z.string(), z.number()]) as any);
    expect(result).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('converts record', () => {
    const result = zodToJsonSchema(z.record(z.string(), z.number()) as any);
    expect(result).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('converts any', () => {
    const result = zodToJsonSchema(z.any() as any);
    expect(result).toEqual({});
  });

  it('converts transform (unwraps to input schema)', () => {
    const result = zodToJsonSchema(z.string().transform((s) => s.length) as any);
    expect(result).toEqual({ type: 'string' });
  });

  it('returns empty for schema without def', () => {
    const result = zodToJsonSchema({} as any);
    expect(result).toEqual({});
  });

  it('converts described top-level schema', () => {
    const result = zodToJsonSchema(z.string().describe('A name') as any);
    expect(result).toEqual({ description: 'A name', type: 'string' });
  });
});

describe('normalizeSchema', () => {
  it('passes through JSON Schema as-is', () => {
    const jsonSchema = { type: 'object', properties: { x: { type: 'number' } } };
    expect(normalizeSchema(jsonSchema)).toBe(jsonSchema);
  });

  it('converts Zod schema to JSON Schema', () => {
    const zodSchema = z.object({ name: z.string() });
    const result = normalizeSchema(zodSchema as any);
    expect(result).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });
});
