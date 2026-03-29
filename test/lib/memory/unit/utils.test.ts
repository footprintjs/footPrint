/**
 * Coverage tests for src/lib/memory/utils.ts
 * Covers: redactPatch, updateValue, deepSmartMerge
 */

import { deepSmartMerge, DELIM, redactPatch, updateValue } from '../../../../src/lib/memory/utils';

// ---------------------------------------------------------------------------
// redactPatch
// ---------------------------------------------------------------------------

describe('redactPatch', () => {
  it('redacts an existing defined value', () => {
    const patch = { user: { name: 'Alice', ssn: '123-45-6789' }, score: 99 };
    const redacted = redactPatch(patch, new Set([`user${DELIM}ssn`]));
    expect(redacted.user.ssn).toBe('REDACTED');
    expect(redacted.user.name).toBe('Alice');
    expect(redacted.score).toBe(99);
  });

  it('skips redaction when path does not exist in patch', () => {
    const patch = { foo: 1 };
    const redacted = redactPatch(patch, new Set([`bar${DELIM}baz`]));
    expect(redacted).toEqual({ foo: 1 });
    expect(redacted).not.toHaveProperty('bar');
  });

  it('does not redact when value at path is undefined', () => {
    const patch = { chat: { token: undefined } };
    const redacted = redactPatch(patch, new Set([`chat${DELIM}token`]));
    expect(redacted.chat.token).toBeUndefined();
  });

  it('redacts nested paths correctly', () => {
    const patch = { a: { b: { c: 'secret' } } };
    const redacted = redactPatch(patch, new Set([`a${DELIM}b${DELIM}c`]));
    expect(redacted.a.b.c).toBe('REDACTED');
  });
});

// ---------------------------------------------------------------------------
// updateValue — 5-pattern tests
// ---------------------------------------------------------------------------

describe('updateValue', () => {
  // Pattern 1: unit — primitive values
  describe('primitives', () => {
    it('assigns a string value directly', () => {
      const obj: any = {};
      updateValue(obj, 'name', 'Alice');
      expect(obj.name).toBe('Alice');
    });

    it('assigns a number value directly', () => {
      const obj: any = { score: 10 };
      updateValue(obj, 'score', 99);
      expect(obj.score).toBe(99);
    });

    it('assigns null directly (replaces existing)', () => {
      const obj: any = { x: 'hello' };
      updateValue(obj, 'x', null);
      expect(obj.x).toBeNull();
    });

    it('assigns false directly', () => {
      const obj: any = { flag: true };
      updateValue(obj, 'flag', false);
      expect(obj.flag).toBe(false);
    });

    it('assigns 0 directly', () => {
      const obj: any = { count: 5 };
      updateValue(obj, 'count', 0);
      expect(obj.count).toBe(0);
    });
  });

  // Pattern 2: boundary — empty array clears the field
  describe('empty array — boundary: should replace (clear), not no-op', () => {
    it('replaces an existing array with [] when the new value is []', () => {
      const obj: any = { tags: ['vip', 'premium'] };
      updateValue(obj, 'tags', []);
      expect(obj.tags).toEqual([]);
    });

    it('sets a new key to [] when the field is undefined', () => {
      const obj: any = {};
      updateValue(obj, 'tags', []);
      expect(obj.tags).toEqual([]);
    });

    it('does NOT append [] to existing array (was a silent no-op before fix)', () => {
      const obj: any = { items: [1, 2, 3] };
      updateValue(obj, 'items', []);
      // The field must be cleared, not preserved
      expect(obj.items).toEqual([]);
      expect(obj.items).not.toEqual([1, 2, 3]);
    });
  });

  // Pattern 3: scenario — non-empty array concatenates
  describe('non-empty array — concatenation', () => {
    it('concatenates when existing array is defined', () => {
      const obj: any = { tags: ['a'] };
      updateValue(obj, 'tags', ['b', 'c']);
      expect(obj.tags).toEqual(['a', 'b', 'c']);
    });

    it('sets array directly when the field is undefined', () => {
      const obj: any = {};
      updateValue(obj, 'tags', ['x', 'y']);
      expect(obj.tags).toEqual(['x', 'y']);
    });
  });

  // Pattern 4: scenario — object shallow merge
  describe('non-empty object — shallow merge', () => {
    it('shallow-merges onto existing object', () => {
      const obj: any = { profile: { name: 'Alice', age: 30 } };
      updateValue(obj, 'profile', { age: 31, city: 'NY' });
      expect(obj.profile).toEqual({ name: 'Alice', age: 31, city: 'NY' });
    });

    it('sets object directly when field is undefined', () => {
      const obj: any = {};
      updateValue(obj, 'info', { x: 1 });
      expect(obj.info).toEqual({ x: 1 });
    });
  });

  // Pattern 5: property — empty object hits primitive assign (replaces)
  describe('empty object — property: treated as primitive (direct assign)', () => {
    it('assigns empty object directly (does not crash or no-op)', () => {
      const obj: any = { data: { a: 1 } };
      updateValue(obj, 'data', {});
      expect(obj.data).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// deepSmartMerge — 5-pattern tests
// ---------------------------------------------------------------------------

describe('deepSmartMerge', () => {
  // Pattern 1: unit — primitives
  it('src primitive wins over dst', () => {
    expect(deepSmartMerge('old', 'new')).toBe('new');
    expect(deepSmartMerge(1, 2)).toBe(2);
    expect(deepSmartMerge({ x: 1 }, null)).toBeNull();
  });

  // Pattern 2: boundary — empty src array replaces dst
  it('empty src array [] replaces dst array (the fix)', () => {
    expect(deepSmartMerge(['a', 'b'], [])).toEqual([]);
  });

  it('empty src array [] replaces non-array dst', () => {
    expect(deepSmartMerge('something', [])).toEqual([]);
  });

  // Pattern 3: scenario — non-empty arrays union
  it('non-empty src array unions with dst array (deduplicates)', () => {
    expect(deepSmartMerge(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('non-empty src array used as-is when dst is not an array', () => {
    expect(deepSmartMerge(undefined, ['x'])).toEqual(['x']);
  });

  // Pattern 4: scenario — objects recursive merge
  it('recursively merges nested objects', () => {
    const dst = { a: { x: 1, y: 2 }, b: 10 };
    const src = { a: { y: 99, z: 3 }, c: 20 };
    expect(deepSmartMerge(dst, src)).toEqual({ a: { x: 1, y: 99, z: 3 }, b: 10, c: 20 });
  });

  // Pattern 5: property — clearing nested arrays via deepSmartMerge (TypedScope path)
  it('clearing a nested array via object merge sets the array to [] (scope.customer.tags = [])', () => {
    const dst = { name: 'Alice', tags: ['vip', 'premium'] };
    const src = { tags: [] }; // represents buildNestedPatch result for scope.customer.tags = []
    const result = deepSmartMerge(dst, src);
    expect(result.tags).toEqual([]);
    expect(result.name).toBe('Alice');
  });
});
