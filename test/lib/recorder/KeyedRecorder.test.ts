/**
 * Unit tests for KeyedRecorder base class.
 */
import { describe, expect, it } from 'vitest';

import { KeyedRecorder } from '../../../src/lib/recorder/KeyedRecorder';

class TestRecorder extends KeyedRecorder<{ value: number }> {
  readonly id = 'test';
  add(key: string, value: number) {
    this.store(key, { value });
  }
}

describe('KeyedRecorder', () => {
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
    expect(rec.size).toBe(2);

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
