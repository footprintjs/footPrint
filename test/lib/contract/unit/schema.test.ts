import { z } from 'zod';

import { isZodSchema, normalizeSchema, zodToJsonSchema } from '../../../../src/lib/contract/schema';

describe('isZodSchema', () => {
  it('detects Zod schemas', () => {
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(z.object({ name: z.string() }))).toBe(true);
  });

  it('rejects non-Zod objects', () => {
    expect(isZodSchema({ type: 'string' })).toBe(false);
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(42)).toBe(false);
    expect(isZodSchema({})).toBe(false);
  });
});

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

  it('handles default values', () => {
    const schema = z.object({
      retries: z.number().default(3),
    });
    const result = zodToJsonSchema(schema as any);
    expect((result.properties as any).retries.default).toBe(3);
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
