import { z } from 'zod';

import { detectSchema } from '../../../../src/lib/schema/detect';
import { InputValidationError } from '../../../../src/lib/schema/errors';
import { validateAgainstSchema } from '../../../../src/lib/schema/validate';

describe('Boundary: schema detection edge cases', () => {
  it('function values are not schemas', () => {
    expect(detectSchema(() => {})).toBe('none');
  });

  it('Date objects are not schemas', () => {
    expect(detectSchema(new Date())).toBe('none');
  });

  it('RegExp objects are not schemas', () => {
    expect(detectSchema(/test/)).toBe('none');
  });

  it('object with type: number (not string) is not json-schema', () => {
    expect(detectSchema({ type: 42 })).toBe('none');
  });

  it('object with properties: null is not json-schema', () => {
    expect(detectSchema({ properties: null })).toBe('none');
  });

  it('Zod transform schemas are detected as zod', () => {
    const schema = z.string().transform((s) => s.toUpperCase());
    expect(detectSchema(schema)).toBe('zod');
  });

  it('Zod refine schemas are detected as zod', () => {
    const schema = z.string().refine((s) => s.length > 0);
    expect(detectSchema(schema)).toBe('zod');
  });

  it('deeply nested Zod schemas are detected', () => {
    const schema = z.object({
      data: z.array(z.object({ nested: z.string().optional() })),
    });
    expect(detectSchema(schema)).toBe('zod');
  });
});

describe('Boundary: validation edge cases', () => {
  it('Zod strict mode rejects extra fields', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = validateAgainstSchema(schema, { name: 'Alice', extra: 'field' });

    expect(result.success).toBe(false);
  });

  it('Zod with defaults fills in missing values', () => {
    const schema = z.object({ name: z.string(), role: z.string().default('user') });
    const result = validateAgainstSchema(schema, { name: 'Alice' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).role).toBe('user');
    }
  });

  it('JSON Schema with empty required array passes', () => {
    const schema = { type: 'object', required: [], properties: {} };
    const result = validateAgainstSchema(schema, {});
    expect(result.success).toBe(true);
  });

  it('JSON Schema type check handles arrays correctly', () => {
    const schema = { type: 'object', properties: { items: { type: 'array' } } };
    const result = validateAgainstSchema(schema, { items: [1, 2, 3] });
    expect(result.success).toBe(true);
  });

  it('JSON Schema type check rejects array when object expected', () => {
    const schema = { type: 'object', properties: { data: { type: 'object' } } };
    const result = validateAgainstSchema(schema, { data: [1, 2, 3] });
    expect(result.success).toBe(false);
  });

  it('multiple validation issues are all captured', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      email: z.string().email(),
    });
    const result = validateAgainstSchema(schema, { name: 123, age: 'bad', email: 'not-email' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('InputValidationError can be caught with instanceof', () => {
    const schema = z.object({ x: z.number() });
    const result = validateAgainstSchema(schema, { x: 'bad' });

    if (!result.success) {
      try {
        throw result.error;
      } catch (e) {
        expect(e).toBeInstanceOf(InputValidationError);
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});
