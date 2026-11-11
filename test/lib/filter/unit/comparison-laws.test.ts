/**
 * The two comparison laws of a filter rule (`filter/evaluator.ts`).
 *
 * ORDER (`gt`, `gte`, `lt`, `lte`) holds only between two values of the same ordered kind: two numbers,
 * two strings or two Dates. The operators used to be JavaScript's own `<` and `>`, which coerce: a missing
 * score (`null`) counted as 0, so `{ score: { lt: 600 } }` routed a missing score as a low one, and so did
 * `''`, `[]` and `false`.
 *
 * SAME VALUE (`eq`, `ne`, `in`, `notIn`) is one equality. `eq` used to be `===` and `in` used `includes`, so
 * `NaN` failed `eq: NaN` and matched `in: [NaN]`; a Date compared by identity, so it never matched at all,
 * while `gt` compared it by its time.
 *
 * Test types: unit, boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../../src/index.js';
import { evaluateFilter } from '../../../../src/lib/filter/evaluator';

/** One condition: does `actual <op> threshold` hold? */
function holds(actual: unknown, op: string, threshold: unknown): boolean {
  const { matched } = evaluateFilter(
    () => actual,
    () => false,
    { value: { [op]: threshold } } as never,
  );
  return matched;
}

const ORDERED = ['gt', 'gte', 'lt', 'lte'] as const;

describe('order — a missing value is in no order with anything', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('%s satisfies no ordered operator, whatever the threshold', (_name, missing) => {
    for (const op of ORDERED) {
      for (const threshold of [600, 0, -1, 'a', new Date(0)]) {
        expect(holds(missing, op, threshold), `${String(missing)} ${op} ${String(threshold)}`).toBe(false);
      }
    }
  });

  it('the reported case: a missing score is not a low score, and not "at least zero"', () => {
    expect(holds(null, 'lt', 600)).toBe(false);
    expect(holds(null, 'lte', 0)).toBe(false);
    expect(holds(null, 'gte', 0)).toBe(false);
  });

  it('a missing THRESHOLD satisfies nothing either', () => {
    for (const op of ORDERED) {
      expect(holds(-5, op, null)).toBe(false);
      expect(holds(5, op, undefined)).toBe(false);
    }
  });
});

describe('order — values that JavaScript would coerce to a number are not numbers', () => {
  it.each([
    ['an empty string', ''],
    ['a numeric string', '700'],
    ['an empty array', []],
    ['a one-number array', [700]],
    ['false', false],
    ['true', true],
    ['an object with valueOf', { valueOf: () => 700 }],
  ])('%s is in no order with a number', (_name, value) => {
    for (const op of ORDERED) {
      expect(holds(value, op, 600)).toBe(false);
      expect(holds(600, op, value)).toBe(false);
    }
  });

  it("a threshold object's code never runs", () => {
    let ran = 0;
    const threshold = {
      valueOf() {
        ran += 1;
        return 1;
      },
      toString() {
        ran += 1;
        return '1';
      },
      [Symbol.toPrimitive]() {
        ran += 1;
        return 1;
      },
    };
    for (const op of ORDERED) expect(holds(5, op, threshold)).toBe(false);
    expect(ran).toBe(0);
  });

  it('a Date is in no order with a number, even its own time', () => {
    const when = new Date(1_000);
    for (const op of ORDERED) {
      expect(holds(when, op, 999)).toBe(false);
      expect(holds(999, op, when)).toBe(false);
    }
  });
});

describe('order — two values of one ordered kind compare as before', () => {
  it('numbers', () => {
    expect(holds(750, 'gt', 700)).toBe(true);
    expect(holds(700, 'gt', 700)).toBe(false);
    expect(holds(700, 'gte', 700)).toBe(true);
    expect(holds(0.38, 'lt', 0.43)).toBe(true);
    expect(holds(0.43, 'lt', 0.43)).toBe(false);
    expect(holds(0.43, 'lte', 0.43)).toBe(true);
    expect(holds(0.44, 'lte', 0.43)).toBe(false);
    expect(holds(699, 'gte', 700)).toBe(false);
    expect(holds(-0, 'gte', 0)).toBe(true);
    expect(holds(Infinity, 'gt', Number.MAX_VALUE)).toBe(true);
  });

  it('NaN is a number and is in no order, not even with itself', () => {
    for (const op of ORDERED) {
      expect(holds(NaN, op, NaN)).toBe(false);
      expect(holds(NaN, op, 1)).toBe(false);
      expect(holds(1, op, NaN)).toBe(false);
    }
  });

  it('a bigint is a number', () => {
    expect(holds(10n, 'gt', 9)).toBe(true);
    expect(holds(9, 'lt', 10n)).toBe(true);
    expect(holds(2n ** 64n, 'gt', Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(holds(10n, 'gte', 10n)).toBe(true);
  });

  it('strings, by code unit', () => {
    expect(holds('b', 'gt', 'a')).toBe(true);
    expect(holds('a', 'lt', 'b')).toBe(true);
    expect(holds('a', 'gte', 'a')).toBe(true);
    // Text order, not number order: "10" comes before "9".
    expect(holds('10', 'lt', '9')).toBe(true);
  });

  it('Dates, by their time', () => {
    const early = new Date('2026-01-01T00:00:00Z');
    const late = new Date('2026-06-01T00:00:00Z');
    expect(holds(late, 'gt', early)).toBe(true);
    expect(holds(early, 'lt', late)).toBe(true);
    expect(holds(new Date(early.getTime()), 'gte', early)).toBe(true);
    expect(holds(new Date(early.getTime()), 'lte', early)).toBe(true);
    expect(holds(new Date(NaN), 'lte', early)).toBe(false);
  });
});

describe('same value — eq, ne, in and notIn share one equality', () => {
  const pairs: Array<[string, unknown, unknown, boolean]> = [
    ['equal numbers', 5, 5, true],
    ['different numbers', 5, 6, false],
    ['+0 and -0', 0, -0, true],
    ['NaN and NaN', NaN, NaN, true],
    ['NaN and a number', NaN, 0, false],
    ['equal strings', 'premium', 'premium', true],
    ['a number and its text', 5, '5', false],
    ['null and null', null, null, true],
    ['null and undefined', null, undefined, false],
    ['null and 0', null, 0, false],
    ['a number and a bigint', 1, 1n, false],
    ['two Dates at one time', new Date(1_000), new Date(1_000), true],
    ['two Dates at different times', new Date(1_000), new Date(2_000), false],
    ['two unreadable Dates', new Date(NaN), new Date(NaN), true],
    ['a Date and its time', new Date(1_000), 1_000, false],
    ['two equal-looking objects', { a: 1 }, { a: 1 }, false],
    ['two equal-looking arrays', [1], [1], false],
  ];

  it.each(pairs)('%s', (_name, actual, threshold, same) => {
    expect(holds(actual, 'eq', threshold)).toBe(same);
    expect(holds(actual, 'ne', threshold)).toBe(!same);
    expect(holds(actual, 'in', [threshold])).toBe(same);
    expect(holds(actual, 'notIn', [threshold])).toBe(!same);
    // Among other members, and whichever side it is on.
    expect(holds(actual, 'in', ['other', threshold, 7])).toBe(same);
    expect(holds(threshold, 'eq', actual)).toBe(same);
  });

  it('an object is the same value as itself', () => {
    const one = { a: 1 };
    expect(holds(one, 'eq', one)).toBe(true);
    expect(holds(one, 'in', [one])).toBe(true);
  });

  it('in / notIn against something that is not a list: never in, always not in', () => {
    expect(holds('US', 'in', 'US')).toBe(false);
    expect(holds('US', 'notIn', 'US')).toBe(true);
  });
});

describe('dev mode — an ordered operator that met two present values with no order between them says so', () => {
  afterEach(() => {
    disableDevMode();
    vi.restoreAllMocks();
  });

  const warnings = (): string[] => {
    const seen: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: string) => {
      seen.push(message);
    });
    return seen;
  };

  it('names the operator, the key and the two kinds, never a value', () => {
    enableDevMode();
    const seen = warnings();
    expect(holds('700-SECRET', 'gt', 600)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"gt" on key "value" compares a string with a number');
    expect(seen[0]).not.toContain('SECRET');
    expect(seen[0]).not.toContain('600');
  });

  it.each([
    ['a missing actual value', null, 600],
    ['an unset actual value', undefined, 600],
    ['a missing threshold', 5, null],
    ['two numbers', 5, 600],
    ['two strings', 'a', 'b'],
  ])('is silent for %s', (_name, actual, threshold) => {
    enableDevMode();
    const seen = warnings();
    holds(actual, 'lt', threshold);
    expect(seen).toEqual([]);
  });

  it('is silent for the equality operators, which compare any two values', () => {
    enableDevMode();
    const seen = warnings();
    holds('5', 'eq', 5);
    holds('5', 'in', [5]);
    expect(seen).toEqual([]);
  });

  it('is silent outside dev mode', () => {
    const seen = warnings();
    holds('700', 'gt', 600);
    expect(seen).toEqual([]);
  });
});
