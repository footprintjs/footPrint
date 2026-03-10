import { z } from 'zod';

import { validateInput } from '../../../../src/lib/runner/validateInput';

describe('validateInput', () => {
  // ── Zod schema validation ──────────────────────────────────────────────

  it('passes valid input through a Zod schema', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const input = { name: 'Alice', age: 30 };

    const result = validateInput(schema, input);
    expect(result).toEqual(input);
  });

  it('throws on invalid input with Zod schema', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const input = { name: 'Alice', age: 'not-a-number' } as any;

    expect(() => validateInput(schema, input)).toThrow('Input validation failed');
  });

  it('returns transformed data from Zod schema', () => {
    const schema = z.object({
      name: z.string().transform((s) => s.toUpperCase()),
    });
    const input = { name: 'alice' };

    const result = validateInput(schema, input);
    expect(result).toEqual({ name: 'ALICE' });
  });

  it('includes Zod error details in thrown message', () => {
    const schema = z.object({ email: z.string().email() });
    const input = { email: 'not-an-email' };

    expect(() => validateInput(schema, input)).toThrow('Input validation failed');
  });

  // ── Duck-typed schema with parse() ─────────────────────────────────────

  it('falls back to parse() when safeParse is not available', () => {
    const schema = {
      parse: (v: unknown) => v,
    };

    const result = validateInput(schema, { key: 'value' });
    expect(result).toEqual({ key: 'value' });
  });

  it('throws wrapped error when parse() throws', () => {
    const schema = {
      parse: () => {
        throw new Error('bad input');
      },
    };

    expect(() => validateInput(schema, { key: 'value' })).toThrow('Input validation failed: bad input');
  });

  // ── No schema / non-schema values ──────────────────────────────────────

  it('passes input through when schema is null', () => {
    const input = { key: 'value' };
    expect(validateInput(null, input)).toBe(input);
  });

  it('passes input through when schema is undefined', () => {
    const input = { key: 'value' };
    expect(validateInput(undefined, input)).toBe(input);
  });

  it('passes input through when schema is not recognizable', () => {
    const input = { key: 'value' };
    expect(validateInput({ someProperty: true }, input)).toBe(input);
  });

  it('passes input through when schema is a string', () => {
    const input = { key: 'value' };
    expect(validateInput('not-a-schema', input)).toBe(input);
  });
});
