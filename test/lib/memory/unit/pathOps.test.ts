/**
 * Tests for memory/pathOps.ts — nativeGet prototype-read security fix.
 *
 * Fix: nativeGet previously used plain bracket notation (curr[seg]) which
 * followed the JavaScript prototype chain. This meant:
 *   - nativeGet({}, '__proto__')        → leaked Object.prototype
 *   - nativeGet({}, 'constructor')      → leaked Object constructor
 *   - nativeGet({}, 'toString')         → leaked the inherited toString fn
 *
 * Fix adds two guards per segment:
 *   1. DENIED key check  — blocks '__proto__', 'constructor', 'prototype'
 *   2. hasOwnProperty    — ensures every intermediate node owns the key
 */

import { mergeContextWins, nativeGet, nativeHas, nativeSet } from '../../../../src/lib/memory/pathOps';

// ---------------------------------------------------------------------------
// Pattern 1: unit — basic read / default value / null-safe traversal
// ---------------------------------------------------------------------------
describe('nativeGet — unit: basic behaviour', () => {
  it('reads a top-level own property', () => {
    expect(nativeGet({ a: 1 }, 'a')).toBe(1);
  });

  it('reads a nested own property via dot-path', () => {
    expect(nativeGet({ a: { b: 2 } }, 'a.b')).toBe(2);
  });

  it('returns defaultValue when path does not exist', () => {
    expect(nativeGet({ a: 1 }, 'b', 99)).toBe(99);
  });

  it('returns undefined (no default) when path does not exist', () => {
    expect(nativeGet({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns defaultValue when intermediate node is null', () => {
    expect(nativeGet({ a: null }, 'a.b', 'fallback')).toBe('fallback');
  });

  it('reads array elements by numeric index', () => {
    expect(nativeGet({ tags: ['x', 'y'] }, ['tags', 0])).toBe('x');
  });

  it('sparse-array hole returns defaultValue (hole slot fails hasOwnProperty)', () => {
    // eslint-disable-next-line no-sparse-arrays
    const arr = [, , 3]; // indices 0 and 1 are holes — not own properties
    const state = { arr };
    expect(nativeGet(state, ['arr', 0], 'fallback')).toBe('fallback');
    expect(nativeGet(state, ['arr', 2])).toBe(3); // index 2 IS an own property
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — prototype-read prevention (the core fix)
// ---------------------------------------------------------------------------
describe('nativeGet — boundary: prototype reads return defaultValue, not prototype chain', () => {
  it('__proto__ segment returns defaultValue, not Object.prototype', () => {
    const result = nativeGet({}, '__proto__', 'sentinel');
    expect(result).toBe('sentinel');
    // Explicitly: should NOT be Object.prototype
    expect(result).not.toBe(Object.prototype);
  });

  it('constructor segment returns defaultValue, not the Object constructor', () => {
    const result = nativeGet({}, 'constructor', 'sentinel');
    expect(result).toBe('sentinel');
    expect(result).not.toBe(Object);
  });

  it('prototype segment returns defaultValue, not Function.prototype', () => {
    const fn = function () {};
    const result = nativeGet(fn, 'prototype', 'sentinel');
    expect(result).toBe('sentinel');
  });

  it('nested path through __proto__ returns defaultValue', () => {
    const result = nativeGet({}, '__proto__.constructor', 'sentinel');
    expect(result).toBe('sentinel');
  });

  it('toString (inherited but not DENIED) is blocked by hasOwnProperty', () => {
    // toString is NOT in the DENIED set but IS on the prototype.
    // hasOwnProperty guard must prevent reading it.
    const result = nativeGet({}, 'toString', 'sentinel');
    expect(result).toBe('sentinel');
  });

  it('valueOf (inherited but not DENIED) is blocked by hasOwnProperty', () => {
    const result = nativeGet({}, 'valueOf', 'sentinel');
    expect(result).toBe('sentinel');
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — realistic scope state read patterns
// ---------------------------------------------------------------------------
describe('nativeGet — scenario: realistic scope reads', () => {
  it('reads deeply nested customer address', () => {
    const state = { customer: { address: { zip: '90210' } } };
    expect(nativeGet(state, 'customer.address.zip')).toBe('90210');
  });

  it('returns undefined for a missing optional field', () => {
    const state = { creditScore: 750 };
    expect(nativeGet(state, 'approved')).toBeUndefined();
  });

  it('reads array elements at known index', () => {
    const state = { items: [{ id: 1 }, { id: 2 }] };
    expect(nativeGet(state, ['items', 1, 'id'])).toBe(2);
  });

  it('returns defaultValue when path goes through a missing intermediate', () => {
    const state = { customer: {} };
    expect(nativeGet(state, 'customer.address.zip', 'unknown')).toBe('unknown');
  });

  it('reads a falsy-but-present value correctly (0, false, empty string)', () => {
    const state = { count: 0, flag: false, label: '' };
    expect(nativeGet(state, 'count')).toBe(0);
    expect(nativeGet(state, 'flag')).toBe(false);
    expect(nativeGet(state, 'label')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — hasOwnProperty enforced at every segment
// ---------------------------------------------------------------------------
describe('nativeGet — property: own-property check at every step', () => {
  it('inherited property on prototype-chained object is NOT readable via nativeGet', () => {
    const base = { inherited: 42 };
    const child = Object.create(base);
    // 'inherited' is on the prototype — hasOwnProperty.call(child, 'inherited') is false
    expect(nativeGet(child, 'inherited', 'fallback')).toBe('fallback');
  });

  it('own property on child IS readable even when base has same key', () => {
    const base = { key: 'base' };
    const child = Object.create(base);
    child.key = 'own'; // own property shadows prototype
    expect(nativeGet(child, 'key')).toBe('own');
  });

  it('intermediate node must own each segment — partial chain stops at missing own-prop', () => {
    const state = { a: Object.create({ b: 99 }) };
    // state.a exists (own), but b is on state.a's prototype, not own
    expect(nativeGet(state, 'a.b', 'fallback')).toBe('fallback');
  });

  it('path segment array traversal stops at denied key anywhere in chain', () => {
    // Deny must work in the middle of a path
    const state = { a: { __proto__: { secret: 1 }, b: 2 } };
    expect(nativeGet(state, ['a', '__proto__', 'secret'], 'fallback')).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — pollution attack vectors
// ---------------------------------------------------------------------------
describe('nativeGet — security: prototype pollution attack vectors', () => {
  it('reading __proto__ never taints Object.prototype', () => {
    const obj = JSON.parse('{"__proto__":{"polluted":true}}');
    // JSON.parse creates a plain object with key "__proto__" (not actual __proto__)
    // nativeGet should return defaultValue since "__proto__" is in DENIED
    const result = nativeGet(obj, '__proto__', null);
    expect(result).toBeNull();
    // Confirm Object.prototype is clean
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  it('path with "constructor.prototype" never reaches Function.prototype', () => {
    const obj = {};
    const result = nativeGet(obj, 'constructor.prototype', 'safe');
    expect(result).toBe('safe');
    // Should not have modified Function.prototype
    expect((Function.prototype as any).injected).toBeUndefined();
  });

  it('crafted key "constructor" cannot reach Object via nativeGet', () => {
    const state = { user: { role: 'admin' } };
    const result = nativeGet(state, 'constructor', 'default');
    expect(result).toBe('default');
  });

  it('nativeSet (existing) + nativeGet: set a "constructor"-named key and get it back', () => {
    // After fix: nativeSet blocks writing "constructor"; nativeGet also blocks reading it.
    // Both should defend independently.
    const obj: any = {};
    nativeSet(obj, 'constructor', 'evil'); // nativeSet blocks this (DENIED)
    const result = nativeGet(obj, 'constructor', 'safe');
    expect(result).toBe('safe');
  });

  it('nativeHas and nativeGet are consistent for prototype-chain keys', () => {
    // nativeHas already uses hasOwnProperty — nativeGet now matches it
    const obj = {};
    expect(nativeHas(obj, '__proto__')).toBe(false);
    expect(nativeGet(obj, '__proto__', null)).toBeNull();

    expect(nativeHas(obj, 'toString')).toBe(false);
    expect(nativeGet(obj, 'toString', null)).toBeNull();
  });
});
