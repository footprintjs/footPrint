/**
 * Unit tests for KeyedRecorder base class.
 *
 * Covers: store/getByKey, getMap, values, size, clear, overwrite,
 * aggregate, accumulate, filterByKeys — 5 patterns each for new methods.
 */
import { describe, expect, it } from 'vitest';

import { KeyedRecorder } from '../../../src/lib/recorder/KeyedRecorder';

class TestRecorder extends KeyedRecorder<{ value: number }> {
  readonly id = 'test';
  add(key: string, value: number) {
    this.store(key, { value });
  }
}

describe('KeyedRecorder — storage', () => {
  it('store and getByKey', () => {
    const rec = new TestRecorder();
    rec.add('stage-a#0', 10);
    rec.add('stage-b#1', 20);

    expect(rec.getByKey('stage-a#0')).toEqual({ value: 10 });
    expect(rec.getByKey('stage-b#1')).toEqual({ value: 20 });
    expect(rec.getByKey('missing#99')).toBeUndefined();
  });

  it('getMap returns read-only insertion-ordered Map', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 1);
    rec.add('b#1', 2);
    rec.add('c#2', 3);

    const map = rec.getMap();
    expect([...map.keys()]).toEqual(['a#0', 'b#1', 'c#2']);
    expect([...map.values()]).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  it('values returns array in insertion order', () => {
    const rec = new TestRecorder();
    rec.add('x#0', 100);
    rec.add('y#1', 200);

    expect(rec.values()).toEqual([{ value: 100 }, { value: 200 }]);
  });

  it('size tracks entry count', () => {
    const rec = new TestRecorder();
    expect(rec.size).toBe(0);
    rec.add('a#0', 1);
    expect(rec.size).toBe(1);
    rec.add('b#1', 2);
    expect(rec.size).toBe(2);
  });

  it('clear resets all state', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 1);
    rec.add('b#1', 2);
    rec.clear();
    expect(rec.size).toBe(0);
    expect(rec.getByKey('a#0')).toBeUndefined();
    expect(rec.values()).toEqual([]);
  });

  it('same key overwrites previous entry', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 1);
    rec.add('a#0', 999);
    expect(rec.size).toBe(1);
    expect(rec.getByKey('a#0')).toEqual({ value: 999 });
  });
});

describe('KeyedRecorder — aggregate (reduce all)', () => {
  it('empty recorder returns initial', () => {
    const rec = new TestRecorder();
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(0);
  });

  it('single entry', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 42);
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(42);
  });

  it('multiple entries — sum', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    rec.add('b#1', 20);
    rec.add('c#2', 30);
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(60);
  });

  it('multiple entries — max', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    rec.add('b#1', 50);
    rec.add('c#2', 30);
    expect(rec.aggregate((max, e) => Math.max(max, e.value), 0)).toBe(50);
  });

  it('receives key as third argument', () => {
    const rec = new TestRecorder();
    rec.add('call-llm#5', 100);
    rec.add('execute-tools#8', 200);
    const keys: string[] = [];
    rec.aggregate((_, _e, key) => {
      keys.push(key);
      return 0;
    }, 0);
    expect(keys).toEqual(['call-llm#5', 'execute-tools#8']);
  });
});

describe('KeyedRecorder — accumulate (progressive reduce)', () => {
  it('without keys — same as aggregate', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    rec.add('b#1', 20);
    expect(rec.accumulate((sum, e) => sum + e.value, 0)).toBe(30);
  });

  it('with keys — only matching entries', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    rec.add('b#1', 20);
    rec.add('c#2', 30);
    const keys = new Set(['a#0', 'b#1']);
    expect(rec.accumulate((sum, e) => sum + e.value, 0, keys)).toBe(30);
  });

  it('empty keys — returns initial', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    expect(rec.accumulate((sum, e) => sum + e.value, 0, new Set())).toBe(0);
  });

  it('preserves insertion order during accumulation', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 1);
    rec.add('b#1', 2);
    rec.add('c#2', 3);
    const order: number[] = [];
    const keys = new Set(['a#0', 'c#2']);
    rec.accumulate(
      (_, e) => {
        order.push(e.value);
        return 0;
      },
      0,
      keys,
    );
    expect(order).toEqual([1, 3]); // a before c — insertion order
  });

  it('progressive time-travel simulation', () => {
    const rec = new TestRecorder();
    rec.add('seed#0', 0);
    rec.add('call-llm#1', 100);
    rec.add('tools#2', 50);
    rec.add('call-llm#3', 200);
    rec.add('finalize#4', 0);

    // Slider at position 1 (after first LLM call): 100 total
    const at1 = new Set(['seed#0', 'call-llm#1']);
    expect(rec.accumulate((sum, e) => sum + e.value, 0, at1)).toBe(100);

    // Slider at position 3 (after second LLM call): 350 total
    const at3 = new Set(['seed#0', 'call-llm#1', 'tools#2', 'call-llm#3']);
    expect(rec.accumulate((sum, e) => sum + e.value, 0, at3)).toBe(350);

    // Slider at end: 350 total (finalize adds 0)
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(350);
  });
});

describe('KeyedRecorder — filterByKeys (subset)', () => {
  it('empty keys — empty result', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    expect(rec.filterByKeys(new Set())).toEqual([]);
  });

  it('all keys — returns all in order', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    rec.add('b#1', 20);
    const all = new Set(['a#0', 'b#1']);
    expect(rec.filterByKeys(all)).toEqual([{ value: 10 }, { value: 20 }]);
  });

  it('subset of keys', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    rec.add('b#1', 20);
    rec.add('c#2', 30);
    expect(rec.filterByKeys(new Set(['a#0', 'c#2']))).toEqual([{ value: 10 }, { value: 30 }]);
  });

  it('missing keys ignored', () => {
    const rec = new TestRecorder();
    rec.add('a#0', 10);
    expect(rec.filterByKeys(new Set(['a#0', 'missing#99']))).toEqual([{ value: 10 }]);
  });

  it('preserves insertion order', () => {
    const rec = new TestRecorder();
    rec.add('c#2', 3);
    rec.add('a#0', 1);
    rec.add('b#1', 2);
    // Request in different order than insertion — result follows insertion order
    expect(rec.filterByKeys(new Set(['b#1', 'c#2', 'a#0']))).toEqual([{ value: 3 }, { value: 1 }, { value: 2 }]);
  });
});
