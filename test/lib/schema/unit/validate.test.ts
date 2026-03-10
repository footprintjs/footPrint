import { z } from 'zod';

import { InputValidationError } from '../../../../src/lib/schema/errors';
import { validateAgainstSchema, validateOrThrow } from '../../../../src/lib/schema/validate';

describe('validateAgainstSchema', () => {
  // ── Zod schemas ────────────────────────────────────────────────────────

  it('validates valid data against Zod schema', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = validateAgainstSchema(schema, { name: 'Alice', age: 30 });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns failure with issues for invalid Zod data', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = validateAgainstSchema(schema, { name: 'Alice', age: 'not-a-number' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InputValidationError);
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0].path).toContain('age');
    }
  });

  it('returns transformed data from Zod', () => {
    const schema = z.object({ name: z.string().transform((s) => s.toUpperCase()) });
    const result = validateAgainstSchema(schema, { name: 'alice' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ name: 'ALICE' });
  });

  it('preserves original Zod error as cause', () => {
    const schema = z.object({ x: z.number() });
    const result = validateAgainstSchema(schema, { x: 'bad' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.cause).toBeDefined();
    }
  });

  // ── Parseable (duck-typed) ─────────────────────────────────────────────

  it('validates via safeParse on parseable objects', () => {
    const schema = { safeParse: (v: unknown) => ({ success: true, data: v }) };
    const result = validateAgainstSchema(schema, { key: 'value' });

    expect(result.success).toBe(true);
  });

  it('handles safeParse failure on parseable objects', () => {
    const schema = {
      safeParse: () => ({
        success: false,
        error: { issues: [{ path: ['x'], message: 'bad', code: 'custom' }] },
      }),
    };
    const result = validateAgainstSchema(schema, { x: 'bad' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('bad');
    }
  });

  it('falls back to parse when safeParse throws', () => {
    const schema = {
      safeParse: () => {
        throw new Error('binding error');
      },
      parse: (v: unknown) => v,
    };
    const result = validateAgainstSchema(schema, { key: 'value' });

    expect(result.success).toBe(true);
  });

  it('returns failure when parse throws non-Zod error', () => {
    const schema = {
      parse: () => {
        throw new Error('custom error');
      },
    };
    const result = validateAgainstSchema(schema, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('custom error');
    }
  });

  // ── JSON Schema ────────────────────────────────────────────────────────

  it('validates required fields in JSON Schema', () => {
    const schema = {
      type: 'object',
      required: ['name', 'age'],
      properties: { name: { type: 'string' }, age: { type: 'number' } },
    };
    const result = validateAgainstSchema(schema, { name: 'Alice' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('age'))).toBe(true);
      expect(result.error.issues.some((i) => i.code === 'missing_field')).toBe(true);
    }
  });

  it('validates property types in JSON Schema', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };
    const result = validateAgainstSchema(schema, { count: 'not-a-number' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].expected).toBe('number');
      expect(result.error.issues[0].received).toBe('string');
    }
  });

  it('passes valid JSON Schema data', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const result = validateAgainstSchema(schema, { name: 'Alice' });

    expect(result.success).toBe(true);
  });

  it('rejects non-object data for JSON Schema', () => {
    const schema = { type: 'object', properties: {} };
    const result = validateAgainstSchema(schema, null);

    expect(result.success).toBe(false);
  });

  // ── None (pass-through) ────────────────────────────────────────────────

  it('passes data through for null schema', () => {
    const result = validateAgainstSchema(null, { any: 'data' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ any: 'data' });
  });

  it('passes data through for undefined schema', () => {
    const result = validateAgainstSchema(undefined, { any: 'data' });
    expect(result.success).toBe(true);
  });

  it('passes data through for unrecognized schema', () => {
    const result = validateAgainstSchema({ randomProp: true }, { any: 'data' });
    expect(result.success).toBe(true);
  });
});

describe('validateOrThrow', () => {
  it('returns data on success', () => {
    const schema = z.object({ name: z.string() });
    const data = validateOrThrow(schema, { name: 'Alice' });
    expect(data).toEqual({ name: 'Alice' });
  });

  it('throws InputValidationError on failure', () => {
    const schema = z.object({ name: z.string() });
    expect(() => validateOrThrow(schema, { name: 123 })).toThrow(InputValidationError);
  });

  it('thrown error has structured issues', () => {
    const schema = z.object({ name: z.string() });
    try {
      validateOrThrow(schema, { name: 123 });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InputValidationError);
      const err = e as InputValidationError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues[0].path).toContain('name');
    }
  });

  it('returns transformed data', () => {
    const schema = z.object({ name: z.string().transform((s) => s.toUpperCase()) });
    expect(validateOrThrow(schema, { name: 'alice' })).toEqual({ name: 'ALICE' });
  });
});
