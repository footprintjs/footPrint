/**
 * Tests for reactive/allowlist -- shouldWrapWithProxy.
 *
 * Covers: unit (all value types), boundary (edge cases), property (fast-check),
 * performance (throughput), security (internal slot safety).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { shouldWrapWithProxy } from '../../../../src/lib/reactive/allowlist';

// -- Unit: core value types --------------------------------------------------

describe('allowlist -- unit: primitives return false', () => {
  it.each([
    ['string', 'hello'],
    ['number', 42],
    ['boolean', true],
    ['undefined', undefined],
    ['null', null],
    ['bigint', BigInt(9007199254740991)],
    ['symbol', Symbol('test')],
  ])('%s', (_, value) => {
    expect(shouldWrapWithProxy(value)).toBe(false);
  });
});

describe('allowlist -- unit: plain objects return true', () => {
  it('empty object', () => {
    expect(shouldWrapWithProxy({})).toBe(true);
  });

  it('object with properties', () => {
    expect(shouldWrapWithProxy({ name: 'Alice', age: 30 })).toBe(true);
  });

  it('nested object', () => {
    expect(shouldWrapWithProxy({ a: { b: { c: 1 } } })).toBe(true);
  });
});

describe('allowlist -- unit: arrays return true', () => {
  it('empty array', () => {
    expect(shouldWrapWithProxy([])).toBe(true);
  });

  it('array with items', () => {
    expect(shouldWrapWithProxy([1, 2, 3])).toBe(true);
  });

  it('array of objects', () => {
    expect(shouldWrapWithProxy([{ id: 1 }, { id: 2 }])).toBe(true);
  });
});

describe('allowlist -- unit: built-in types return false', () => {
  it('Date', () => {
    expect(shouldWrapWithProxy(new Date())).toBe(false);
  });

  it('RegExp', () => {
    expect(shouldWrapWithProxy(/test/i)).toBe(false);
  });

  it('Map', () => {
    expect(shouldWrapWithProxy(new Map())).toBe(false);
  });

  it('Set', () => {
    expect(shouldWrapWithProxy(new Set())).toBe(false);
  });

  it('WeakMap', () => {
    expect(shouldWrapWithProxy(new WeakMap())).toBe(false);
  });

  it('WeakSet', () => {
    expect(shouldWrapWithProxy(new WeakSet())).toBe(false);
  });

  it('Error', () => {
    expect(shouldWrapWithProxy(new Error('test'))).toBe(false);
  });

  it('TypeError', () => {
    expect(shouldWrapWithProxy(new TypeError('test'))).toBe(false);
  });

  it('Promise', () => {
    expect(shouldWrapWithProxy(Promise.resolve())).toBe(false);
  });

  it('ArrayBuffer', () => {
    expect(shouldWrapWithProxy(new ArrayBuffer(8))).toBe(false);
  });

  it('Uint8Array', () => {
    expect(shouldWrapWithProxy(new Uint8Array(4))).toBe(false);
  });

  it('Float64Array', () => {
    expect(shouldWrapWithProxy(new Float64Array(4))).toBe(false);
  });

  it('DataView', () => {
    expect(shouldWrapWithProxy(new DataView(new ArrayBuffer(8)))).toBe(false);
  });
});

describe('allowlist -- unit: class instances return false', () => {
  it('custom class instance', () => {
    class Customer {
      name = 'Alice';
    }
    expect(shouldWrapWithProxy(new Customer())).toBe(false);
  });

  it('class with no properties', () => {
    class Empty {}
    expect(shouldWrapWithProxy(new Empty())).toBe(false);
  });

  it('subclass instance', () => {
    class Base {
      x = 1;
    }
    class Derived extends Base {
      y = 2;
    }
    expect(shouldWrapWithProxy(new Derived())).toBe(false);
  });
});

// -- Boundary: edge cases ----------------------------------------------------

describe('allowlist -- boundary: edge cases', () => {
  it('Object.create(null) -- no prototype, treat as plain object', () => {
    const obj = Object.create(null);
    obj.key = 'value';
    expect(shouldWrapWithProxy(obj)).toBe(true);
  });

  it('frozen plain object -- returned unwrapped (set traps would fail)', () => {
    expect(shouldWrapWithProxy(Object.freeze({ a: 1 }))).toBe(false);
  });

  it('sealed plain object -- returned unwrapped (set traps would fail)', () => {
    expect(shouldWrapWithProxy(Object.seal({ a: 1 }))).toBe(false);
  });

  it('frozen array -- returned unwrapped', () => {
    expect(shouldWrapWithProxy(Object.freeze([1, 2, 3]))).toBe(false);
  });

  it('sealed array -- returned unwrapped (push/pop would throw in strict mode)', () => {
    expect(shouldWrapWithProxy(Object.seal([1, 2, 3]))).toBe(false);
  });

  it('object with Symbol keys', () => {
    const obj = { [Symbol('key')]: 'value', normal: 'yes' };
    expect(shouldWrapWithProxy(obj)).toBe(true);
  });

  it('function (typeof === "function", not "object")', () => {
    expect(shouldWrapWithProxy(() => {})).toBe(false);
  });

  it('arrow function', () => {
    expect(shouldWrapWithProxy(() => 42)).toBe(false);
  });

  it('arguments-like object (plain object constructor)', () => {
    // Plain object with numeric keys
    const argsLike = { 0: 'a', 1: 'b', length: 2 };
    expect(shouldWrapWithProxy(argsLike)).toBe(true);
  });
});

// -- Property: fast-check randomized ----------------------------------------

describe('allowlist -- property: never throws', () => {
  it('shouldWrapWithProxy never throws for any value', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        // Should always return a boolean, never throw
        const result = shouldWrapWithProxy(value);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });
});

// -- Performance: throughput benchmark ---------------------------------------

describe('allowlist -- performance: throughput', () => {
  it('10K calls complete in under 50ms', () => {
    const values = [
      {},
      [],
      new Date(),
      new Map(),
      'string',
      42,
      null,
      undefined,
      { a: 1 },
      [1, 2, 3],
      new Set(),
      /regex/,
      new Error('x'),
    ];
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      shouldWrapWithProxy(values[i % values.length]);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// -- Security: internal slot safety ------------------------------------------

describe('allowlist -- security: internal slot safety', () => {
  it('Date is never proxied (prevents getTime internal slot error)', () => {
    expect(shouldWrapWithProxy(new Date())).toBe(false);
  });

  it('Map is never proxied (prevents get/set internal slot error)', () => {
    expect(shouldWrapWithProxy(new Map([['key', 'value']]))).toBe(false);
  });

  it('Set is never proxied (prevents add/has internal slot error)', () => {
    expect(shouldWrapWithProxy(new Set([1, 2, 3]))).toBe(false);
  });

  it('Promise is never proxied (prevents then/catch internal slot error)', () => {
    expect(shouldWrapWithProxy(Promise.resolve(42))).toBe(false);
  });

  it('class instances are never proxied (preserves instanceof)', () => {
    class Service {
      handle() {
        return 'ok';
      }
    }
    const svc = new Service();
    expect(shouldWrapWithProxy(svc)).toBe(false);
    // Consumer code can safely do instanceof checks
    expect(svc instanceof Service).toBe(true);
  });

  it('Symbol.toStringTag spoofing does not block plain object proxying', () => {
    // A plain object with Symbol.toStringTag set to 'Date' should still be wrappable
    // because the constructor check (Object) fires before the tag check
    const spoof = { [Symbol.toStringTag]: 'Date', value: 1 };
    expect(shouldWrapWithProxy(spoof)).toBe(true);
  });

  it('Symbol.toStringTag spoofing with Map tag is also safe', () => {
    const spoof = { [Symbol.toStringTag]: 'Map', entries: [] };
    expect(shouldWrapWithProxy(spoof)).toBe(true);
  });
});
