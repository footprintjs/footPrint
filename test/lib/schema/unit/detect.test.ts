import { z } from 'zod';

import { detectSchema, isValidatable, isZod } from '../../../../src/lib/schema/detect';

describe('detectSchema', () => {
  // ── Zod v3/v4 detection ────────────────────────────────────────────────

  it('detects Zod v3 schema (has ._def.typeName)', () => {
    const schema = z.string();
    expect(detectSchema(schema)).toBe('zod');
  });

  it('detects Zod v4 object schema', () => {
    const schema = z.object({ name: z.string() });
    expect(detectSchema(schema)).toBe('zod');
  });

  it('detects Zod number schema', () => {
    expect(detectSchema(z.number())).toBe('zod');
  });

  it('detects Zod boolean schema', () => {
    expect(detectSchema(z.boolean())).toBe('zod');
  });

  it('detects Zod array schema', () => {
    expect(detectSchema(z.array(z.string()))).toBe('zod');
  });

  it('detects Zod enum schema', () => {
    expect(detectSchema(z.enum(['a', 'b']))).toBe('zod');
  });

  it('detects Zod optional schema', () => {
    expect(detectSchema(z.string().optional())).toBe('zod');
  });

  // ── Parseable (duck-typed) ─────────────────────────────────────────────

  it('detects parseable with safeParse', () => {
    const fake = { safeParse: () => ({ success: true, data: null }) };
    expect(detectSchema(fake)).toBe('parseable');
  });

  it('detects parseable with parse only', () => {
    const fake = { parse: () => null };
    expect(detectSchema(fake)).toBe('parseable');
  });

  // ── JSON Schema ────────────────────────────────────────────────────────

  it('detects JSON Schema with type property', () => {
    expect(detectSchema({ type: 'object', properties: {} })).toBe('json-schema');
  });

  it('detects JSON Schema with only properties', () => {
    expect(detectSchema({ properties: { name: { type: 'string' } } })).toBe('json-schema');
  });

  it('detects JSON Schema with type: string', () => {
    expect(detectSchema({ type: 'string' })).toBe('json-schema');
  });

  // ── None ───────────────────────────────────────────────────────────────

  it('returns none for null', () => {
    expect(detectSchema(null)).toBe('none');
  });

  it('returns none for undefined', () => {
    expect(detectSchema(undefined)).toBe('none');
  });

  it('returns none for numbers', () => {
    expect(detectSchema(42)).toBe('none');
  });

  it('returns none for strings', () => {
    expect(detectSchema('hello')).toBe('none');
  });

  it('returns none for empty objects', () => {
    expect(detectSchema({})).toBe('none');
  });

  it('returns none for arrays', () => {
    expect(detectSchema([1, 2, 3])).toBe('none');
  });

  // ── Priority: Zod > parseable > json-schema ────────────────────────────

  it('Zod schemas detected as zod, not parseable (even though they have safeParse)', () => {
    // Zod schemas have both ._def AND .safeParse — should be detected as 'zod' not 'parseable'
    const schema = z.string();
    expect(typeof (schema as any).safeParse).toBe('function');
    expect(detectSchema(schema)).toBe('zod');
  });
});

describe('isZod', () => {
  it('returns true for Zod schemas', () => {
    expect(isZod(z.string())).toBe(true);
  });

  it('returns false for non-Zod', () => {
    expect(isZod(null)).toBe(false);
    expect(isZod({ parse: () => {} })).toBe(false);
    expect(isZod({ type: 'object' })).toBe(false);
  });
});

describe('isValidatable', () => {
  it('returns true for Zod schemas', () => {
    expect(isValidatable(z.string())).toBe(true);
  });

  it('returns true for parseable objects', () => {
    expect(isValidatable({ safeParse: () => {} })).toBe(true);
  });

  it('returns false for JSON Schema (no safeParse/parse)', () => {
    expect(isValidatable({ type: 'object', properties: {} })).toBe(false);
  });

  it('returns false for non-schemas', () => {
    expect(isValidatable(null)).toBe(false);
    expect(isValidatable(42)).toBe(false);
  });
});
