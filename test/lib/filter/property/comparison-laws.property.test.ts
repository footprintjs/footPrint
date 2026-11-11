/**
 * The two comparison laws of a filter rule, checked against a judge written separately from the evaluator.
 *
 * The judge states each law the long way round, so a slip in the evaluator's short form (a missed kind, a
 * coercion that crept back in) shows as a disagreement:
 *
 * - ORDER: classify both values; when they are not the same ordered kind the answer is "no"; otherwise the
 *   answer is the order of two numbers (a Date gives its time; text is compared code unit by code unit).
 * - SAME VALUE: the same kind, and the same content of that kind.
 *
 * Test type: Property (fast-check).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { evaluateFilter } from '../../../../src/lib/filter/evaluator';

function holds(actual: unknown, op: string, threshold: unknown): boolean {
  return evaluateFilter(
    () => actual,
    () => false,
    { value: { [op]: threshold } } as never,
  ).matched;
}

// -- The judge ---------------------------------------------------------------

type Kind = 'missing' | 'number' | 'bigint' | 'string' | 'boolean' | 'date' | 'other';

function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) return 'missing';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return value instanceof Date ? 'date' : 'other';
}

/** Text order without `<` on strings: the first differing code unit decides, then the length. */
function textOrder(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const difference = a.charCodeAt(i) - b.charCodeAt(i);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.length - b.length);
}

/** -1, 0 or 1 when the two are in an order; `undefined` when they are not. */
function judgeOrder(a: unknown, b: unknown): number | undefined {
  const [ka, kb] = [kindOf(a), kindOf(b)];
  const numeric = (kind: Kind) => kind === 'number' || kind === 'bigint';
  if (numeric(ka) && numeric(kb)) {
    if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
    // Exact for every mix of number and bigint the generators make (integers and simple fractions).
    if (ka === 'bigint' && kb === 'bigint') return a === b ? 0 : (a as bigint) < (b as bigint) ? -1 : 1;
    if (ka === 'bigint' || kb === 'bigint') {
      const [x, y] = [a as number | bigint, b as number | bigint];
      // eslint-disable-next-line eqeqeq
      return x == y ? 0 : x < y ? -1 : 1;
    }
    return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
  }
  if (ka === 'string' && kb === 'string') return textOrder(a as string, b as string);
  if (ka === 'date' && kb === 'date') {
    const [ta, tb] = [(a as Date).getTime(), (b as Date).getTime()];
    if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
    return Math.sign(ta - tb);
  }
  return undefined;
}

function judgeSame(a: unknown, b: unknown): boolean {
  const [ka, kb] = [kindOf(a), kindOf(b)];
  if (ka !== kb) return false;
  if (ka === 'date') {
    const [ta, tb] = [(a as Date).getTime(), (b as Date).getTime()];
    return ta === tb || (Number.isNaN(ta) && Number.isNaN(tb));
  }
  if (ka === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return a === b;
}

// -- Values ------------------------------------------------------------------

const numbers = fc.oneof(
  fc.integer({ min: -5, max: 5 }),
  fc.double({ noNaN: false }),
  fc.constantFrom(0, -0, NaN, Infinity, -Infinity, 600, 700),
);
const dates = fc.oneof(
  fc.integer({ min: -3, max: 3 }).map((ms) => new Date(ms)),
  fc.constant(new Date(NaN)),
);
const texts = fc.oneof(fc.string({ maxLength: 3 }), fc.constantFrom('', '0', '5', '10', '9', 'a', 'b', 'null'));
/** Every kind a state value or a threshold can be, weighted towards the ones that look like numbers. */
const anyValue = fc.oneof(
  numbers,
  fc.bigInt({ min: -5n, max: 5n }),
  texts,
  dates,
  fc.boolean(),
  fc.constantFrom(null, undefined),
  fc.constantFrom<unknown>([], [5], {}, { valueOf: () => 5 }),
);

const RUNS = { numRuns: 4000 };

describe('filter comparison laws (property)', () => {
  it('the four ordered operators agree with the judge for any two values', () => {
    fc.assert(
      fc.property(anyValue, anyValue, (a, b) => {
        const order = judgeOrder(a, b);
        expect(holds(a, 'gt', b)).toBe(order === 1);
        expect(holds(a, 'gte', b)).toBe(order === 1 || order === 0);
        expect(holds(a, 'lt', b)).toBe(order === -1);
        expect(holds(a, 'lte', b)).toBe(order === -1 || order === 0);
      }),
      RUNS,
    );
  });

  it('two values of different kinds are never in an order (no coercion)', () => {
    fc.assert(
      fc.property(anyValue, anyValue, (a, b) => {
        const [ka, kb] = [kindOf(a), kindOf(b)];
        const bothNumeric = (ka === 'number' || ka === 'bigint') && (kb === 'number' || kb === 'bigint');
        fc.pre(ka !== kb && !bothNumeric);
        for (const op of ['gt', 'gte', 'lt', 'lte']) expect(holds(a, op, b)).toBe(false);
      }),
      RUNS,
    );
  });

  it('an order is one-sided: a < b exactly when b > a, and never both ways', () => {
    fc.assert(
      fc.property(anyValue, anyValue, (a, b) => {
        expect(holds(a, 'lt', b)).toBe(holds(b, 'gt', a));
        expect(holds(a, 'lte', b)).toBe(holds(b, 'gte', a));
        expect(holds(a, 'lt', b) && holds(a, 'gt', b)).toBe(false);
        // "at most" and "at least" together are exactly "the same point in the order".
        expect(holds(a, 'lte', b) && holds(a, 'gte', b)).toBe(judgeOrder(a, b) === 0);
      }),
      RUNS,
    );
  });

  it("eq, ne, in and notIn are one equality, and it is the judge's", () => {
    fc.assert(
      fc.property(anyValue, anyValue, fc.array(anyValue, { maxLength: 3 }), (a, b, others) => {
        const same = judgeSame(a, b);
        expect(holds(a, 'eq', b)).toBe(same);
        expect(holds(a, 'ne', b)).toBe(!same);
        expect(holds(a, 'in', [b])).toBe(same);
        expect(holds(a, 'notIn', [b])).toBe(!same);
        const inList = [...others, b].some((member) => judgeSame(a, member));
        expect(holds(a, 'in', [...others, b])).toBe(inList);
        expect(holds(a, 'notIn', [...others, b])).toBe(!inList);
      }),
      RUNS,
    );
  });

  it('a value is the same value as a copy of itself', () => {
    const copy = (value: unknown): unknown => (value instanceof Date ? new Date(value.getTime()) : value);
    fc.assert(
      fc.property(fc.oneof(numbers, fc.bigInt({ min: -5n, max: 5n }), texts, dates, fc.boolean()), (value) => {
        expect(holds(value, 'eq', copy(value))).toBe(true);
        expect(holds(value, 'in', [copy(value)])).toBe(true);
      }),
      RUNS,
    );
  });
});
