import { z } from 'zod';

import {
  getRecordValueType,
  isZodNode,
  parseWithThis,
  unwrap,
} from '../../../../../../src/scope/state/zod/utils/validateHelper';

describe('zod/utils/validateHelper', () => {
  describe('unwrap', () => {
    test('peels optional/nullable/default/effects to a base node that behaves like the original', () => {
      const Base = z.object({ a: z.string() });
      const Wrapped = Base.optional()
        .nullable()
        .default({})
        .transform((v) => v);

      const un = unwrap(Wrapped);
      expect(un).not.toBeNull();
      expect(isZodNode(un)).toBe(true);

      // behavior check (robust across Zod versions/classes)
      expect(() => parseWithThis(un!, { a: 'x' })).not.toThrow();
      expect(() => parseWithThis(un!, { a: 1 as any })).toThrow();
    });

    test('returns base scalar for wrapped primitives', () => {
      const S = z.string().optional().default('x');
      const un = unwrap(S);
      expect(un).not.toBeNull();
      // behavior check
      expect(() => parseWithThis(un!, 'ok')).not.toThrow();
      expect(() => parseWithThis(un!, 123 as any)).toThrow();
    });
  });

  describe('getRecordValueType', () => {
    test('extracts value schema for record(string -> number)', () => {
      const R = z.record(z.string(), z.number());
      const v = getRecordValueType(R);
      expect(v).not.toBeNull();
      expect(() => parseWithThis(v!, 42)).not.toThrow();
      expect(() => parseWithThis(v!, 'nope' as any)).toThrow();
    });

    test('extracts value schema for single-arg record(number)', () => {
      const R = z.record(z.number(), z.number());
      const v = getRecordValueType(R as any);
      expect(v).not.toBeNull();
      expect(() => parseWithThis(v!, 7)).not.toThrow();
      expect(() => parseWithThis(v!, 'x' as any)).toThrow();
    });
  });

  describe('parseWithThis', () => {
    test('parses valid input', () => {
      expect(parseWithThis(z.number().int(), 42)).toBe(42);
    });
    test('throws on invalid input', () => {
      expect(() => parseWithThis(z.number(), 'oops' as any)).toThrow();
    });
  });
});
