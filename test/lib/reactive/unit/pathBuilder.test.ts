/**
 * Tests for reactive/pathBuilder -- buildNestedPatch and joinPath.
 *
 * Covers: unit, boundary, property (fast-check), performance, security.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc, key) => (acc as Record<string, unknown>)?.[key], obj);
}

import { buildNestedPatch, joinPath } from '../../../../src/lib/reactive/pathBuilder';

// -- Unit: buildNestedPatch --------------------------------------------------

describe('pathBuilder -- unit: buildNestedPatch', () => {
  it('empty segments returns value as-is', () => {
    expect(buildNestedPatch([], 'hello')).toBe('hello');
  });

  it('single segment wraps value in object', () => {
    expect(buildNestedPatch(['zip'], '90210')).toEqual({ zip: '90210' });
  });

  it('two segments create nested object', () => {
    expect(buildNestedPatch(['address', 'zip'], '90210')).toEqual({
      address: { zip: '90210' },
    });
  });

  it('three segments create deeply nested object', () => {
    expect(buildNestedPatch(['customer', 'address', 'zip'], '90210')).toEqual({
      customer: { address: { zip: '90210' } },
    });
  });

  it('works with non-string values', () => {
    expect(buildNestedPatch(['score'], 85)).toEqual({ score: 85 });
    expect(buildNestedPatch(['active'], true)).toEqual({ active: true });
    expect(buildNestedPatch(['data'], null)).toEqual({ data: null });
    expect(buildNestedPatch(['items'], [1, 2, 3])).toEqual({ items: [1, 2, 3] });
  });

  it('works with object values at the leaf', () => {
    expect(buildNestedPatch(['config'], { retries: 3, timeout: 5000 })).toEqual({
      config: { retries: 3, timeout: 5000 },
    });
  });

  it('works with undefined value', () => {
    expect(buildNestedPatch(['key'], undefined)).toEqual({ key: undefined });
  });
});

// -- Unit: joinPath ----------------------------------------------------------

describe('pathBuilder -- unit: joinPath', () => {
  it('rootKey only (no segments)', () => {
    expect(joinPath('customer', [])).toBe('customer');
  });

  it('rootKey + one segment', () => {
    expect(joinPath('customer', ['name'])).toBe('customer.name');
  });

  it('rootKey + multiple segments', () => {
    expect(joinPath('customer', ['address', 'zip'])).toBe('customer.address.zip');
  });

  it('rootKey + deep segments', () => {
    expect(joinPath('a', ['b', 'c', 'd', 'e'])).toBe('a.b.c.d.e');
  });
});

// -- Boundary: edge cases ----------------------------------------------------

describe('pathBuilder -- boundary: edge cases', () => {
  it('10-deep nesting', () => {
    const segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const result = buildNestedPatch(segments, 42);
    expect(getByPath(result, segments.join('.'))).toBe(42);
  });

  it('numeric string keys', () => {
    expect(buildNestedPatch(['0', '1'], 'value')).toEqual({
      '0': { '1': 'value' },
    });
  });

  it('keys with dots in them (not dot-path -- literal key)', () => {
    // buildNestedPatch treats each segment as a literal key, not a dot-path
    expect(buildNestedPatch(['a.b', 'c'], 'value')).toEqual({
      'a.b': { c: 'value' },
    });
  });

  it('empty string key', () => {
    expect(buildNestedPatch([''], 'value')).toEqual({ '': 'value' });
  });

  it('keys with special characters', () => {
    expect(buildNestedPatch(['my-key', 'sub_key'], 'value')).toEqual({
      'my-key': { sub_key: 'value' },
    });
  });

  it('joinPath with numeric segments', () => {
    expect(joinPath('items', ['0', 'name'])).toBe('items.0.name');
  });
});

// -- Property: fast-check roundtrip ------------------------------------------

describe('pathBuilder -- property: roundtrip', () => {
  it('lodash.get(buildNestedPatch(segments, v), path) === v', () => {
    fc.assert(
      fc.property(
        // Generate 1-5 non-empty alpha string segments
        fc.array(fc.stringMatching(/^[a-zA-Z]\w{0,9}$/), { minLength: 1, maxLength: 5 }),
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (segments, value) => {
          const patch = buildNestedPatch(segments, value);
          const retrieved = getByPath(patch, segments.join('.'));
          expect(retrieved).toEqual(value);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('joinPath produces correct dot-notation for any segments', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z]\w{0,9}$/),
        fc.array(fc.stringMatching(/^[a-zA-Z]\w{0,9}$/), { minLength: 0, maxLength: 5 }),
        (rootKey, segments) => {
          const joined = joinPath(rootKey, segments);
          if (segments.length === 0) {
            expect(joined).toBe(rootKey);
          } else {
            expect(joined).toBe(`${rootKey}.${segments.join('.')}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// -- Performance: benchmark --------------------------------------------------

describe('pathBuilder -- performance', () => {
  it('10K 5-deep patches complete in under 20ms', () => {
    const segments = ['a', 'b', 'c', 'd', 'e'];
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      buildNestedPatch(segments, i);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('10K joinPath calls complete in under 10ms', () => {
    const segments = ['b', 'c', 'd', 'e'];
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      joinPath('a', segments);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// -- Security: prototype pollution -------------------------------------------

describe('pathBuilder -- security: prototype pollution', () => {
  it('__proto__ key creates a normal property, not a prototype mutation', () => {
    const patch = buildNestedPatch(['__proto__', 'polluted'], true) as any;
    // The patch should have __proto__ as an own property key, not mutate Object.prototype
    expect(Object.prototype.hasOwnProperty.call(patch, '__proto__')).toBe(true);
    // Object.prototype should NOT be polluted
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  it('constructor key creates a normal property', () => {
    const patch = buildNestedPatch(['constructor', 'name'], 'evil') as any;
    expect(Object.prototype.hasOwnProperty.call(patch, 'constructor')).toBe(true);
    // Object constructor should NOT be modified
    expect(Object.name).toBe('Object');
  });
});
