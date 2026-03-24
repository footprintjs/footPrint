/**
 * Tests for reactive/createTypedScope -- the core Proxy factory.
 *
 * Covers: unit, boundary, scenario, property, performance, security.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { createTypedScope } from '../../../../src/lib/reactive/createTypedScope';
import type { ReactiveTarget, TypedScope } from '../../../../src/lib/reactive/types';
import { BREAK_SETTER } from '../../../../src/lib/reactive/types';

// -- Mock ReactiveTarget -----------------------------------------------------

function mockTarget(initialState: Record<string, unknown> = {}): ReactiveTarget & {
  state: Record<string, unknown>;
  reads: string[];
  writes: Array<{ key: string; value: unknown }>;
  updates: Array<{ key: string; value: unknown }>;
  deletes: string[];
} {
  const state = { ...initialState };
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const updates: Array<{ key: string; value: unknown }> = [];
  const deletes: string[] = [];

  return {
    state,
    reads,
    writes,
    updates,
    deletes,
    // Non-tracking inspection (no recorder dispatch)
    getStateKeys() {
      return Object.keys(state);
    },
    hasKey(key: string) {
      return Object.prototype.hasOwnProperty.call(state, key);
    },
    getValue(key?: string) {
      if (key === undefined) return { ...state };
      reads.push(key);
      return state[key];
    },
    setValue(key: string, value: unknown) {
      writes.push({ key, value });
      state[key] = value;
    },
    updateValue(key: string, value: unknown) {
      updates.push({ key, value });
      // Simple deep merge for testing
      const current = state[key];
      if (current && typeof current === 'object' && value && typeof value === 'object') {
        state[key] = deepMerge(current as any, value as any);
      } else {
        state[key] = value;
      }
    },
    deleteValue(key: string) {
      deletes.push(key);
      delete state[key];
    },
    getArgs: () => ({} as any),
    getEnv: () => ({} as any),
    attachRecorder: vi.fn(),
    detachRecorder: vi.fn(),
    getRecorders: vi.fn(() => []),
    addDebugInfo: vi.fn(),
    addDebugMessage: vi.fn(),
    addErrorInfo: vi.fn(),
    addMetric: vi.fn(),
    addEval: vi.fn(),
  };
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && result[k] && typeof result[k] === 'object') {
      result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// -- Unit: top-level reads ---------------------------------------------------

describe('createTypedScope -- unit: top-level reads', () => {
  it('reads a string value', () => {
    const target = mockTarget({ name: 'Alice' });
    const scope = createTypedScope<{ name: string }>(target);
    expect(scope.name).toBe('Alice');
    expect(target.reads).toEqual(['name']);
  });

  it('reads a number value', () => {
    const target = mockTarget({ score: 85 });
    const scope = createTypedScope<{ score: number }>(target);
    expect(scope.score).toBe(85);
  });

  it('reads undefined for missing key', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ missing?: string }>(target);
    expect(scope.missing).toBeUndefined();
  });

  it('reads null value', () => {
    const target = mockTarget({ data: null });
    const scope = createTypedScope<{ data: null }>(target);
    expect(scope.data).toBeNull();
  });

  it('fires onRead exactly once per top-level access', () => {
    const target = mockTarget({ x: 1, y: 2 });
    const scope = createTypedScope<{ x: number; y: number }>(target);
    expect(scope.x).toBeDefined();
    expect(scope.y).toBeDefined();
    expect(scope.x).toBeDefined(); // second read of x
    expect(target.reads).toEqual(['x', 'y', 'x']);
  });
});

// -- Unit: top-level writes --------------------------------------------------

describe('createTypedScope -- unit: top-level writes', () => {
  it('writes a value via property assignment', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ name: string }>(target);
    scope.name = 'Bob';
    expect(target.writes).toEqual([{ key: 'name', value: 'Bob' }]);
    expect(target.state.name).toBe('Bob');
  });

  it('writes multiple values', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ a: number; b: string }>(target);
    scope.a = 42;
    scope.b = 'hello';
    expect(target.writes).toHaveLength(2);
  });
});

// -- Unit: nested reads (no extra onRead) ------------------------------------

describe('createTypedScope -- unit: nested reads', () => {
  it('scope.customer.name does NOT fire extra onRead', () => {
    const target = mockTarget({
      customer: { name: 'Alice', address: { zip: '90210' } },
    });
    const scope = createTypedScope<{
      customer: { name: string; address: { zip: string } };
    }>(target);

    const name = scope.customer.name;
    expect(name).toBe('Alice');
    // Only ONE onRead for 'customer', not for 'name'
    expect(target.reads).toEqual(['customer']);
  });

  it('deep nested access fires only one onRead', () => {
    const target = mockTarget({
      a: { b: { c: { d: 'deep' } } },
    });
    const scope = createTypedScope<{ a: { b: { c: { d: string } } } }>(target);

    expect(scope.a.b.c.d).toBe('deep');
    expect(target.reads).toEqual(['a']);
  });
});

// -- Unit: nested writes (updateValue with path) -----------------------------

describe('createTypedScope -- unit: nested writes', () => {
  it('scope.customer.name = "Bob" calls updateValue', () => {
    const target = mockTarget({
      customer: { name: 'Alice', age: 30 },
    });
    const scope = createTypedScope<{
      customer: { name: string; age: number };
    }>(target);

    scope.customer.name = 'Bob';

    expect(target.updates).toEqual([{ key: 'customer', value: { name: 'Bob' } }]);
    // Verify deep merge happened
    expect(target.state.customer).toEqual({ name: 'Bob', age: 30 });
  });

  it('scope.customer.address.zip = "10001" builds correct nested patch', () => {
    const target = mockTarget({
      customer: { name: 'Alice', address: { city: 'LA', zip: '90210' } },
    });
    const scope = createTypedScope<{
      customer: { name: string; address: { city: string; zip: string } };
    }>(target);

    scope.customer.address.zip = '10001';

    expect(target.updates).toEqual([{ key: 'customer', value: { address: { zip: '10001' } } }]);
    expect((target.state.customer as any).address.zip).toBe('10001');
    expect((target.state.customer as any).address.city).toBe('LA'); // preserved
  });
});

// -- Unit: array mutations ---------------------------------------------------

describe('createTypedScope -- unit: array mutations', () => {
  it('scope.tags.push("vip") calls setValue with new array', () => {
    const target = mockTarget({ tags: ['a', 'b'] });
    const scope = createTypedScope<{ tags: string[] }>(target);

    scope.tags.push('vip');

    // push triggers setValue (not updateValue)
    expect(target.writes.length).toBeGreaterThanOrEqual(1);
    const lastWrite = target.writes[target.writes.length - 1];
    expect(lastWrite.key).toBe('tags');
    expect(lastWrite.value).toEqual(['a', 'b', 'vip']);
  });
});

// -- Unit: $-methods routing -------------------------------------------------

describe('createTypedScope -- unit: $-methods', () => {
  it('$getValue delegates to target.getValue', () => {
    const target = mockTarget({ x: 42 });
    const scope = createTypedScope<{ x: number }>(target);
    expect(scope.$getValue('x')).toBe(42);
  });

  it('$setValue delegates to target.setValue', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    scope.$setValue('key', 'value');
    expect(target.writes).toEqual([{ key: 'key', value: 'value' }]);
  });

  it('$update delegates to target.updateValue', () => {
    const target = mockTarget({ obj: { a: 1 } });
    const scope = createTypedScope(target);
    scope.$update('obj', { b: 2 });
    expect(target.updates).toEqual([{ key: 'obj', value: { b: 2 } }]);
  });

  it('$delete delegates to target.deleteValue', () => {
    const target = mockTarget({ x: 1 });
    const scope = createTypedScope(target);
    scope.$delete('x');
    expect(target.deletes).toEqual(['x']);
  });

  it('$read with dot path returns leaf value', () => {
    const target = mockTarget({
      customer: { address: { zip: '90210' } },
    });
    const scope = createTypedScope(target);
    expect(scope.$read('customer.address.zip')).toBe('90210');
    // Only one onRead for 'customer'
    expect(target.reads).toEqual(['customer']);
  });

  it('$read with simple key returns top-level value', () => {
    const target = mockTarget({ name: 'Alice' });
    const scope = createTypedScope(target);
    expect(scope.$read('name')).toBe('Alice');
  });

  it('$getArgs delegates', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(scope.$getArgs()).toEqual({});
  });

  it('$getEnv delegates', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(scope.$getEnv()).toEqual({});
  });

  it('$debug delegates to addDebugInfo', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    scope.$debug('info', { step: 1 });
    expect(target.addDebugInfo).toHaveBeenCalledWith('info', { step: 1 });
  });

  it('$log delegates to addDebugMessage', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    scope.$log('hello');
    expect(target.addDebugMessage).toHaveBeenCalledWith('hello');
  });

  it('$error delegates to addErrorInfo', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    scope.$error('err', { msg: 'fail' });
    expect(target.addErrorInfo).toHaveBeenCalledWith('err', { msg: 'fail' });
  });

  it('$metric delegates to addMetric', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    scope.$metric('latency', 42);
    expect(target.addMetric).toHaveBeenCalledWith('latency', 42);
  });

  it('$toRaw returns the underlying target', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(scope.$toRaw()).toBe(target);
  });

  it('$break calls the provided breakPipeline function', () => {
    const breakFn = vi.fn();
    const target = mockTarget({});
    const scope = createTypedScope(target, { breakPipeline: breakFn });
    scope.$break();
    expect(breakFn).toHaveBeenCalled();
  });

  it('$break throws when no breakPipeline is set', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(() => scope.$break()).toThrow('$break() is not available');
  });
});

// -- Unit: BREAK_SETTER injection --------------------------------------------

describe('createTypedScope -- unit: BREAK_SETTER', () => {
  it('StageRunner can inject breakFn via BREAK_SETTER', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target) as any;

    const breakFn = vi.fn();
    scope[BREAK_SETTER](breakFn);

    scope.$break();
    expect(breakFn).toHaveBeenCalled();
  });
});

// -- Unit: identity equality (cache) -----------------------------------------

describe('createTypedScope -- unit: identity equality', () => {
  it('scope.customer === scope.customer (cached)', () => {
    const target = mockTarget({ customer: { name: 'Alice' } });
    const scope = createTypedScope<{ customer: { name: string } }>(target);

    const a = scope.customer;
    const b = scope.customer;
    expect(a).toBe(b);
  });

  it('scope.tags === scope.tags (cached array proxy)', () => {
    const target = mockTarget({ tags: ['a', 'b'] });
    const scope = createTypedScope<{ tags: string[] }>(target);
    const a = scope.tags;
    const b = scope.tags;
    expect(a).toBe(b);
  });

  it('cache invalidated after write', () => {
    const target = mockTarget({ customer: { name: 'Alice' } });
    const scope = createTypedScope<{ customer: { name: string } }>(target);

    const before = scope.customer;
    scope.customer = { name: 'Bob' };
    const after = scope.customer;
    // After write, new proxy is created (different ref in state)
    expect(before).not.toBe(after);
  });
});

// -- Unit: guard properties --------------------------------------------------

describe('createTypedScope -- unit: guard properties', () => {
  it('then returns undefined (prevents Promise detection)', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect((scope as any).then).toBeUndefined();
  });

  it('constructor returns Object', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect((scope as any).constructor).toBe(Object);
  });

  it('Symbol.toStringTag returns "TypedScope"', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect((scope as any)[Symbol.toStringTag]).toBe('TypedScope');
  });

  it('asymmetricMatch returns undefined', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect((scope as any).asymmetricMatch).toBeUndefined();
  });
});

// -- Unit: has trap (in operator) --------------------------------------------

describe('createTypedScope -- unit: has trap', () => {
  it('"name" in scope returns true when set', () => {
    const target = mockTarget({ name: 'Alice' });
    const scope = createTypedScope<{ name: string }>(target);
    expect(Reflect.has(scope, 'name')).toBe(true);
  });

  it('"missing" in scope returns false', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(Reflect.has(scope, 'missing')).toBe(false);
  });

  it('"name" in scope does NOT fire onRead (uses hasKey)', () => {
    const target = mockTarget({ name: 'Alice' });
    const scope = createTypedScope<{ name: string }>(target);
    expect(Reflect.has(scope, 'name')).toBe(true);
    expect(target.reads).toHaveLength(0);
  });

  it('"$getValue" in scope returns true', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(Reflect.has(scope, '$getValue')).toBe(true);
  });
});

// -- Unit: ownKeys (Object.keys) ---------------------------------------------

describe('createTypedScope -- unit: ownKeys', () => {
  it('Object.keys returns state keys only (no $-methods)', () => {
    const target = mockTarget({ a: 1, b: 2, c: 3 });
    const scope = createTypedScope<{ a: number; b: number; c: number }>(target);
    expect(Object.keys(scope)).toEqual(['a', 'b', 'c']);
  });

  it('Object.keys does NOT fire onRead events', () => {
    const target = mockTarget({ a: 1, b: 2, c: 3 });
    const scope = createTypedScope<{ a: number; b: number; c: number }>(target);
    Object.keys(scope);
    expect(target.reads).toHaveLength(0); // no onRead fired for enumeration
  });

  it('destructuring works with state keys', () => {
    const target = mockTarget({ x: 10, y: 20 });
    const scope = createTypedScope<{ x: number; y: number }>(target);
    const { x, y } = scope;
    expect(x).toBe(10);
    expect(y).toBe(20);
  });
});

// -- Unit: delete trap -------------------------------------------------------

describe('createTypedScope -- unit: delete trap', () => {
  it('delete scope.key calls deleteValue', () => {
    const target = mockTarget({ temp: 'data' });
    const scope = createTypedScope<{ temp?: string }>(target);
    delete scope.temp;
    expect(target.deletes).toEqual(['temp']);
  });
});

// -- Unit: non-plain objects returned unwrapped ------------------------------

describe('createTypedScope -- unit: non-plain objects', () => {
  it('Date returned unwrapped', () => {
    const date = new Date(2026, 0, 1); // Jan 1 2026, local time
    const target = mockTarget({ created: date });
    const scope = createTypedScope<{ created: Date }>(target);
    const result = scope.created;
    expect(result).toBe(date); // same reference, not proxied
    expect(result.getFullYear()).toBe(2026); // internal slot works
  });

  it('Map returned unwrapped', () => {
    const map = new Map([['key', 'value']]);
    const target = mockTarget({ cache: map });
    const scope = createTypedScope<{ cache: Map<string, string> }>(target);
    expect(scope.cache.get('key')).toBe('value');
  });
});

// -- Boundary: edge cases ----------------------------------------------------

describe('createTypedScope -- boundary', () => {
  it('empty state object', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(Object.keys(scope)).toEqual([]);
  });

  it('10-deep nested write', () => {
    const deepObj: any = {};
    let current = deepObj;
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    for (let i = 0; i < keys.length - 1; i++) {
      current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = 'original';

    const target = mockTarget({ root: deepObj });
    const scope = createTypedScope<{ root: any }>(target);

    (scope as any).root.a.b.c.d.e.f.g.h.i.j = 'updated';

    expect(target.updates).toHaveLength(1);
    expect(target.updates[0].key).toBe('root');
  });

  it('undefined nested value does not crash', () => {
    const target = mockTarget({ obj: { nested: undefined } });
    const scope = createTypedScope<{ obj: { nested?: string } }>(target);
    expect(scope.obj.nested).toBeUndefined();
  });
});

// -- Circular references -----------------------------------------------------

describe('createTypedScope -- circular references', () => {
  it('does not stack overflow on circular read', () => {
    const alice: any = { name: 'Alice' };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice; // circular: alice -> bob -> alice

    const target = mockTarget({ alice });
    const scope = createTypedScope<{ alice: any }>(target);

    // Traverse the cycle — should NOT crash
    expect(scope.alice.name).toBe('Alice');
    expect(scope.alice.friend.name).toBe('Bob');
    expect(scope.alice.friend.friend.name).toBe('Alice'); // terminal proxy read
  });

  it('writes at cycle break point are tracked (terminal proxy set trap)', () => {
    const alice: any = { name: 'Alice' };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice;

    const target = mockTarget({ alice });
    const scope = createTypedScope<{ alice: any }>(target);

    // Write at cycle break point — terminal proxy set trap fires
    scope.alice.friend.friend.name = 'ALICE_CHANGED';

    expect(target.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = target.updates[target.updates.length - 1];
    expect(lastUpdate.key).toBe('alice');
    // The patch should contain the nested path
    expect(lastUpdate.value).toEqual({ friend: { friend: { name: 'ALICE_CHANGED' } } });
  });

  it('writes before cycle break point are tracked normally', () => {
    const alice: any = { name: 'Alice' };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice;

    const target = mockTarget({ alice });
    const scope = createTypedScope<{ alice: any }>(target);

    // Write at depth 2 (before cycle) — normal nested proxy
    scope.alice.friend.name = 'BOB_CHANGED';
    expect(target.updates).toEqual([{ key: 'alice', value: { friend: { name: 'BOB_CHANGED' } } }]);
  });

  it('deep cycle (3 nodes) does not overflow', () => {
    const a: any = { name: 'A' };
    const b: any = { name: 'B' };
    const c: any = { name: 'C' };
    a.next = b;
    b.next = c;
    c.next = a; // a -> b -> c -> a

    const target = mockTarget({ a });
    const scope = createTypedScope<{ a: any }>(target);

    expect(scope.a.name).toBe('A');
    expect(scope.a.next.name).toBe('B');
    expect(scope.a.next.next.name).toBe('C');
    expect(scope.a.next.next.next.name).toBe('A'); // terminal proxy
  });

  it('self-referencing object does not overflow', () => {
    const self: any = { name: 'Self' };
    self.me = self; // self -> self

    const target = mockTarget({ self });
    const scope = createTypedScope<{ self: any }>(target);

    expect(scope.self.name).toBe('Self');
    expect(scope.self.me.name).toBe('Self'); // terminal proxy
  });

  it('writes 2+ levels past cycle break are STILL tracked (terminal proxy chains)', () => {
    const alice: any = { name: 'Alice', address: { city: 'LA', zip: '90210' } };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice;

    const target = mockTarget({ alice });
    const scope = createTypedScope<{ alice: any }>(target);

    // 2 levels past cycle: alice.friend.friend(=alice, terminal).address.zip
    scope.alice.friend.friend.address.zip = '10001';

    expect(target.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = target.updates[target.updates.length - 1];
    expect(lastUpdate.key).toBe('alice');
    expect(lastUpdate.value).toEqual({
      friend: { friend: { address: { zip: '10001' } } },
    });
  });

  it('read after write through circular path returns correct value', () => {
    const alice: any = { name: 'Alice' };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice;

    const target = mockTarget({ alice });
    const scope = createTypedScope<{ alice: any }>(target);

    // Write at cycle break
    scope.alice.friend.name = 'BOB_CHANGED';

    // Re-read should get the updated value (cache invalidated by write)
    expect(scope.alice.friend.name).toBe('BOB_CHANGED');
  });

  it('diamond reference (non-circular) works correctly', () => {
    const shared = { value: 42 };
    const parent = { left: shared, right: shared };

    const target = mockTarget({ parent });
    const scope = createTypedScope<{ parent: any }>(target);

    // Both paths to same object should work
    expect(scope.parent.left.value).toBe(42);
    expect(scope.parent.right.value).toBe(42);

    // Write through left path
    scope.parent.left.value = 99;
    expect(target.updates[0]).toEqual({
      key: 'parent',
      value: { left: { value: 99 } },
    });
  });

  it('JSON.stringify on circular scope value does not throw', () => {
    const alice: any = { name: 'Alice' };
    const bob: any = { name: 'Bob' };
    alice.friend = bob;
    bob.friend = alice;

    const target = mockTarget({ alice });
    const scope = createTypedScope<{ alice: any }>(target);

    // Should not throw — toJSON strips object-typed keys
    expect(() => JSON.stringify(scope.alice)).not.toThrow();
    const result = JSON.parse(JSON.stringify(scope.alice));
    expect(result.name).toBe('Alice');
    // friend is stripped because it's an object (prevents circular JSON error)
    expect(result.friend).toBeUndefined();
  });
});

// -- Scenario: with mock recorder tracking -----------------------------------

describe('createTypedScope -- scenario: onRead/onWrite counts', () => {
  it('mixed reads and writes fire correct event counts', () => {
    const target = mockTarget({
      x: 1,
      y: 2,
      customer: { name: 'Alice' },
    });
    const scope = createTypedScope<{
      x: number;
      y: number;
      customer: { name: string };
    }>(target);

    // 2 reads (x, y)
    const _x = scope.x;
    const _y = scope.y;

    // 1 write
    scope.x = 10;

    // 1 read (customer) + 0 extra for .name
    const _name = scope.customer.name;

    // 1 update (nested write)
    scope.customer.name = 'Bob';

    expect(target.reads).toHaveLength(4); // x, y, customer, customer (re-read for nested write)
    expect(target.writes).toHaveLength(1); // x = 10
    expect(target.updates).toHaveLength(1); // customer.name = 'Bob'
  });
});

// -- Property: write-read roundtrip ------------------------------------------

describe('createTypedScope -- property: roundtrip', () => {
  it('any value written can be read back', () => {
    fc.assert(
      fc.property(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), (key, value) => {
        // Skip keys that conflict with proxy guards or are problematic
        if (key.startsWith('$')) return;
        if (key === '' || key === 'then' || key === 'constructor' || key === 'asymmetricMatch') return;
        if (key === 'toJSON' || key === 'length' || key === 'prototype') return;
        if (key === 'toString' || key === 'valueOf' || key === 'hasOwnProperty') return;
        if (key === '__proto__' || key === '__defineGetter__' || key === '__defineSetter__') return;
        if (typeof key !== 'string' || key.length === 0) return;

        const target = mockTarget({});
        const scope = createTypedScope(target);
        (scope as any)[key] = value;
        expect((scope as any)[key]).toEqual(value);
      }),
      { numRuns: 50 },
    );
  });
});

// -- Performance: benchmark --------------------------------------------------

describe('createTypedScope -- performance', () => {
  it('1K reads complete in under 50ms', () => {
    const target = mockTarget({ x: 42 });
    const scope = createTypedScope<{ x: number }>(target);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      expect(scope.x).toBeDefined();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('1K writes complete in under 50ms', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ x: number }>(target);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      scope.x = i;
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// -- Security: no private field access ---------------------------------------

describe('createTypedScope -- security', () => {
  it('cannot access _stageContext through proxy', () => {
    const target = mockTarget({});
    (target as any)._stageContext = { secret: 'data' };
    const scope = createTypedScope(target);
    // _stageContext is accessed via getValue which returns undefined
    expect((scope as any)._stageContext).toBeUndefined();
  });

  it('then is undefined (prevents await-based exploits)', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect((scope as any).then).toBeUndefined();
  });

  it('constructor returns Object (prevents prototype manipulation)', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect((scope as any).constructor).toBe(Object);
  });

  it('writing a reserved $-method name throws', () => {
    const target = mockTarget({});
    const scope = createTypedScope(target);
    expect(() => {
      (scope as any).$break = 'value';
    }).toThrow('conflicts with a reserved TypedScope method');
    expect(() => {
      (scope as any).$getValue = 'value';
    }).toThrow('conflicts with a reserved TypedScope method');
  });
});

// -- Proxy unwrap (regression: structuredClone fails on Proxy objects) -------

describe('createTypedScope -- proxy unwrap', () => {
  it('assigning a proxy-wrapped value to another key does not throw', () => {
    const target = mockTarget({ customer: { name: 'Alice', tier: 'premium' } });
    const scope = createTypedScope<{
      customer: { name: string; tier: string };
      backup: { name: string; tier: string };
    }>(target);

    // scope.customer returns a Proxy -- assigning it to backup should unwrap
    expect(() => {
      scope.backup = scope.customer;
    }).not.toThrow();

    // The stored value should be a plain object, not a Proxy
    const stored = target.state.backup;
    expect(stored).toEqual({ name: 'Alice', tier: 'premium' });
  });

  it('nested proxy assignment unwraps for updateValue', () => {
    const target = mockTarget({ profile: { address: { city: 'Portland', state: 'OR' } }, copy: {} });
    const scope = createTypedScope<{
      profile: { address: { city: string; state: string } };
      copy: { address?: { city: string; state: string } };
    }>(target);

    // Read nested proxy, assign to another nested path
    const address = scope.profile.address;
    expect(() => {
      scope.copy = { address };
    }).not.toThrow();
  });

  it('array proxy values are unwrapped on commit', () => {
    const target = mockTarget({ items: ['a', 'b', 'c'] });
    const scope = createTypedScope<{ items: string[]; backup: string[] }>(target);

    // Push to array -- the array proxy commits a new array value
    scope.items.push('d');

    // The stored value should be a plain array
    const stored = target.state.items;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toContain('d');
  });

  it('plain objects are not affected by unwrap', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ data: { x: number; y: string } }>(target);

    scope.data = { x: 42, y: 'hello' };
    expect(target.state.data).toEqual({ x: 42, y: 'hello' });
  });

  it('primitives pass through unwrap unchanged', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ count: number; name: string; active: boolean }>(target);

    scope.count = 42;
    scope.name = 'test';
    scope.active = true;

    expect(target.state.count).toBe(42);
    expect(target.state.name).toBe('test');
    expect(target.state.active).toBe(true);
  });

  it('null and undefined pass through unwrap unchanged', () => {
    const target = mockTarget({});
    const scope = createTypedScope<{ a: null; b: undefined }>(target);

    scope.a = null;
    scope.b = undefined;

    expect(target.state.a).toBeNull();
    expect(target.state.b).toBeUndefined();
  });
});
