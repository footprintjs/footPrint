/**
 * BoundaryStateStore<T> — covers all 7 test types in one file.
 */

import { describe, expect, it } from 'vitest';

import { BoundaryStateStore } from '../../../src/lib/recorder/BoundaryStateStore.js';

interface State {
  partial: string;
  tokens: number;
}

// ─── 1. UNIT ────────────────────────────────────────────────────────

describe('BoundaryStateStore — unit', () => {
  it('start + stop round-trip', () => {
    const s = new BoundaryStateStore<State>();
    s.start('rid#0', { partial: '', tokens: 0 });
    expect(s.get('rid#0')).toEqual({ partial: '', tokens: 0 });
    s.stop('rid#0');
    expect(s.get('rid#0')).toBeUndefined();
  });

  it('update mutates the active boundary state via pure updater', () => {
    const s = new BoundaryStateStore<State>();
    s.start('rid#0', { partial: '', tokens: 0 });
    s.update('rid#0', (prev) => ({ partial: prev.partial + 'a', tokens: prev.tokens + 1 }));
    s.update('rid#0', (prev) => ({ partial: prev.partial + 'b', tokens: prev.tokens + 1 }));
    expect(s.get('rid#0')).toEqual({ partial: 'ab', tokens: 2 });
  });

  it('update is a no-op when no boundary is active for the key', () => {
    const s = new BoundaryStateStore<State>();
    s.update('nonexistent', (prev) => ({ partial: prev.partial + 'x', tokens: 999 }));
    expect(s.get('nonexistent')).toBeUndefined();
  });

  it('stop returns the final state', () => {
    const s = new BoundaryStateStore<State>();
    s.start('rid#0', { partial: 'final', tokens: 10 });
    expect(s.stop('rid#0')).toEqual({ partial: 'final', tokens: 10 });
    expect(s.stop('rid#0')).toBeUndefined();
  });

  it('hasActive + activeCount track the live set', () => {
    const s = new BoundaryStateStore<State>();
    expect(s.hasActive).toBe(false);
    s.start('a', { partial: '', tokens: 0 });
    s.start('b', { partial: '', tokens: 0 });
    expect(s.activeCount).toBe(2);
    expect(s.hasActive).toBe(true);
    s.stop('a');
    expect(s.activeCount).toBe(1);
  });
});

// ─── 2. FUNCTIONAL ──────────────────────────────────────────────────

describe('BoundaryStateStore — functional', () => {
  it('typical use: track a streaming LLM call', () => {
    const store = new BoundaryStateStore<State>();
    store.start('llm#0', { partial: '', tokens: 0 });
    for (const chunk of ['hello', ' ', 'world']) {
      store.update('llm#0', (prev) => ({ partial: prev.partial + chunk, tokens: prev.tokens + 1 }));
    }
    expect(store.get('llm#0')?.partial).toBe('hello world');
    store.stop('llm#0');
    expect(store.hasActive).toBe(false);
  });
});

// ─── 3. INTEGRATION ─────────────────────────────────────────────────

describe('BoundaryStateStore — integration', () => {
  it('two concurrent boundaries — independent state', () => {
    const s = new BoundaryStateStore<State>();
    s.start('a', { partial: 'A:', tokens: 0 });
    s.start('b', { partial: 'B:', tokens: 0 });
    s.update('a', (p) => ({ ...p, partial: p.partial + '1', tokens: p.tokens + 1 }));
    s.update('b', (p) => ({ ...p, partial: p.partial + '2', tokens: p.tokens + 1 }));
    expect(s.get('a')).toEqual({ partial: 'A:1', tokens: 1 });
    expect(s.get('b')).toEqual({ partial: 'B:2', tokens: 1 });
    s.stop('a');
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toEqual({ partial: 'B:2', tokens: 1 });
  });
});

// ─── 4. PROPERTY ────────────────────────────────────────────────────

describe('BoundaryStateStore — property', () => {
  it('after balanced start/stop pairs, hasActive === false', () => {
    for (let trial = 0; trial < 50; trial++) {
      const s = new BoundaryStateStore<State>();
      const n = Math.floor(Math.random() * 100) + 1;
      const keys: string[] = [];
      for (let i = 0; i < n; i++) {
        const k = `k${i}`;
        s.start(k, { partial: '', tokens: 0 });
        keys.push(k);
      }
      // Random order stop
      keys.sort(() => Math.random() - 0.5);
      for (const k of keys) s.stop(k);
      expect(s.hasActive).toBe(false);
    }
  });
});

// ─── 5. SECURITY ────────────────────────────────────────────────────

describe('BoundaryStateStore — security', () => {
  it('clear empties active boundaries even with leaks', () => {
    const s = new BoundaryStateStore<State>();
    s.start('a', { partial: 'sensitive', tokens: 0 });
    s.start('b', { partial: 'data', tokens: 0 });
    s.clear();
    expect(s.activeCount).toBe(0);
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toBeUndefined();
  });
});

// ─── 6. PERFORMANCE ────────────────────────────────────────────────

describe('BoundaryStateStore — performance', () => {
  it('start + update + stop: 100k cycles in under 200ms', () => {
    const s = new BoundaryStateStore<State>();
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) {
      const k = `k${i}`;
      s.start(k, { partial: '', tokens: 0 });
      s.update(k, (p) => ({ ...p, tokens: p.tokens + 1 }));
      s.stop(k);
    }
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(ms).toBeLessThan(300);
  });
});

// ─── 7. LOAD ────────────────────────────────────────────────────────

describe('BoundaryStateStore — load', () => {
  it('10k concurrent active boundaries — get / update remain fast', () => {
    const s = new BoundaryStateStore<State>();
    for (let i = 0; i < 10_000; i++) s.start(`k${i}`, { partial: '', tokens: 0 });
    expect(s.activeCount).toBe(10_000);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) {
      s.update(`k${i}`, (p) => ({ ...p, tokens: p.tokens + 1 }));
    }
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(ms).toBeLessThan(50);
  });
});
