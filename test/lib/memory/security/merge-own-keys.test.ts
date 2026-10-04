/**
 * A merge preserves own data keys, including `__proto__`, without invoking
 * inherited accessors. Path-segment refusal is a separate rule in pathOps.
 * The CI counterexample was a merge of { a: { ['__proto__']: [] } } into {}.
 */
import { isDeepStrictEqual } from 'node:util';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { commitValueAt } from '../../../../src/lib/memory/commitLogUtils';
import { deepSmartMerge } from '../../../../src/lib/memory/merge';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import type { CommitBundle, TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, applySmartMergeInto, dryFold, nextGeneration } from '../../../../src/lib/memory/utils';
import { stateAt } from '../../../../src/trace';

function expectDataKey(object: object, key: string, value: unknown, frozen = false): void {
  expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(object, key)).toEqual({
    value,
    enumerable: true,
    writable: !frozen,
    configurable: !frozen,
  });
}

describe('merge — own keys are data, never prototype instructions', () => {
  it.each([{}, [], [1], null, 0, false, 'text', undefined])('preserves an own __proto__ value: %j', (value) => {
    const src = { ['__proto__']: value, after: true };
    const result = deepSmartMerge({}, src);
    expectDataKey(result, '__proto__', value);
    expect(Object.keys(result)).toEqual(['__proto__', 'after']);
    expectDataKey(src, '__proto__', value);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('merges an existing own special key and nested keys without mutating frozen inputs', () => {
    const dst = Object.freeze({ ['__proto__']: Object.freeze({ before: 1 }), retained: true });
    const src = Object.freeze({
      ['__proto__']: Object.freeze({ after: 2 }),
      nested: Object.freeze({ ['__proto__']: Object.freeze({ value: 3 }) }),
      constructor: Object.freeze({ prototype: Object.freeze({ data: 4 }) }),
      prototype: Object.freeze({ data: 5 }),
    });
    const result = deepSmartMerge(dst, src);
    expectDataKey(result, '__proto__', { before: 1, after: 2 });
    expectDataKey(result.nested, '__proto__', { value: 3 });
    expectDataKey(result, 'constructor', { prototype: { data: 4 } });
    expectDataKey(result, 'prototype', { data: 5 });
    expect(Object.keys(result)).toEqual(['__proto__', 'retained', 'nested', 'constructor', 'prototype']);
    expect(dst.__proto__).toEqual({ before: 1 });
    expect(src.__proto__).toEqual({ after: 2 });
  });

  it('does not inherit data or invoke accessors from either input prototype', () => {
    let reads = 0;
    let writes = 0;
    const prototype = {
      inherited: { hidden: true },
      get field() {
        reads++;
        return { hidden: true };
      },
      set field(_value: unknown) {
        writes++;
      },
    };
    const dst = Object.create(prototype);
    const src = Object.create(prototype);
    Object.defineProperty(src, 'field', { value: { visible: true }, enumerable: true });
    const result = deepSmartMerge(dst, src);
    expectDataKey(result, 'field', { visible: true });
    expect(Object.keys(result)).toEqual(['field']);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it('preserves a cycle through an own __proto__ data key', () => {
    const src: Record<string, unknown> = { ['__proto__']: undefined };
    src.__proto__ = src;
    Object.freeze(src);
    const result = deepSmartMerge({}, src);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__).toBe(result);
    expect(src.__proto__).toBe(src);
  });

  it('never reads or invokes a setter inherited by the fresh merge output', () => {
    const key = 'footprintMergeOwnKeysAccessor';
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let reads = 0;
    let writes = 0;
    try {
      // Unlike a custom input prototype, this is inherited by the fresh
      // ordinary output too. Restore it synchronously even if an assertion fails.
      // eslint-disable-next-line no-extend-native -- intentional inherited-accessor fixture; restored in finally
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          reads++;
          return { hidden: true };
        },
        set(_value: unknown) {
          writes++;
        },
      });
      const result = deepSmartMerge({}, { [key]: { visible: true } });
      expectDataKey(result, key, { visible: true });
      expect(reads).toBe(0);
      expect(writes).toBe(0);
    } finally {
      // eslint-disable-next-line no-extend-native -- restore the descriptor this fixture replaced, if any
      if (previous) Object.defineProperty(Object.prototype, key, previous);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it('still merges shared source nodes against each destination and unions arrays by identity', () => {
    const item = { id: 1 };
    const shared = { ['__proto__']: { list: [item] } };
    const result = deepSmartMerge(
      { left: { ['__proto__']: { keep: 'left', list: [item] } }, right: { ['__proto__']: { keep: 'right' } } },
      { left: shared, right: shared },
    );
    expectDataKey(result.left, '__proto__', { keep: 'left', list: [item] });
    expectDataKey(result.right, '__proto__', { keep: 'right', list: [item] });
    expect(result.left).not.toBe(result.right);
    expect(result.left.__proto__.list[0]).toBe(item);
    expectDataKey(deepSmartMerge(result.left, { ['__proto__']: { list: [] } }), '__proto__', {
      keep: 'left',
      list: [],
    });
  });

  it('preserves generated JSON payloads under a special data key with no input edits', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const src = { ['__proto__']: value };
        const before = structuredClone(src);
        const result = deepSmartMerge({}, src);
        expectDataKey(result, '__proto__', value);
        expect(isDeepStrictEqual(result, before)).toBe(true);
        expect(isDeepStrictEqual(src, before)).toBe(true);
      }),
      { numRuns: 300, seed: 20261004 },
    );
  });
});

describe('merge — the CI counterexample through every replay discipline', () => {
  const trace: TraceEntry[] = [{ path: 'a', verb: 'merge' }];
  const replays = { applySmartMerge, applySmartMergeInto, nextGeneration, dryFold };
  for (const [name, replay] of Object.entries(replays)) {
    it(`${name} keeps the own key and ordinary prototype; repeated folds agree on Node 20 and 22`, () => {
      const base = Object.freeze({});
      const updates = { a: { ['__proto__']: [] } };
      const expected = structuredClone(updates);
      // The Into door owns (and edits) its root; the other doors copy it.
      const result = replay(name === 'applySmartMergeInto' ? structuredClone(base) : base, updates, {}, trace);
      expectDataKey(result.a, '__proto__', []);
      expect(isDeepStrictEqual(result, expected)).toBe(true);
      expect(isDeepStrictEqual(result, replay({}, structuredClone(updates), {}, trace))).toBe(true);
      expect(isDeepStrictEqual(updates, expected)).toBe(true);
      expect(Object.keys(base)).toEqual([]);
    });
  }

  it('agrees in a staged read, admitted record, live memory and historical readers', () => {
    const updates = JSON.parse('{"a":{"__proto__":[]}}');
    const buffer = new TransactionBuffer({});
    buffer.merge(['a'], updates.a);
    expectDataKey(buffer.get(['a']) as object, '__proto__', []);
    const patch = buffer.commit();
    const bundle: CommitBundle = {
      idx: 0,
      stage: 'Merge',
      stageId: 'merge',
      runtimeStageId: 'merge#0',
      redactedPaths: [],
      ...patch,
    };
    const memory = new SharedMemory(undefined, {});
    memory.applyPatch(patch.overwrite, patch.updates, patch.trace);
    expectDataKey(memory.getState().a as object, '__proto__', []);
    expectDataKey(commitValueAt([bundle], 0, 'a') as object, '__proto__', []);
    expectDataKey(stateAt({ commitLog: [bundle] }, 0).state.a as object, '__proto__', [], true);
  });
});
