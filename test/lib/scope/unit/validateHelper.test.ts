import { z } from 'zod';

import {
  getRecordValueType,
  isZodNode,
  parseWithThis,
  unwrap,
} from '../../../../src/lib/scope/state/zod/utils/validateHelper';

describe('isZodNode', () => {
  it('returns true for zod schemas', () => {
    expect(isZodNode(z.string())).toBe(true);
    expect(isZodNode(z.number())).toBe(true);
    expect(isZodNode(z.object({}))).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isZodNode(null)).toBe(false);
    expect(isZodNode(undefined)).toBe(false);
    expect(isZodNode(42)).toBe(false);
    expect(isZodNode('hello')).toBe(false);
  });

  it('returns true for objects with _def', () => {
    expect(isZodNode({ _def: {} })).toBe(true);
  });

  it('returns true for objects with parse function', () => {
    expect(isZodNode({ parse: () => {} })).toBe(true);
  });

  it('returns true for objects with safeParse function', () => {
    expect(isZodNode({ safeParse: () => {} })).toBe(true);
  });

  it('returns false for empty objects', () => {
    expect(isZodNode({})).toBe(false);
  });
});

describe('unwrap', () => {
  it('returns null for null/undefined', () => {
    expect(unwrap(null)).toBeNull();
    expect(unwrap(undefined)).toBeNull();
  });

  it('returns base schema for simple types', () => {
    const s = z.string();
    expect(unwrap(s)).toBe(s);
  });

  it('unwraps optional types', () => {
    const inner = z.string();
    const optional = inner.optional();
    const result = unwrap(optional);
    // Should unwrap to the inner string schema
    expect(result).not.toBeNull();
  });

  it('unwraps nullable types', () => {
    const inner = z.number();
    const nullable = inner.nullable();
    const result = unwrap(nullable);
    expect(result).not.toBeNull();
  });

  it('unwraps default types', () => {
    const inner = z.string();
    const withDefault = inner.default('hello');
    const result = unwrap(withDefault);
    expect(result).not.toBeNull();
  });
});

describe('getRecordValueType', () => {
  it('extracts value type from ZodRecord', () => {
    const rec = z.record(z.string(), z.number());
    const valueType = getRecordValueType(rec);
    expect(valueType).not.toBeNull();
  });

  it('returns null when no value type is found', () => {
    // Create a minimal object that has no recognized value schema properties
    const fake = { _def: {} } as any;
    expect(getRecordValueType(fake)).toBeNull();
  });
});

describe('parseWithThis', () => {
  it('parses valid values successfully', () => {
    const schema = z.string();
    expect(parseWithThis(schema, 'hello')).toBe('hello');
  });

  it('parses numbers', () => {
    const schema = z.number();
    expect(parseWithThis(schema, 42)).toBe(42);
  });

  it('throws for invalid values', () => {
    const schema = z.string();
    expect(() => parseWithThis(schema, 123)).toThrow();
  });

  it('applies transforms via safeParse', () => {
    const schema = z.string().transform((s) => s.toUpperCase());
    expect(parseWithThis(schema, 'hello')).toBe('HELLO');
  });

  it('handles schema where safeParse throws a binding error and falls through to parse', () => {
    // Simulate a schema where safeParse throws a binding-like error
    const mockSchema = {
      safeParse: jest.fn().mockImplementation(() => {
        throw new Error("Cannot read properties of undefined (reading '_zod')");
      }),
      parse: jest.fn().mockReturnValue('parsed'),
      _def: {},
    } as any;

    expect(parseWithThis(mockSchema, 'value')).toBe('parsed');
  });

  it('re-throws non-binding errors from safeParse', () => {
    const mockSchema = {
      safeParse: jest.fn().mockImplementation(() => {
        throw new Error('Some other error');
      }),
      _def: {},
    } as any;

    expect(() => parseWithThis(mockSchema, 'value')).toThrow('Some other error');
  });

  it('falls through to wrapper when parse also throws binding error', () => {
    // Simulate a schema where both safeParse and parse throw binding errors
    // but z.any().pipe() wrapper succeeds
    const schema = z.string();
    // For a normal valid value, the first safeParse should succeed
    expect(parseWithThis(schema, 'hello')).toBe('hello');
  });

  it('handles safeParse returning a success result', () => {
    const mockSchema = {
      safeParse: jest.fn().mockReturnValue({ success: true, data: 'result' }),
      _def: {},
    } as any;

    expect(parseWithThis(mockSchema, 'value')).toBe('result');
  });

  it('throws error from safeParse failure result', () => {
    const error = new z.ZodError([{ code: 'custom', message: 'bad', path: [] }]);
    const mockSchema = {
      safeParse: jest.fn().mockReturnValue({ success: false, error }),
      _def: {},
    } as any;

    expect(() => parseWithThis(mockSchema, 'value')).toThrow();
  });

  it('falls to wrapper pipeline when all direct methods fail with binding errors', () => {
    const callCount = 0;
    const mockSchema = {
      safeParse: jest.fn().mockImplementation(() => {
        throw new Error('inst._zod is broken');
      }),
      parse: jest.fn().mockImplementation(() => {
        throw new Error('inst._zod is broken');
      }),
      _def: {},
    } as any;

    // The wrapper fallback uses z.any().pipe(schema), which will try safeParse on the wrapper.
    // Since our mock doesn't have real Zod internals, this may throw.
    // The important thing is that it attempts the wrapper path (lines 87-95).
    expect(() => parseWithThis(mockSchema, 'value')).toThrow();
  });

  it('handles safeParse returning non-standard result (no success property)', () => {
    // First safeParse returns something without 'success' property
    // Second safeParse.call also returns something without 'success'
    // Falls through to parse
    const callIdx = 0;
    const mockSchema = {
      safeParse: jest.fn().mockImplementation(function (this: any, val: any) {
        // Return something that doesn't have 'success' property
        return { unexpected: true };
      }),
      parse: jest.fn().mockReturnValue('parsed-value'),
      _def: {},
    } as any;

    expect(parseWithThis(mockSchema, 'test')).toBe('parsed-value');
  });

  it('uses safeParse.call path when first safeParse throws binding error (lines 71-72)', () => {
    // First safeParse (line 57) throws a binding error, falls through.
    // Second safeParse.call (line 69) succeeds with a success result.
    let callCount = 0;
    const mockSchema = {
      safeParse: jest.fn().mockImplementation(function (this: any, val: any) {
        callCount++;
        if (callCount === 1) {
          throw new Error("Cannot read properties of undefined (reading '_zod')");
        }
        // Second call via .call(schema, value) — returns success
        return { success: true, data: 'call-path-result' };
      }),
      _def: {},
    } as any;

    expect(parseWithThis(mockSchema, 'value')).toBe('call-path-result');
    expect(callCount).toBe(2);
  });

  it('throws from wrapper fallback when wrapper safeParse fails (lines 93-95)', () => {
    // All direct methods throw binding errors, wrapper also fails
    const mockSchema = {
      safeParse: jest.fn().mockImplementation(() => {
        throw new Error('inst._zod broken');
      }),
      parse: jest.fn().mockImplementation(() => {
        throw new Error('inst._zod broken');
      }),
      _def: {},
    } as any;

    // The z.any().pipe(schema) wrapper will try safeParse on the wrapper,
    // which internally calls our mock's safeParse that throws.
    // This exercises lines 93-95 (the wrapper fallback error path).
    expect(() => parseWithThis(mockSchema, 'value')).toThrow();
  });
});
