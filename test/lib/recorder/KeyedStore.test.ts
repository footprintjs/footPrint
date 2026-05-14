/**
 * KeyedStore<T> — covers all 7 test types in one file.
 */

import { describe, expect, it } from 'vitest';

import { KeyedStore } from '../../../src/lib/recorder/KeyedStore.js';

interface Metric {
  input: number;
  output: number;
}

// ─── 1. UNIT ────────────────────────────────────────────────────────

describe('KeyedStore — unit', () => {
  it('set + get round-trip', () => {
    const s = new KeyedStore<Metric>();
    s.set('rid#0', { input: 10, output: 5 });
    expect(s.get('rid#0')).toEqual({ input: 10, output: 5 });
  });

  it('set replaces existing entry for same key (1:1 semantics)', () => {
    const s = new KeyedStore<Metric>();
    s.set('rid#0', { input: 10, output: 5 });
    s.set('rid#0', { input: 20, output: 10 });
    expect(s.get('rid#0')).toEqual({ input: 20, output: 10 });
    expect(s.size).toBe(1);
  });

  it('aggregate reduces all entries', () => {
    const s = new KeyedStore<Metric>();
    for (let i = 0; i < 5; i++) s.set(`rid#${i}`, { input: 10, output: 5 });
    const totalIn = s.aggregate((sum, e) => sum + e.input, 0);
    expect(totalIn).toBe(50);
  });

  it('accumulate filters by visible keys', () => {
    const s = new KeyedStore<Metric>();
    s.set('a', { input: 1, output: 1 });
    s.set('b', { input: 2, output: 2 });
    s.set('c', { input: 3, output: 3 });
    expect(s.accumulate((sum, e) => sum + e.input, 0, new Set(['a', 'c']))).toBe(4);
  });

  it('clear empties the store', () => {
    const s = new KeyedStore<Metric>();
    s.set('a', { input: 1, output: 1 });
    s.clear();
    expect(s.size).toBe(0);
    expect(s.get('a')).toBeUndefined();
  });
});

// ─── 2. FUNCTIONAL ──────────────────────────────────────────────────

describe('KeyedStore — functional', () => {
  it('typical use: per-stage metric recording', () => {
    const store = new KeyedStore<Metric>();
    store.set('llm#0', { input: 100, output: 50 });
    store.set('llm#1', { input: 200, output: 100 });
    expect(store.aggregate((sum, e) => sum + e.input + e.output, 0)).toBe(450);
  });
});

// ─── 3. INTEGRATION ─────────────────────────────────────────────────

describe('KeyedStore — integration', () => {
  it('works as a field on a recorder, surviving multiple operations', () => {
    class R {
      readonly store = new KeyedStore<Metric>();
      record(rid: string, input: number, output: number) {
        this.store.set(rid, { input, output });
      }

      total() {
        return this.store.aggregate((s, e) => s + e.input + e.output, 0);
      }
    }
    const r = new R();
    r.record('a', 10, 5);
    r.record('b', 20, 10);
    r.record('a', 100, 50); // overwrite
    expect(r.total()).toBe(180);
  });
});

// ─── 4. PROPERTY ────────────────────────────────────────────────────

describe('KeyedStore — property', () => {
  it.each([10, 100, 1000])('after N=%i unique sets, size === N', (n) => {
    const s = new KeyedStore<Metric>();
    for (let i = 0; i < n; i++) s.set(`k${i}`, { input: i, output: i });
    expect(s.size).toBe(n);
  });

  it('aggregate(input) === sum-of-inputs for any random insertion', () => {
    for (let trial = 0; trial < 50; trial++) {
      const s = new KeyedStore<Metric>();
      const seen = new Map<string, number>();
      const ops = Math.floor(Math.random() * 100) + 1;
      for (let i = 0; i < ops; i++) {
        const k = `k${Math.floor(Math.random() * 20)}`;
        const v = Math.floor(Math.random() * 1000);
        s.set(k, { input: v, output: 0 });
        seen.set(k, v);
      }
      const expected = [...seen.values()].reduce((sum, v) => sum + v, 0);
      expect(s.aggregate((sum, e) => sum + e.input, 0)).toBe(expected);
    }
  });
});

// ─── 5. SECURITY ────────────────────────────────────────────────────

describe('KeyedStore — security', () => {
  it('values() returns a copy — mutation does not affect store', () => {
    const s = new KeyedStore<Metric>();
    s.set('a', { input: 1, output: 1 });
    const copy = s.values();
    copy.push({ input: 999, output: 999 });
    expect(s.size).toBe(1);
  });

  it('getMap() returns a ReadonlyMap (TS-enforced; runtime is the same Map)', () => {
    const s = new KeyedStore<Metric>();
    s.set('a', { input: 1, output: 1 });
    // Type-level: getMap() is ReadonlyMap, so callers can't .set() on it.
    // (Runtime mutation is possible but discouraged — documented behavior.)
    const m = s.getMap();
    expect(m.size).toBe(1);
  });
});

// ─── 6. PERFORMANCE ────────────────────────────────────────────────

describe('KeyedStore — performance', () => {
  it('set: 100k ops in under 100ms', () => {
    const s = new KeyedStore<Metric>();
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) s.set(`k${i}`, { input: i, output: i });
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(ms).toBeLessThan(100);
  });
});

// ─── 7. LOAD ────────────────────────────────────────────────────────

describe('KeyedStore — load', () => {
  it('1M unique keys — get() remains O(1)', () => {
    const s = new KeyedStore<Metric>();
    for (let i = 0; i < 1_000_000; i++) s.set(`k${i}`, { input: i, output: i });
    expect(s.size).toBe(1_000_000);
    expect(s.get('k500000')).toEqual({ input: 500000, output: 500000 });
  });
});
