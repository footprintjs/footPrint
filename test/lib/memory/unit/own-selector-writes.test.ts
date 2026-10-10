import { describe, expect, it } from 'vitest';

import { mergeContextWins, nativeGet, nativeHas, nativeSet, ownSpine } from '../../../../src/lib/memory/pathOps';

describe('selector writers — reject the whole path before changing its prefix', () => {
  for (const denied of ['__proto__', 'constructor', 'prototype']) {
    for (const suffix of [[denied], [denied, 'leaf']]) {
      it(`nativeSet leaves missing prefixes absent for ${suffix.join('.')}`, () => {
        const root = { keep: { value: 1 } };
        const before = Object.getOwnPropertyDescriptors(root);
        expect(nativeSet(root, ['fresh', 'nested', ...suffix], 2)).toBe(root);
        expect(Object.getOwnPropertyDescriptors(root)).toEqual(before);
      });

      it(`ownSpine leaves existing prefixes shared for ${suffix.join('.')}`, () => {
        let reads = 0;
        const branch = {
          nested: { value: 1 },
          get sibling() {
            reads++;
            return 3;
          },
        };
        const root = { branch };
        const owned = new WeakSet<object>([root]);
        ownSpine(root, ['branch', 'nested', ...suffix], owned);
        expect(root.branch).toBe(branch);
        expect(owned.has(branch)).toBe(false);
        expect(reads).toBe(0);
      });
    }
  }

  it('preflights dot paths before reading an existing own accessor', () => {
    let reads = 0;
    const root = {
      get branch() {
        reads++;
        return { nested: {} };
      },
    };
    nativeSet(root, 'branch.nested.constructor.leaf', 2);
    ownSpine(root, 'branch.nested.prototype', new WeakSet<object>([root]));
    expect(reads).toBe(0);
  });
});

describe('nativeSet — only own fields participate in traversal and assignment', () => {
  it.each(['branch', 'toString', 'valueOf'])('shadows inherited object %s with a fresh own container', (name) => {
    const inherited = { untouched: 1 };
    const prototype = { [name]: inherited };
    const root = Object.create(prototype);
    nativeSet(root, [name, 'leaf'], 2);
    expect(Object.getOwnPropertyDescriptor(root, name)).toEqual({
      value: { leaf: 2 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(root[name]).not.toBe(inherited);
    expect(inherited).toEqual({ untouched: 1 });
    expect(Object.getPrototypeOf(root)).toBe(prototype);
  });

  it('does not read or call an inherited intermediate accessor', () => {
    let reads = 0;
    let writes = 0;
    const inherited = { untouched: 1 };
    const prototype = {
      get branch() {
        reads++;
        return inherited;
      },
      set branch(_value: unknown) {
        writes++;
      },
    };
    const nested = Object.create(prototype);
    const root = { nested };
    nativeSet(root, ['nested', 'branch', 'leaf'], 2);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(Object.hasOwn(nested, 'branch')).toBe(true);
    expect(nested.branch).toEqual({ leaf: 2 });
    expect(inherited).toEqual({ untouched: 1 });
  });

  it('creates a final own data slot without invoking an inherited setter', () => {
    let reads = 0;
    let writes = 0;
    const prototype = {
      get leaf() {
        reads++;
        return 'inherited';
      },
      set leaf(_value: unknown) {
        writes++;
      },
    };
    const root = { branch: Object.create(prototype) };
    nativeSet(root, ['branch', 'leaf'], 2);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(Object.getOwnPropertyDescriptor(root.branch, 'leaf')).toEqual({
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });

  it('shadows an inherited non-writable data slot', () => {
    const prototype = Object.freeze({ branch: null, leaf: 1 });
    const root = Object.create(prototype);
    nativeSet(root, ['branch', 'value'], 2);
    nativeSet(root, ['leaf'], 3);
    expect(Object.keys(root)).toEqual(['branch', 'leaf']);
    expect(root.branch).toEqual({ value: 2 });
    expect(root.leaf).toBe(3);
    expect(prototype).toEqual({ branch: null, leaf: 1 });
  });

  it('preserves numeric array creation and string object-key creation', () => {
    const root: Record<string, any> = {};
    nativeSet(root, ['numeric', 0, 'value'], 1);
    nativeSet(root, ['string', '0', 'value'], 2);
    expect(root.numeric).toEqual([{ value: 1 }]);
    expect(Array.isArray(root.numeric)).toBe(true);
    expect(root.string).toEqual({ 0: { value: 2 } });
    expect(Array.isArray(root.string)).toBe(false);
  });

  it('continues to read own intermediate accessors and call own leaf setters', () => {
    let reads = 0;
    let stored = 1;
    const branch = {
      get leaf() {
        return stored;
      },
      set leaf(value: number) {
        stored = value;
      },
    };
    const root = {
      get branch() {
        reads++;
        return branch;
      },
    };
    nativeSet(root, ['branch', 'leaf'], 2);
    expect(reads).toBeGreaterThan(0);
    expect(stored).toBe(2);
    expect(Object.getOwnPropertyDescriptor(branch, 'leaf')?.set).toBeTypeOf('function');
  });

  it('preserves ordinary own data writes and replaces primitive intermediates', () => {
    const branch = { leaf: 1 };
    const root = { branch, primitive: 0 };
    nativeSet(root, 'branch.leaf', 2);
    nativeSet(root, 'primitive.leaf', 3);
    expect(root).toEqual({ branch: { leaf: 2 }, primitive: { leaf: 3 } });
    expect(root.branch).toBe(branch);
  });
});

describe('ownSpine — traverses only own intermediate fields', () => {
  it.each(['branch', 'toString', 'valueOf'])('does not copy inherited object %s into the root', (name) => {
    const inherited = { nested: { value: 1 } };
    const prototype = { [name]: inherited };
    const root = Object.create(prototype);
    const owned = new WeakSet<object>([root]);
    ownSpine(root, [name, 'nested', 'value'], owned);
    expect(Object.keys(root)).toEqual([]);
    expect(root[name]).toBe(inherited);
    expect(owned.has(inherited)).toBe(false);
    expect(inherited).toEqual({ nested: { value: 1 } });
  });

  it('stops at an inherited accessor below an owned container without invoking it', () => {
    let reads = 0;
    let writes = 0;
    const prototype = {
      get branch() {
        reads++;
        return { value: 1 };
      },
      set branch(_value: unknown) {
        writes++;
      },
    };
    const nested = Object.create(prototype);
    const root = { nested };
    ownSpine(root, ['nested', 'branch', 'value'], new WeakSet<object>([root, nested]));
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(Object.keys(nested)).toEqual([]);
    expect(root.nested).toBe(nested);
  });

  it('still copies own data containers once and preserves untouched siblings', () => {
    const original = { nested: { value: 1 }, sibling: { keep: true } };
    const root = { branch: original };
    const owned = new WeakSet<object>([root]);
    ownSpine(root, ['branch', 'nested', 'value'], owned);
    const copiedBranch = root.branch;
    expect(copiedBranch).not.toBe(original);
    expect(copiedBranch.nested).not.toBe(original.nested);
    expect(copiedBranch.sibling).toBe(original.sibling);
    expect(owned.has(copiedBranch)).toBe(true);
    expect(owned.has(copiedBranch.nested)).toBe(true);
    ownSpine(root, ['branch', 'nested', 'value'], owned);
    expect(root.branch).toBe(copiedBranch);
    nativeSet(root, ['branch', 'nested', 'value'], 2);
    expect(original.nested.value).toBe(1);
    expect(root.branch.nested.value).toBe(2);
  });

  it('retains own intermediate getter and setter behavior when replacing a copy', () => {
    const original = { value: 1 };
    let stored = original;
    let writes = 0;
    const root = {
      get branch() {
        return stored;
      },
      set branch(value: typeof original) {
        writes++;
        stored = value;
      },
    };
    const owned = new WeakSet<object>([root]);
    ownSpine(root, ['branch', 'value'], owned);
    expect(writes).toBe(1);
    expect(stored).not.toBe(original);
    expect(stored).toEqual(original);
    expect(owned.has(stored)).toBe(true);
  });
});

describe('mergeContextWins — destination precedence belongs to own data', () => {
  it('retains allowed defaults named toString and valueOf at each merged level', () => {
    const src = { toString: 'root label', valueOf: 0, nested: { toString: 'nested label', valueOf: false } };
    const result = mergeContextWins({ nested: {} }, src);
    expect(result).toEqual(src);
    expect(Object.hasOwn(result, 'toString')).toBe(true);
    expect(Object.hasOwn(result, 'valueOf')).toBe(true);
    expect(Object.hasOwn(result.nested, 'toString')).toBe(true);
    expect(Object.hasOwn(result.nested, 'valueOf')).toBe(true);
  });

  it('keeps actual own destination values and fills undefined values', () => {
    const dst = { toString: 'own', valueOf: null, nested: { toString: false, valueOf: undefined } };
    const result = mergeContextWins(dst, {
      toString: 'default',
      valueOf: 1,
      nested: { toString: 'default', valueOf: 0 },
    });
    expect(result).toEqual({ toString: 'own', valueOf: null, nested: { toString: false, valueOf: 0 } });
    expect(dst.nested.valueOf).toBeUndefined();
  });

  it('ignores inherited input accessors and source fields', () => {
    let reads = 0;
    const prototype = {
      inherited: 1,
      get field() {
        reads++;
        return { hidden: true };
      },
    };
    const src = Object.create(prototype);
    Object.defineProperty(src, 'field', { value: { visible: true }, enumerable: true });
    const result = mergeContextWins(Object.create(prototype), src);
    expect(result).toEqual({ field: { visible: true } });
    expect(Object.keys(result)).toEqual(['field']);
    expect(reads).toBe(0);
  });

  it('ignores denied source names at the root and recursively merged levels', () => {
    const defaults = { ['__proto__']: 1, constructor: 2, prototype: 3, allowed: 4 };
    const result = mergeContextWins({ nested: {} }, { ...defaults, nested: defaults });
    expect(result).toEqual({ nested: { allowed: 4 }, allowed: 4 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype);
  });
});

describe('nativeHas — own existence stays distinct from selector reads and writes', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'recognizes own %s without making it writable by selector',
    (name) => {
      const value = { leaf: undefined };
      const root = { [name]: value };
      expect(nativeHas(root, [name])).toBe(true);
      expect(nativeHas(root, [name, 'leaf'])).toBe(true);
      expect(nativeGet(root, [name], 'fallback')).toBe('fallback');
      nativeSet(root, [name, 'leaf'], 2);
      expect(root[name]).toBe(value);
      expect(value.leaf).toBeUndefined();
      expect(nativeHas(Object.create(root), [name])).toBe(false);
    },
  );
});
