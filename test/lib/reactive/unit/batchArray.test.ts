/**
 * Tests for TypedScope.$batchArray — batch array mutation with a single clone+write.
 *
 * Covers:
 * - unit: correct clone, correct single-commit, correct getValue call count
 * - boundary: empty array, missing key, non-array key, zero mutations
 * - scenario: realistic batch-push, mixed mutations inside fn
 * - property: result === applying same mutations to a plain array
 * - performance: write count is O(1) regardless of mutation count inside fn
 */
import { describe, expect, it, vi } from 'vitest';

import { createTypedScope } from '../../../../src/lib/reactive/createTypedScope';
import type { ReactiveTarget, TypedScope } from '../../../../src/lib/reactive/types';

interface SomeState {
  items: string[];
  scores: number[];
  name: string;
}

function makeMockTarget(initial: Record<string, unknown> = {}): ReactiveTarget & {
  state: Record<string, unknown>;
  reads: string[];
  writes: Array<{ key: string; value: unknown }>;
} {
  const state = { ...initial };
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];

  return {
    state,
    reads,
    writes,
    getStateKeys: () => Object.keys(state),
    hasKey: (key) => Object.prototype.hasOwnProperty.call(state, key),
    getValue(key?: string) {
      if (key !== undefined) reads.push(key);
      return key === undefined ? { ...state } : state[key];
    },
    setValue(key, value) {
      writes.push({ key, value });
      state[key] = value;
    },
    updateValue(key, value) {
      state[key] = value;
    },
    deleteValue(key) {
      delete state[key];
    },
    getArgs: () => ({} as any),
    getEnv: () => ({} as any),
    attachRecorder: () => {},
    detachRecorder: () => {},
    getRecorders: () => [],
    addDebugInfo: () => {},
    addDebugMessage: () => {},
    addErrorInfo: () => {},
    addMetric: () => {},
    addEval: () => {},
  };
}

function makeScope(initial: Record<string, unknown> = {}) {
  const target = makeMockTarget(initial);
  const scope = createTypedScope<SomeState>(target);
  return { scope, target };
}

// -- Unit --------------------------------------------------------------------

describe('$batchArray — unit: single getValue + single setValue', () => {
  it('calls getValue exactly once for the key', () => {
    const { scope, target } = makeScope({ items: ['a', 'b'] });
    scope.$batchArray('items', (arr) => {
      arr.push('c');
      arr.push('d');
    });
    expect(target.reads.filter((r) => r === 'items')).toHaveLength(1);
  });

  it('calls setValue exactly once regardless of mutation count inside fn', () => {
    const { scope, target } = makeScope({ items: [] });
    scope.$batchArray('items', (arr) => {
      for (let i = 0; i < 100; i++) arr.push(i);
    });
    expect(target.writes.filter((w) => w.key === 'items')).toHaveLength(1);
  });

  it('committed value contains all mutations from fn', () => {
    const { scope, target } = makeScope({ items: ['x'] });
    scope.$batchArray('items', (arr) => {
      arr.push('y');
      arr.push('z');
    });
    expect(target.state.items).toEqual(['x', 'y', 'z']);
  });

  it('fn receives a plain mutable array (not a Proxy)', () => {
    const { scope } = makeScope({ items: ['a'] });
    let receivedType = '';
    scope.$batchArray('items', (arr) => {
      receivedType = Object.prototype.toString.call(arr);
    });
    expect(receivedType).toBe('[object Array]');
  });

  it('mutations inside fn do NOT fire individual writes (only final commit)', () => {
    const { scope, target } = makeScope({ items: [] });
    let writesDuringFn = 0;
    scope.$batchArray('items', (arr) => {
      const before = target.writes.length;
      arr.push('a');
      arr.push('b');
      writesDuringFn = target.writes.length - before;
    });
    expect(writesDuringFn).toBe(0);
    expect(target.writes).toHaveLength(1); // only the final commit
  });
});

// -- Boundary ----------------------------------------------------------------

describe('$batchArray — boundary: edge cases', () => {
  it('works when key does not exist — fn receives empty array, result committed', () => {
    const { scope, target } = makeScope({});
    scope.$batchArray('items', (arr) => {
      arr.push('first');
    });
    expect(target.state.items).toEqual(['first']);
  });

  it('works when existing value is not an array — treats it as empty array', () => {
    const { scope, target } = makeScope({ items: 'not-an-array' as any });
    scope.$batchArray('items', (arr) => {
      arr.push('a');
    });
    expect(target.state.items).toEqual(['a']);
  });

  it('zero mutations inside fn — commits unmodified clone', () => {
    const { scope, target } = makeScope({ items: ['a', 'b'] });
    scope.$batchArray('items', () => {
      // no mutations
    });
    expect(target.state.items).toEqual(['a', 'b']);
    expect(target.writes).toHaveLength(1); // still commits once
  });

  it('empty initial array — fn can push freely', () => {
    const { scope, target } = makeScope({ items: [] });
    scope.$batchArray('items', (arr) => {
      arr.push(1, 2, 3);
    });
    expect(target.state.items).toEqual([1, 2, 3]);
  });

  it('does not mutate the original array in state before fn runs', () => {
    const original = ['a', 'b'];
    const { scope, target } = makeScope({ items: original });
    scope.$batchArray('items', (arr) => {
      arr.push('c');
    });
    // The target state was the original reference; batchArray clones so original is untouched
    expect(original).toEqual(['a', 'b']);
  });
});

// -- Scenario ----------------------------------------------------------------

describe('$batchArray — scenario: realistic use cases', () => {
  it('batch-populates message history (LLM use case)', () => {
    const { scope, target } = makeScope({ items: ['user: hello'] });
    const newMessages = ['assistant: hi', 'user: how are you?', 'assistant: good!'];

    scope.$batchArray('items', (arr) => {
      for (const msg of newMessages) arr.push(msg);
    });

    expect(target.state.items).toEqual(['user: hello', ...newMessages]);
    expect(target.writes).toHaveLength(1);
  });

  it('mixed mutations: push, sort, filter inside fn', () => {
    const { scope, target } = makeScope({ scores: [3, 1, 4, 1, 5] });

    scope.$batchArray('scores', (arr) => {
      arr.push(9, 2, 6);
      arr.sort((a, b) => (a as number) - (b as number));
    });

    expect(target.state.scores).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    expect(target.writes).toHaveLength(1);
  });

  it('can call $batchArray multiple times — each is independent', () => {
    const { scope, target } = makeScope({ items: [] });

    scope.$batchArray('items', (arr) => arr.push('a', 'b'));
    scope.$batchArray('items', (arr) => arr.push('c', 'd'));

    expect(target.state.items).toEqual(['a', 'b', 'c', 'd']);
    expect(target.writes).toHaveLength(2); // one per call
  });

  it('does not affect other keys in state', () => {
    const { scope, target } = makeScope({ items: ['x'], name: 'Alice' });

    scope.$batchArray('items', (arr) => arr.push('y'));

    expect(target.state.name).toBe('Alice');
    expect(target.writes.every((w) => w.key === 'items')).toBe(true);
  });
});

// -- Property ----------------------------------------------------------------

describe('$batchArray — property: result equals plain array mutation', () => {
  it('for N pushes, result matches [...initial, ...pushed]', () => {
    const items = ['a', 'b', 'c'];
    const toAdd = ['d', 'e', 'f', 'g', 'h'];

    const { scope, target } = makeScope({ items: [...items] });
    scope.$batchArray('items', (arr) => {
      for (const x of toAdd) arr.push(x);
    });

    expect(target.state.items).toEqual([...items, ...toAdd]);
  });

  it('sort inside fn produces correctly sorted result', () => {
    const unsorted = [5, 2, 8, 1, 9, 3];
    const { scope, target } = makeScope({ scores: [...unsorted] });

    scope.$batchArray('scores', (arr) => {
      (arr as number[]).sort((a, b) => a - b);
    });

    expect(target.state.scores).toEqual([...unsorted].sort((a, b) => a - b));
  });
});

// -- Performance -------------------------------------------------------------

describe('$batchArray — performance: write count is O(1) not O(N)', () => {
  it('1000 pushes produce exactly 1 write', () => {
    const { scope, target } = makeScope({ items: [] });

    scope.$batchArray('items', (arr) => {
      for (let i = 0; i < 1000; i++) arr.push(i);
    });

    const itemWrites = target.writes.filter((w) => w.key === 'items');
    expect(itemWrites).toHaveLength(1);
    expect((target.state.items as number[]).length).toBe(1000);
  });

  it('write count does not grow with array size', () => {
    const large = Array.from({ length: 10_000 }, (_, i) => i);
    const { scope, target } = makeScope({ items: large });

    scope.$batchArray('items', (arr) => {
      arr.push(10_001);
      arr.push(10_002);
    });

    expect(target.writes).toHaveLength(1);
  });
});
