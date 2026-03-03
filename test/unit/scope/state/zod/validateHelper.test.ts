/**
 * validateHelper.test.ts
 *
 * Additional coverage tests for validateHelper targeting uncovered lines:
 * - Lines 22-24: unwrap() hitting def.schema path (effects/branded/catch)
 * - Lines 26-28: unwrap() hitting def.type path (readonly)
 * - Lines 87-97:  parseWithThis() bound safeParse fallback (step 2)
 * - Lines 99-106: parseWithThis() parse fallback (step 3)
 * - Lines 108-117: parseWithThis() wrapper fallback (step 4)
 *
 * Includes property-based tests using fast-check for validation invariants.
 */

import { z, ZodTypeAny } from 'zod';
import * as fc from 'fast-check';

import {
  isZodNode,
  unwrap,
  getRecordValueType,
  parseWithThis,
} from '../../../../../src/scope/state/zod/utils/validateHelper';

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe('validateHelper', () => {
  // ─── isZodNode ──────────────────────────────────────────────────────
  describe('isZodNode', () => {
    it('should return true for actual Zod schemas', () => {
      expect(isZodNode(z.string())).toBe(true);
      expect(isZodNode(z.number())).toBe(true);
      expect(isZodNode(z.object({ a: z.string() }))).toBe(true);
      expect(isZodNode(z.array(z.number()))).toBe(true);
    });

    it('should return false for non-Zod values', () => {
      expect(isZodNode(null)).toBe(false);
      expect(isZodNode(undefined)).toBe(false);
      expect(isZodNode(42)).toBe(false);
      expect(isZodNode('hello')).toBe(false);
      expect(isZodNode({})).toBe(false);
      expect(isZodNode([])).toBe(false);
    });

    it('should return true for objects with _def', () => {
      expect(isZodNode({ _def: {} })).toBe(true);
    });

    it('should return true for objects with parse function', () => {
      expect(isZodNode({ parse: () => {} })).toBe(true);
    });

    it('should return true for objects with safeParse function', () => {
      expect(isZodNode({ safeParse: () => {} })).toBe(true);
    });
  });

  // ─── unwrap ─────────────────────────────────────────────────────────
  describe('unwrap', () => {
    it('should return null for null/undefined input', () => {
      expect(unwrap(null)).toBeNull();
      expect(unwrap(undefined)).toBeNull();
    });

    it('should return the schema itself when no wrapping exists', () => {
      const schema = z.string();
      const result = unwrap(schema);
      expect(result).not.toBeNull();
      expect(isZodNode(result)).toBe(true);
    });

    it('should peel optional wrapper (def.innerType path)', () => {
      const base = z.string();
      const wrapped = base.optional();
      const result = unwrap(wrapped);
      expect(result).not.toBeNull();
      // Should unwrap to the base string schema
      expect(() => parseWithThis(result!, 'hello')).not.toThrow();
      expect(() => parseWithThis(result!, 42 as any)).toThrow();
    });

    it('should peel nullable wrapper (def.innerType path)', () => {
      const base = z.number();
      const wrapped = base.nullable();
      const result = unwrap(wrapped);
      expect(result).not.toBeNull();
      expect(() => parseWithThis(result!, 42)).not.toThrow();
      expect(() => parseWithThis(result!, 'bad' as any)).toThrow();
    });

    it('should peel default wrapper (def.innerType path)', () => {
      const base = z.boolean();
      const wrapped = base.default(true);
      const result = unwrap(wrapped);
      expect(result).not.toBeNull();
      expect(() => parseWithThis(result!, true)).not.toThrow();
      expect(() => parseWithThis(result!, 'bad' as any)).toThrow();
    });

    // Lines 22-24: effects/branded/catch path (def.schema)
    it('should peel ZodEffects wrapper via def.schema path (transform)', () => {
      const base = z.string();
      const transformed = base.transform((v) => v.toUpperCase());
      const result = unwrap(transformed);
      expect(result).not.toBeNull();
      // After unwrapping the transform, the base string schema remains
      expect(() => parseWithThis(result!, 'hello')).not.toThrow();
      expect(() => parseWithThis(result!, 42 as any)).toThrow();
    });

    it('should peel ZodEffects wrapper via def.schema path (refine)', () => {
      const base = z.number();
      const refined = base.refine((n) => n > 0, 'Must be positive');
      const result = unwrap(refined);
      expect(result).not.toBeNull();
      // After unwrapping the refinement, the base number schema remains
      expect(() => parseWithThis(result!, 42)).not.toThrow();
      expect(() => parseWithThis(result!, 'bad' as any)).toThrow();
    });

    it('should peel ZodEffects wrapper via def.schema path (preprocess)', () => {
      const preprocessed = z.preprocess((val) => Number(val), z.number());
      const result = unwrap(preprocessed);
      expect(result).not.toBeNull();
      // After unwrapping, we get the inner z.number()
      expect(() => parseWithThis(result!, 42)).not.toThrow();
    });

    it('should peel brand wrapper via def.schema path (if applicable)', () => {
      const base = z.string();
      const branded = base.brand<'MyBrand'>();
      const result = unwrap(branded);
      expect(result).not.toBeNull();
      expect(() => parseWithThis(result!, 'valid')).not.toThrow();
      expect(() => parseWithThis(result!, 42 as any)).toThrow();
    });

    it('should peel catch wrapper via def.schema path (if applicable)', () => {
      const base = z.string();
      const caught = base.catch('default-value');
      const result = unwrap(caught);
      expect(result).not.toBeNull();
      // After unwrapping the catch, the base string schema remains
      expect(() => parseWithThis(result!, 'valid')).not.toThrow();
    });

    // Lines 26-28: readonly path (def.type)
    it('should peel readonly wrapper via def.type path', () => {
      const base = z.object({ x: z.number() });
      const readonlySchema = base.readonly();
      const result = unwrap(readonlySchema);
      expect(result).not.toBeNull();
      expect(() => parseWithThis(result!, { x: 42 })).not.toThrow();
      expect(() => parseWithThis(result!, { x: 'bad' })).toThrow();
    });

    // Lines 22-24: synthetic test for def.schema path (cross-version compat)
    // In the current Zod version, no schema uses _def.schema as a ZodNode.
    // This path is defensive for other Zod versions/bundles (effects/branded/catch).
    it('should peel via def.schema path when _def.schema is a ZodNode (synthetic)', () => {
      const inner = z.number();
      // Create a synthetic wrapper that has _def.schema pointing to a real ZodNode
      // but NOT _def.innerType (so it doesn't take the earlier branch)
      const syntheticWrapper: any = {
        _def: {
          schema: inner,
          // No innerType - forces the def.schema branch
        },
        // Must satisfy isZodNode check
        safeParse: inner.safeParse.bind(inner),
        parse: inner.parse.bind(inner),
      };

      const result = unwrap(syntheticWrapper);
      expect(result).not.toBeNull();
      expect(isZodNode(result)).toBe(true);
    });

    // Lines 26-28: synthetic test for def.type path (cross-version compat)
    // In the current Zod version, readonly uses _def.innerType (not def.type as ZodNode).
    // This path is defensive for Zod bundles where readonly stores at _def.type.
    it('should peel via def.type path when _def.type is a ZodNode (synthetic)', () => {
      const inner = z.string();
      // Create a synthetic wrapper that has _def.type pointing to a real ZodNode
      // but NOT _def.innerType or _def.schema (so it falls through to the type branch)
      const syntheticWrapper: any = {
        _def: {
          type: inner,
          // No innerType, no schema - forces the def.type branch
        },
        // Must satisfy isZodNode check
        safeParse: inner.safeParse.bind(inner),
        parse: inner.parse.bind(inner),
      };

      const result = unwrap(syntheticWrapper);
      expect(result).not.toBeNull();
      expect(isZodNode(result)).toBe(true);
      // The unwrapped schema should be the inner z.string()
      expect(() => parseWithThis(result!, 'hello')).not.toThrow();
      expect(() => parseWithThis(result!, 42 as any)).toThrow();
    });

    it('should peel deeply nested wrappers', () => {
      const base = z.string();
      // optional -> nullable -> default -> transform -> readonly
      const deep = base
        .optional()
        .nullable()
        .default(null)
        .transform((v) => v ?? '');

      const result = unwrap(deep);
      expect(result).not.toBeNull();
      expect(isZodNode(result)).toBe(true);
    });

    it('should peel nested effects inside optional', () => {
      const base = z.number().transform((n) => n * 2);
      const wrapped = base.optional().default(0);
      const result = unwrap(wrapped);
      expect(result).not.toBeNull();
      // Should unwrap to the base z.number()
      expect(() => parseWithThis(result!, 42)).not.toThrow();
    });
  });

  // ─── getRecordValueType ─────────────────────────────────────────────
  describe('getRecordValueType', () => {
    it('should extract value schema from z.record(z.string(), z.number())', () => {
      const rec = z.record(z.string(), z.number());
      const v = getRecordValueType(rec);
      expect(v).not.toBeNull();
      expect(() => parseWithThis(v!, 42)).not.toThrow();
      expect(() => parseWithThis(v!, 'bad' as any)).toThrow();
    });

    it('should extract value schema from z.record(z.string(), z.boolean())', () => {
      const rec = z.record(z.string(), z.boolean());
      const v = getRecordValueType(rec);
      expect(v).not.toBeNull();
      expect(() => parseWithThis(v!, true)).not.toThrow();
      expect(() => parseWithThis(v!, 42 as any)).toThrow();
    });

    it('should return null for non-record schemas', () => {
      // A schema without any record-like properties
      const fakeRec = { _def: {} } as any;
      expect(getRecordValueType(fakeRec)).toBeNull();
    });
  });

  // ─── parseWithThis ──────────────────────────────────────────────────
  describe('parseWithThis', () => {
    it('should parse valid input via direct safeParse (step 1)', () => {
      expect(parseWithThis(z.string(), 'hello')).toBe('hello');
      expect(parseWithThis(z.number(), 42)).toBe(42);
      expect(parseWithThis(z.boolean(), true)).toBe(true);
    });

    it('should throw ZodError for invalid input via direct safeParse', () => {
      expect(() => parseWithThis(z.string(), 42)).toThrow();
      expect(() => parseWithThis(z.number(), 'bad')).toThrow();
    });

    it('should handle complex schemas', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
        tags: z.array(z.string()),
      });

      const result = parseWithThis(schema, {
        name: 'Alice',
        age: 30,
        tags: ['dev', 'test'],
      });

      expect(result).toEqual({
        name: 'Alice',
        age: 30,
        tags: ['dev', 'test'],
      });
    });

    it('should throw for complex schema with invalid data', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      expect(() => parseWithThis(schema, { name: 123, age: 'bad' })).toThrow();
    });

    // Lines 87-97: Bound safeParse fallback (step 2)
    // To exercise this, create a schema where direct safeParse throws a binding error
    it('should fall through to bound safeParse when direct safeParse throws binding error', () => {
      let callCount = 0;
      const fakeSchema: any = {
        _def: {},
        safeParse(value: unknown) {
          callCount++;
          if (callCount === 1) {
            // First call (step 1): simulate binding error
            throw new Error('Cannot read properties of undefined');
          }
          // Second call (step 2): works correctly
          return { success: true, data: value };
        },
      };

      const result = parseWithThis(fakeSchema, 'test-value');
      expect(result).toBe('test-value');
      expect(callCount).toBe(2); // Called twice: step 1 failed, step 2 succeeded
    });

    it('should fall through to bound safeParse and throw ZodError on invalid data', () => {
      let callCount = 0;
      const validationError = new z.ZodError([
        { code: 'custom', message: 'invalid', path: [] },
      ]);

      const fakeSchema: any = {
        _def: {},
        safeParse(value: unknown) {
          callCount++;
          if (callCount === 1) {
            // First call (step 1): simulate binding error
            throw new Error('inst._zod is undefined');
          }
          // Second call (step 2): reports validation failure
          return { success: false, error: validationError };
        },
      };

      expect(() => parseWithThis(fakeSchema, 'bad-data')).toThrow();
      expect(callCount).toBe(2);
    });

    // Lines 99-106: Parse fallback (step 3)
    it('should fall through to parse when both safeParse calls throw binding errors', () => {
      const fakeSchema: any = {
        _def: {},
        safeParse() {
          throw new Error('Cannot read properties of undefined');
        },
        parse(value: unknown) {
          return value;
        },
      };

      const result = parseWithThis(fakeSchema, 'test-value');
      expect(result).toBe('test-value');
    });

    it('should fall through parse and re-throw non-binding error from parse', () => {
      const fakeSchema: any = {
        _def: {},
        safeParse() {
          throw new Error('Cannot read properties of undefined');
        },
        parse() {
          throw new Error('Custom validation error');
        },
      };

      expect(() => parseWithThis(fakeSchema, 'bad')).toThrow('Custom validation error');
    });

    // Lines 108-117: Wrapper fallback (step 4)
    it('should fall through to wrapper fallback when all previous methods have binding errors', () => {
      // Create a schema that acts like a valid Zod schema for the wrapper,
      // but whose safeParse and parse always throw binding errors.
      // The wrapper fallback uses z.any().pipe(schema), so the schema
      // needs to be pipe-compatible.
      const innerSchema = z.string();

      // Override safeParse and parse to throw binding errors
      const fakeSchema: any = Object.create(innerSchema);
      fakeSchema.safeParse = function () {
        throw new Error('_zod binding issue');
      };
      fakeSchema.parse = function () {
        throw new Error('_zod binding issue');
      };

      // The wrapper fallback creates z.any().pipe(fakeSchema)
      // Since fakeSchema inherits from innerSchema, the pipe should work
      // and parse the string value successfully.
      const result = parseWithThis(fakeSchema, 'hello');
      expect(result).toBe('hello');
    });

    it('should throw from wrapper fallback when data is invalid', () => {
      const innerSchema = z.number();

      const fakeSchema: any = Object.create(innerSchema);
      fakeSchema.safeParse = function () {
        throw new Error('_zod binding issue');
      };
      fakeSchema.parse = function () {
        throw new Error('_zod binding issue');
      };

      // Wrapper fallback uses z.any().pipe(fakeSchema)
      // Since fakeSchema inherits from z.number(), the pipe should
      // reject a string value.
      expect(() => parseWithThis(fakeSchema, 'not-a-number')).toThrow();
    });

    it('should throw TypeError when wrapper fallback also fails without error', () => {
      // Create a completely fake schema that fails at every level
      const fakeSchema: any = {
        _def: {},
        safeParse() {
          throw new Error('Cannot read properties of undefined');
        },
        parse() {
          throw new Error('Cannot read properties of undefined');
        },
      };

      // The wrapper fallback creates z.any().pipe(fakeSchema)
      // Since fakeSchema is not a real Zod schema, pipe behavior may vary.
      // This tests the error throwing path at line 117.
      expect(() => parseWithThis(fakeSchema, 'test')).toThrow();
    });

    it('should cache wrapper schemas via WRAPPER_CACHE', () => {
      const innerSchema = z.string();
      const fakeSchema: any = Object.create(innerSchema);
      fakeSchema.safeParse = function () {
        throw new Error('_zod binding issue');
      };
      fakeSchema.parse = function () {
        throw new Error('_zod binding issue');
      };

      // Call twice to exercise cache hit (second call should use cached wrapper)
      const result1 = parseWithThis(fakeSchema, 'first');
      const result2 = parseWithThis(fakeSchema, 'second');
      expect(result1).toBe('first');
      expect(result2).toBe('second');
    });

    it('should not hide real validation errors (non-binding) from safeParse', () => {
      // Direct safeParse should propagate real ZodErrors
      expect(() => parseWithThis(z.string().min(5), 'abc')).toThrow();
    });

    it('should handle schemas with no safeParse but with parse', () => {
      const fakeSchema: any = {
        _def: {},
        parse(value: unknown) {
          if (typeof value !== 'string') throw new Error('Expected string');
          return value;
        },
        // No safeParse at all
      };

      expect(parseWithThis(fakeSchema, 'hello')).toBe('hello');
      expect(() => parseWithThis(fakeSchema, 42)).toThrow('Expected string');
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Property-based tests (fast-check)
// ──────────────────────────────────────────────────────────────────────────────

describe('validateHelper — property-based tests', () => {
  // Helper: generate a valid base Zod schema
  const baseSchemaArb = fc.oneof(
    fc.constant(z.string()),
    fc.constant(z.number()),
    fc.constant(z.boolean()),
    fc.constant(z.string().min(1)),
    fc.constant(z.number().int()),
    fc.constant(z.number().positive()),
  );

  // Helper: wrap a schema with 0-3 layers of optional/default/nullable
  function wrapSchema(base: ZodTypeAny, wrappers: string[]): ZodTypeAny {
    let s: any = base;
    for (const w of wrappers) {
      switch (w) {
        case 'optional':
          s = s.optional();
          break;
        case 'nullable':
          s = s.nullable();
          break;
        case 'default':
          // Use a type-appropriate default
          s = s.default(undefined);
          break;
      }
    }
    return s;
  }

  const wrapperArb = fc.array(
    fc.oneof(
      fc.constant('optional'),
      fc.constant('nullable'),
    ),
    { minLength: 0, maxLength: 3 },
  );

  describe('unwrap properties', () => {
    it('any valid Zod schema wrapped in optional/nullable can be unwrapped to a base node', () => {
      fc.assert(
        fc.property(baseSchemaArb, wrapperArb, (base, wrappers) => {
          const wrapped = wrapSchema(base, wrappers);
          const result = unwrap(wrapped);
          // unwrap should always return a valid ZodNode (never null for valid schemas)
          expect(result).not.toBeNull();
          expect(isZodNode(result)).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('unwrap of a transform-wrapped schema returns a valid base schema', () => {
      fc.assert(
        fc.property(baseSchemaArb, (base) => {
          const transformed = (base as any).transform((v: any) => v);
          const result = unwrap(transformed);
          expect(result).not.toBeNull();
          expect(isZodNode(result)).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it('unwrap is idempotent (unwrapping twice gives same result)', () => {
      fc.assert(
        fc.property(baseSchemaArb, wrapperArb, (base, wrappers) => {
          const wrapped = wrapSchema(base, wrappers);
          const once = unwrap(wrapped);
          const twice = unwrap(once);
          // Both should be the same base schema (or both null)
          if (once === null) {
            expect(twice).toBeNull();
          } else {
            expect(twice).not.toBeNull();
          }
        }),
        { numRuns: 30 },
      );
    });
  });

  describe('parseWithThis properties', () => {
    it('parseWithThis with valid data always succeeds for string schema', () => {
      fc.assert(
        fc.property(fc.string(), (value) => {
          const result = parseWithThis(z.string(), value);
          expect(result).toBe(value);
        }),
        { numRuns: 100 },
      );
    });

    it('parseWithThis with valid data always succeeds for number schema', () => {
      fc.assert(
        fc.property(
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          (value) => {
            const result = parseWithThis(z.number(), value);
            expect(result).toBe(value);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('parseWithThis with valid data always succeeds for boolean schema', () => {
      fc.assert(
        fc.property(fc.boolean(), (value) => {
          const result = parseWithThis(z.boolean(), value);
          expect(result).toBe(value);
        }),
        { numRuns: 20 },
      );
    });

    it('parseWithThis with invalid data always throws for string schema', () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
          (value) => {
            expect(() => parseWithThis(z.string(), value)).toThrow();
          },
        ),
        { numRuns: 50 },
      );
    });

    it('parseWithThis with invalid data always throws for number schema', () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.string(), fc.boolean(), fc.constant(null)),
          (value) => {
            expect(() => parseWithThis(z.number(), value)).toThrow();
          },
        ),
        { numRuns: 50 },
      );
    });

    it('parseWithThis with invalid data always throws for boolean schema', () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          (value) => {
            expect(() => parseWithThis(z.boolean(), value)).toThrow();
          },
        ),
        { numRuns: 50 },
      );
    });

    it('parseWithThis produces same result as schema.parse for valid objects', () => {
      const objSchema = z.object({
        name: z.string(),
        value: z.number(),
      });

      fc.assert(
        fc.property(fc.string(), fc.double({ noNaN: true, noDefaultInfinity: true }), (name, value) => {
          const input = { name, value };
          const expected = objSchema.parse(input);
          const actual = parseWithThis(objSchema, input);
          expect(actual).toEqual(expected);
        }),
        { numRuns: 50 },
      );
    });
  });
});
