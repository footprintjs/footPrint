/**
 * Address, path and final-field names are write selectors. The three denied
 * selectors are inert before any container is created; the same names inside
 * an assigned payload remain ordinary data. Fixtures use only local prototypes.
 */
import { describe, expect, it } from 'vitest';

import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { setNestedValue, updateNestedValue, updateValue } from '../../../../src/lib/memory/utils';

type State = Record<string, any>;
type Writer = (
  root: State,
  address: readonly string[],
  path: string[],
  field: string,
  value: unknown,
  defaults?: unknown,
) => State;

const writers: readonly [string, Writer][] = [
  ['setNestedValue', setNestedValue],
  ['updateNestedValue', updateNestedValue],
];
const denied = ['__proto__', 'constructor', 'prototype'];
const positions = ['address', 'path', 'field'] as const;

const defaultSelectors = [
  { label: 'undefined address', address: undefined, path: ['child'], expected: { child: { value: [1, 1] } } },
  { label: 'undefined path', address: ['scope'], path: undefined, expected: { scope: { value: [1, 1] } } },
  { label: 'both undefined', address: undefined, path: undefined, expected: { value: [1, 1] } },
];

describe.each(writers)('%s — JavaScript default selectors', (_name, write) => {
  it.each(defaultSelectors)('$label retains the existing empty-array default', ({ address, path, expected }) => {
    const root = {};
    // The runtime default predates the array-address contract (C2); exercise
    // the JavaScript call even though the TypeScript arguments are required.
    expect(Reflect.apply(write, undefined, [root, address, path, 'value', [1, 1]])).toBe(root);
    expect(root).toEqual(expected);
  });
});

describe.each(['setValue', 'updateValue'] as const)('SharedMemory.%s — JavaScript default selectors', (method) => {
  it.each(defaultSelectors)('$label retains the existing empty-array default', ({ address, path, expected }) => {
    const memory = new SharedMemory();
    const previous = memory.getState();
    Reflect.apply(memory[method], memory, [address, path, 'value', [1, 1]]);
    expect(memory.getState()).toEqual(expected);
    expect(memory.getState()).not.toBe(previous);
    expect(previous).toEqual({});
  });
});

function ownField(root: object, key: string, value: unknown): void {
  Object.defineProperty(root, key, { value, enumerable: true, configurable: true, writable: true });
}

function inheritedAccessor() {
  const held = { untouched: true };
  let reads = 0;
  let writes = 0;
  const prototype = {
    get field() {
      reads++;
      return held;
    },
    set field(_value: unknown) {
      writes++;
    },
  };
  return { prototype, held, counts: () => ({ reads, writes }) };
}

describe.each(writers)('%s — denied write selectors', (_name, write) => {
  it.each(denied.flatMap((key) => positions.map((position) => ({ key, position }))))(
    '$key in the $position rejects the whole write before creating a prefix',
    ({ key, position }) => {
      const prototype = { untouched: true };
      const root = Object.create(prototype);
      const globalBefore = Object.getOwnPropertyDescriptors(Object.prototype);
      const defaults = { seeded: true };
      const address = position === 'address' ? ['new-address', key, 'later'] : ['new-address'];
      const path = position === 'path' ? ['new-path', key, 'later'] : ['new-path'];
      const field = position === 'field' ? key : 'value';

      expect(write(root, address, path, field, { changed: true }, defaults)).toBe(root);

      expect(Reflect.ownKeys(root)).toEqual([]);
      expect(Object.getPrototypeOf(root)).toBe(prototype);
      expect(prototype).toEqual({ untouched: true });
      expect(defaults).toEqual({ seeded: true });
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(globalBefore);
    },
  );

  it.each(denied)('does not change an existing own %s field or traverse through it', (key) => {
    for (const position of positions) {
      const kept = { value: { before: true } };
      const root = {};
      ownField(root, key, kept);
      const descriptor = Object.getOwnPropertyDescriptor(root, key);
      const address = position === 'address' ? [key] : [];
      const path = position === 'path' ? [key] : [];
      const field = position === 'field' ? key : 'value';

      expect(write(root, address, path, field, { after: true })).toBe(root);

      expect(Object.getOwnPropertyDescriptor(root, key)).toEqual(descriptor);
      expect((root as State)[key]).toBe(kept);
      expect(kept).toEqual({ value: { before: true } });
      expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    }
  });
});

describe('updateValue — the direct leaf writer obeys the same selector rule', () => {
  it.each(denied)('does not create %s or change a target prototype', (key) => {
    const prototype = { untouched: true };
    const root = Object.create(prototype);
    const globalBefore = Object.getOwnPropertyDescriptors(Object.prototype);

    updateValue(root, key, { changed: true });

    expect(Reflect.ownKeys(root)).toEqual([]);
    expect(Object.getPrototypeOf(root)).toBe(prototype);
    expect(prototype).toEqual({ untouched: true });
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(globalBefore);
  });

  it.each(denied)('preserves an existing own %s data property', (key) => {
    const kept = { before: true };
    const root = {};
    ownField(root, key, kept);
    const descriptor = Object.getOwnPropertyDescriptor(root, key);

    updateValue(root, key, { after: true });

    expect(Object.getOwnPropertyDescriptor(root, key)).toEqual(descriptor);
    expect((root as State)[key]).toBe(kept);
    expect(kept).toEqual({ before: true });
  });
});

describe.each(['setValue', 'updateValue'] as const)(
  'SharedMemory.%s — rejected writes keep the generation',
  (method) => {
    it.each(denied.flatMap((key) => positions.map((position) => ({ key, position }))))(
      '$key in the $position leaves the current and prior state untouched',
      ({ key, position }) => {
        const memory = new SharedMemory({ defaultSeed: true }, { keep: { before: true } });
        const current = memory.getState();
        const before = structuredClone(current);
        const kept = current.keep;
        const address = position === 'address' ? ['new-address', key, 'later'] : ['new-address'];
        const path = position === 'path' ? ['new-path', key, 'later'] : ['new-path'];
        const field = position === 'field' ? key : 'value';

        memory[method](address, path, field, { changed: true });

        expect(memory.getState()).toBe(current);
        expect(current).toEqual(before);
        expect(current.keep).toBe(kept);
        expect(Object.hasOwn(current, 'new-address')).toBe(false);
        expect(Object.getPrototypeOf(current)).toBe(Object.prototype);
      },
    );
  },
);

describe.each(writers)('%s — inherited ordinary properties are not write destinations', (_name, write) => {
  it('creates its own intermediate container without changing inherited data', () => {
    const inherited = { untouched: true };
    const prototype = { branch: inherited };
    const root = Object.create(prototype);

    expect(write(root, [], ['branch'], 'value', 7)).toBe(root);

    expect(Object.hasOwn(root, 'branch')).toBe(true);
    expect(root.branch).toEqual({ value: 7 });
    expect(root.branch).not.toBe(inherited);
    expect(inherited).toEqual({ untouched: true });
    expect(Object.getPrototypeOf(root)).toBe(prototype);
  });

  it.each(['address', 'path'])('creates an own %s container without invoking an inherited accessor', (position) => {
    const fixture = inheritedAccessor();
    const root = Object.create(fixture.prototype);
    const address = position === 'address' ? ['field'] : [];
    const path = position === 'path' ? ['field'] : [];

    expect(write(root, address, path, 'value', 7)).toBe(root);

    expect(fixture.counts()).toEqual({ reads: 0, writes: 0 });
    expect(Object.getOwnPropertyDescriptor(root, 'field')).toEqual({
      value: { value: 7 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(fixture.held).toEqual({ untouched: true });
    expect(Object.getPrototypeOf(root)).toBe(fixture.prototype);
  });

  it('creates an own final field without invoking an inherited accessor', () => {
    const fixture = inheritedAccessor();
    const root = Object.create(fixture.prototype);
    const value = { after: true };

    expect(write(root, [], [], 'field', value)).toBe(root);

    expect(fixture.counts()).toEqual({ reads: 0, writes: 0 });
    expect(Object.getOwnPropertyDescriptor(root, 'field')).toEqual({
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(root.field).toBe(value);
    expect(fixture.held).toEqual({ untouched: true });
    expect(Object.getPrototypeOf(root)).toBe(fixture.prototype);
  });
});

describe('updates read only an own current value', () => {
  it.each([
    ['direct', (root: State, value: unknown) => updateValue(root, 'field', value)],
    ['nested', (root: State, value: unknown) => updateNestedValue(root, [], [], 'field', value)],
  ] as const)('%s update does not merge inherited arrays or objects', (_name, update) => {
    for (const [inherited, value] of [
      [[1, 1], [2]],
      [{ before: true }, { after: true }],
    ]) {
      const prototype = { field: inherited };
      const root = Object.create(prototype);
      const before = structuredClone(inherited);

      update(root, value);

      expect(Object.hasOwn(root, 'field')).toBe(true);
      expect(root.field).toBe(value);
      expect(inherited).toEqual(before);
      expect(Object.getPrototypeOf(root)).toBe(prototype);
    }
  });

  it('direct update does not invoke an inherited final getter or setter', () => {
    const fixture = inheritedAccessor();
    const root = Object.create(fixture.prototype);
    const value = [1, 1];

    updateValue(root, 'field', value);

    expect(fixture.counts()).toEqual({ reads: 0, writes: 0 });
    expect(Object.hasOwn(root, 'field')).toBe(true);
    expect(root.field).toBe(value);
    expect(fixture.held).toEqual({ untouched: true });
  });
});

describe.each(writers)('%s — ordinary writes retain their existing semantics', (_name, write) => {
  it('seeds only a missing address from the supplied default and retains references', () => {
    const defaults = { seeded: { kept: true } };
    const value = { after: true };
    const root: State = {};

    expect(write(root, ['scope', 'run'], ['branch'], 'value', value, defaults)).toBe(root);

    expect(root.scope.run).toBe(defaults);
    expect(root.scope.run.branch.value).toBe(value);
    expect(root.scope.run.seeded).toBe(defaults.seeded);
    const replacementDefaults = { ignored: true };
    write(root, ['scope', 'run'], [], 'other', 8, replacementDefaults);
    expect(root.scope.run).toBe(defaults);
    expect(root.scope.run.other).toBe(8);
    expect(Object.hasOwn(root.scope.run, 'ignored')).toBe(false);
    expect(replacementDefaults).toEqual({ ignored: true });
  });

  it('treats dotted and numeric-looking path segments as literal keys', () => {
    const root: State = {};

    expect(write(root, ['scope.name'], ['0', 'child.name'], 'leaf.name', 7)).toBe(root);

    expect(root).toEqual({ 'scope.name': { '0': { 'child.name': { 'leaf.name': 7 } } } });
    expect(Array.isArray(root['scope.name'])).toBe(false);
  });

  it('preserves denied-looking payload keys as own data under an allowed selector', () => {
    const payload = JSON.parse('{"__proto__":{"data":1},"constructor":{"prototype":{"data":2}},"prototype":3}');
    const root: State = {};

    expect(write(root, [], [], 'payload', payload)).toBe(root);

    expect(root.payload).toBe(payload);
    expect(Object.keys(root.payload)).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.getOwnPropertyDescriptor(root.payload, '__proto__')?.value).toEqual({ data: 1 });
    expect(root.payload.constructor).toEqual({ prototype: { data: 2 } });
    expect(Object.getPrototypeOf(root.payload)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
  });
});

describe('ordinary set and update behavior', () => {
  it('set replaces an existing value with the exact supplied reference', () => {
    const value = [1, 1];
    const root = { field: [0] };
    expect(setNestedValue(root, [], [], 'field', value)).toBe(root);
    expect(root.field).toBe(value);
  });

  it('updates concatenate arrays with duplicates and preserve element references', () => {
    const item = { id: 1 };
    const original = [item, item];
    const incoming = [item];
    const root = { field: original };
    expect(updateNestedValue(root, [], [], 'field', incoming)).toBe(root);
    expect(root.field).toEqual([item, item, item]);
    expect(root.field.every((entry) => entry === item)).toBe(true);
    expect(root.field).not.toBe(original);
    expect(original).toEqual([item, item]);
    expect(incoming).toEqual([item]);
  });

  it.each([[], {}])('an empty incoming value %j replaces an own field by reference', (value) => {
    const root = { field: { before: true } };
    updateNestedValue(root, [], [], 'field', value);
    expect(root.field).toBe(value);
  });

  it('object updates remain shallow and preserve untouched and incoming references', () => {
    const kept = { unchanged: true };
    const oldNested = { before: true };
    const incoming = { after: true };
    const original = { kept, nested: oldNested };
    const payload = { nested: incoming, ['__proto__']: { data: true } };
    const root = { field: original };

    updateNestedValue(root, [], [], 'field', payload);

    expect(root.field).not.toBe(original);
    expect(root.field.kept).toBe(kept);
    expect(root.field.nested).toBe(incoming);
    expect(original.nested).toBe(oldNested);
    expect(Object.getOwnPropertyDescriptor(root.field, '__proto__')?.value).toBe(payload.__proto__);
    expect(Object.getPrototypeOf(root.field)).toBe(Object.prototype);
  });

  it('update accepts numeric path segments and a numeric final field without inventing arrays', () => {
    const root: State = {};
    expect(updateNestedValue(root, [], [0, 'child.name'], 1, 'value')).toBe(root);
    expect(root).toEqual({ '0': { 'child.name': { '1': 'value' } } });
    expect(Array.isArray(root[0])).toBe(false);
  });
});
