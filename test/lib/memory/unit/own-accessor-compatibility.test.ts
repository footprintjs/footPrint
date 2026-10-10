import { describe, expect, it } from 'vitest';

import { nativeSet } from '../../../../src/lib/memory/pathOps';

describe('nativeSet — existing own accessor compatibility', () => {
  it.each([
    { label: 'object', initial: { leaf: 1 }, reads: 3, writes: 0 },
    { label: 'null', initial: null, reads: 2, writes: 1 },
    { label: 'undefined', initial: undefined, reads: 2, writes: 1 },
    { label: 'primitive', initial: 0, reads: 3, writes: 1 },
  ])('retains observable getter and setter calls for an own $label intermediate', (fixture) => {
    let stored: unknown = fixture.initial;
    let reads = 0;
    let writes = 0;
    const root = {
      get branch() {
        reads++;
        return stored;
      },
      set branch(value: unknown) {
        writes++;
        stored = value;
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(root, 'branch');

    expect(nativeSet(root, ['branch', 'leaf'], 2)).toBe(root);

    expect(reads).toBe(fixture.reads);
    expect(writes).toBe(fixture.writes);
    expect(stored).toEqual({ leaf: 2 });
    expect(Object.getOwnPropertyDescriptor(root, 'branch')).toEqual(descriptor);
  });

  it('retains the destination selected by successive own getter results', () => {
    const first = { leaf: 1 };
    const second = { leaf: 2 };
    const destination = { leaf: 3 };
    const values = [first, second, destination];
    let reads = 0;
    const root = {
      get branch() {
        return values[reads++];
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(root, 'branch');

    nativeSet(root, ['branch', 'leaf'], 4);

    expect(reads).toBe(3);
    expect(first).toEqual({ leaf: 1 });
    expect(second).toEqual({ leaf: 2 });
    expect(destination).toEqual({ leaf: 4 });
    expect(Object.getOwnPropertyDescriptor(root, 'branch')).toEqual(descriptor);
  });
});
