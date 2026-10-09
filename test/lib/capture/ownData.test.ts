import { putOwn, setOwnValue } from '../../../src/lib/capture/ownData';

/** Arrays and views are also property containers, without a string index signature. */
const slots = (target: object): Record<string, unknown> => target as Record<string, unknown>;

const dataSlot = (value: unknown) => ({ value, enumerable: true, writable: true, configurable: true });

describe.each([
  ['putOwn', putOwn],
  ['setOwnValue', setOwnValue],
] as const)('%s — own-slot compatibility', (_name, write) => {
  it.each([Object.prototype, null])('creates an ordinary data property with prototype %s', (prototype) => {
    const target = Object.create(prototype) as Record<string, unknown>;
    const value = { count: 1 };

    write(target, 'entry', value);

    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(dataSlot(value));
    expect(target.entry).toBe(value);
    expect(Object.getPrototypeOf(target)).toBe(prototype);
  });

  it('shadows an inherited accessor without reading it or invoking its setter', () => {
    let reads = 0;
    let writes = 0;
    const parent = Object.defineProperty({}, 'entry', {
      get: () => ++reads,
      set: () => ++writes,
      enumerable: false,
      configurable: false,
    });
    const inherited = Object.getOwnPropertyDescriptor(parent, 'entry');
    const target = Object.create(parent) as Record<string, unknown>;

    write(target, 'entry', 'local');

    expect([reads, writes]).toEqual([0, 0]);
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(dataSlot('local'));
    expect(Object.getOwnPropertyDescriptor(parent, 'entry')).toEqual(inherited);
    expect(Object.getPrototypeOf(target)).toBe(parent);
  });

  it('shadows an inherited nonwritable data property', () => {
    const parent = Object.defineProperty({}, 'entry', { value: 'parent', writable: false });
    const target = Object.create(parent) as Record<string, unknown>;

    write(target, 'entry', 'local');

    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(dataSlot('local'));
    expect(Object.getOwnPropertyDescriptor(parent, 'entry')?.value).toBe('parent');
  });

  it.each(['__proto__', 'constructor', 'prototype', 'hasOwnProperty'])('%s is an ordinary payload name', (key) => {
    const target: Record<string, unknown> = {};
    const prototype = Object.getPrototypeOf(target);
    const value = { label: 'payload' };

    write(target, key, value);
    expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(dataSlot(value));
    expect(Object.getPrototypeOf(target)).toBe(prototype);

    write(target, key, 'updated');
    expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(dataSlot('updated'));
    expect(Object.getPrototypeOf(target)).toBe(prototype);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('preserves existing writable data flags: enumerable=%s, configurable=%s', (enumerable, configurable) => {
    const target = Object.defineProperty({}, 'entry', {
      value: 'before',
      writable: true,
      enumerable,
      configurable,
    });

    write(slots(target), 'entry', 'after');

    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual({
      value: 'after',
      writable: true,
      enumerable,
      configurable,
    });
  });

  it('calls an existing own setter with the target as receiver and preserves its descriptor', () => {
    let reads = 0;
    const calls: Array<{ receiver: object; value: unknown }> = [];
    const target = Object.defineProperty({}, 'entry', {
      get: () => ++reads,
      set: function (this: object, value: unknown) {
        calls.push({ receiver: this, value });
      },
      enumerable: false,
      configurable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(target, 'entry');

    write(slots(target), 'entry', 'after');

    expect(reads).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].receiver).toBe(target);
    expect(calls[0].value).toBe('after');
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(descriptor);
  });

  it('keeps native setter behavior on a frozen accessor property', () => {
    const values: unknown[] = [];
    const target = Object.freeze(
      Object.defineProperty({}, 'entry', {
        get: undefined,
        set(value: unknown) {
          values.push(value);
        },
        enumerable: true,
        configurable: true,
      }),
    );
    const descriptor = Object.getOwnPropertyDescriptor(target, 'entry');

    write(slots(target), 'entry', 'after');

    expect(values).toEqual(['after']);
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(descriptor);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it('throws on an own getter-only property without invoking the getter', () => {
    let reads = 0;
    const target = Object.defineProperty({}, 'entry', { get: () => ++reads, configurable: true });
    const descriptor = Object.getOwnPropertyDescriptor(target, 'entry');

    expect(() => write(slots(target), 'entry', 'after')).toThrow(TypeError);

    expect(reads).toBe(0);
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(descriptor);
  });

  it('propagates an existing own setter error', () => {
    const error = new Error('setter rejected the value');
    const target = Object.defineProperty({}, 'entry', {
      get: undefined,
      set(_value: unknown) {
        throw error;
      },
      enumerable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(target, 'entry');

    expect(() => write(slots(target), 'entry', 'after')).toThrow(error);
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(descriptor);
  });

  it.each([false, true])('rejects an own nonwritable slot even when configurable=%s', (configurable) => {
    const target = Object.defineProperty({}, 'entry', { value: 1, writable: false, configurable });
    const descriptor = Object.getOwnPropertyDescriptor(target, 'entry');

    expect(() => write(slots(target), 'entry', 2)).toThrow(TypeError);
    expect(() => write(slots(target), 'entry', 1)).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(descriptor);
  });

  it.each([
    ['nonextensible', (target: Record<string, unknown>) => Object.preventExtensions(target)],
    ['sealed', (target: Record<string, unknown>) => Object.seal(target)],
    ['frozen', (target: Record<string, unknown>) => Object.freeze(target)],
  ] as const)('rejects missing slots on a %s target', (_kind, constrain) => {
    let writes = 0;
    const parent = Object.defineProperty({}, 'inherited', {
      get: undefined,
      set(_value: unknown) {
        writes++;
      },
      enumerable: true,
      configurable: true,
    });
    const target = constrain(Object.create(parent) as Record<string, unknown>);

    expect(() => write(target, 'missing', 1)).toThrow(TypeError);
    expect(() => write(target, 'inherited', 1)).toThrow(TypeError);
    expect(writes).toBe(0);
    expect(Object.getOwnPropertyNames(target)).toEqual([]);
    expect(Object.getPrototypeOf(target)).toBe(parent);
  });

  it('updates existing writable slots on a sealed target', () => {
    const target = Object.seal({ entry: 1 });

    write(target, 'entry', 2);

    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual({
      value: 2,
      writable: true,
      enumerable: true,
      configurable: false,
    });
    expect(Object.isSealed(target)).toBe(true);
  });

  it('rejects updates to a frozen data slot', () => {
    const target = Object.freeze({ entry: 1 });
    const descriptor = Object.getOwnPropertyDescriptor(target, 'entry');

    expect(() => write(target, 'entry', 2)).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(target, 'entry')).toEqual(descriptor);
  });

  it('fills one array hole and extends length only when an index requires it', () => {
    const target = new Array<unknown>(3);

    write(slots(target), '1', 'middle');

    expect(target.length).toBe(3);
    expect(Object.keys(target)).toEqual(['1']);
    expect(Object.getOwnPropertyDescriptor(target, '1')).toEqual(dataSlot('middle'));
    expect(Object.hasOwn(target, '0')).toBe(false);
    expect(Object.hasOwn(target, '2')).toBe(false);

    write(slots(target), '4', 'last');

    expect(target.length).toBe(5);
    expect(Object.keys(target)).toEqual(['1', '4']);
    expect(Object.hasOwn(target, '3')).toBe(false);
  });

  it('adds an array named property without changing its length or holes', () => {
    const target = new Array<unknown>(3);

    write(slots(target), 'note', 'named');

    expect(target.length).toBe(3);
    expect(Object.keys(target)).toEqual(['note']);
    expect(Object.getOwnPropertyDescriptor(target, 'note')).toEqual(dataSlot('named'));
  });

  it('uses native array length semantics and retains the length descriptor flags', () => {
    const target = ['first', 'second', 'third'];

    write(slots(target), 'length', 1);

    expect(target).toEqual(['first']);
    expect(Object.getOwnPropertyDescriptor(target, 'length')).toEqual({
      value: 1,
      writable: true,
      enumerable: false,
      configurable: false,
    });
    expect(() => write(slots(target), 'length', 1.5)).toThrow(RangeError);
    expect(target.length).toBe(1);
  });

  it('allows a hole below a nonwritable array length but rejects an extension or length write', () => {
    const target = new Array<unknown>(3);
    Object.defineProperty(target, 'length', { writable: false });

    write(slots(target), '1', 'middle');

    expect(() => write(slots(target), '3', 'past end')).toThrow(TypeError);
    expect(() => write(slots(target), 'length', 3)).toThrow(TypeError);
    expect(target.length).toBe(3);
    expect(Object.keys(target)).toEqual(['1']);
    expect(Object.getOwnPropertyDescriptor(target, '1')).toEqual(dataSlot('middle'));
    expect(Object.getOwnPropertyDescriptor(target, 'length')?.writable).toBe(false);
  });

  it('updates an existing typed-array index with native element conversion', () => {
    const target = new Uint8Array([1, 2]);
    const descriptor = Object.getOwnPropertyDescriptor(target, '1');

    write(slots(target), '1', 258);

    expect(Array.from(target)).toEqual([1, 2]);
    expect(Object.getOwnPropertyDescriptor(target, '1')).toEqual({ ...descriptor, value: 2 });
    write(slots(target), '0', 259);
    expect(Array.from(target)).toEqual([3, 2]);
  });

  it.each(['note', '01', '1.0'])('adds typed-array property %s as ordinary named data', (key) => {
    const target = new Uint8Array([1, 2]);

    write(slots(target), key, 'named');

    expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(dataSlot('named'));
    expect(Array.from(target)).toEqual([1, 2]);
    expect(target.length).toBe(2);
  });
});

describe('own-slot writers — distinct typed-array creation contracts', () => {
  it.each(['2', '-1', '-0', '1.5', 'NaN', 'Infinity'])('putOwn retains native no-op behavior for %s', (key) => {
    const target = new Uint8Array([1, 2]);

    expect(() => putOwn(slots(target), key, 9)).not.toThrow();

    expect(Object.hasOwn(target, key)).toBe(false);
    expect(Array.from(target)).toEqual([1, 2]);
    expect(Object.getOwnPropertyNames(target)).toEqual(['0', '1']);
  });

  it.each(['2', '-1', '-0', '1.5', 'NaN', 'Infinity'])('setOwnValue rejects impossible creation at %s', (key) => {
    const target = new Uint8Array([1, 2]);

    expect(() => setOwnValue(slots(target), key, 9)).toThrow(TypeError);

    expect(Object.hasOwn(target, key)).toBe(false);
    expect(Array.from(target)).toEqual([1, 2]);
    expect(Object.getOwnPropertyNames(target)).toEqual(['0', '1']);
  });

  it('setOwnValue accepts numeric keys for existing and missing ordinary slots', () => {
    const target = new Array<unknown>(2);

    setOwnValue(slots(target), 0, 'first');
    setOwnValue(slots(target), 0, 'updated');

    expect(Object.getOwnPropertyDescriptor(target, '0')).toEqual(dataSlot('updated'));
    expect(Object.hasOwn(target, '1')).toBe(false);
    expect(target.length).toBe(2);
  });
});
