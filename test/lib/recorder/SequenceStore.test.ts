/**
 * SequenceStore<T> — covers all 7 test types in one file.
 *
 * Sections:
 *   1. unit         — single-method behavior
 *   2. functional   — typical recorder-composition use case
 *   3. integration  — store + ScopeRecorder wired through executor
 *   4. property     — invariants over many random ops
 *   5. security     — no data leaks, immutable snapshots
 *   6. performance  — push / lookup latency budgets
 *   7. load         — sustained throughput
 */

import { describe, expect, it } from 'vitest';

import type { ScopeRecorder } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { SequenceStore } from '../../../src/lib/recorder/SequenceStore.js';

interface Entry {
  runtimeStageId?: string;
  v: number;
}

// ─── 1. UNIT ────────────────────────────────────────────────────────

describe('SequenceStore — unit', () => {
  it('push appends to the ordered sequence', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    s.push({ runtimeStageId: 'b', v: 2 });
    expect(s.size).toBe(2);
    expect(s.getAll().map((e) => e.v)).toEqual([1, 2]);
  });

  it('keyed lookup returns all entries for a runtimeStageId', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    s.push({ runtimeStageId: 'a', v: 2 });
    s.push({ runtimeStageId: 'b', v: 3 });
    expect(s.getByKey('a').map((e) => e.v)).toEqual([1, 2]);
    expect(s.getByKey('b').map((e) => e.v)).toEqual([3]);
  });

  it('entryRanges is maintained during push (O(1) per-step lookup)', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    s.push({ runtimeStageId: 'a', v: 2 });
    s.push({ runtimeStageId: 'b', v: 3 });
    const ranges = s.getEntryRanges();
    expect(ranges.get('a')).toEqual({ firstIdx: 0, endIdx: 2 });
    expect(ranges.get('b')).toEqual({ firstIdx: 2, endIdx: 3 });
  });

  it('aggregate reduces all entries to a single value', () => {
    const s = new SequenceStore<Entry>();
    for (let i = 1; i <= 5; i++) s.push({ runtimeStageId: 'k', v: i });
    expect(s.aggregate((sum, e) => sum + e.v, 0)).toBe(15);
  });

  it('accumulate filters by visible keys for time-travel', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    s.push({ runtimeStageId: 'b', v: 2 });
    s.push({ runtimeStageId: 'c', v: 3 });
    expect(s.accumulate((sum, e) => sum + e.v, 0, new Set(['a', 'c']))).toBe(4);
  });

  it('clear resets all internal state', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    s.clear();
    expect(s.size).toBe(0);
    expect(s.keyCount).toBe(0);
    expect(s.getEntryRanges().size).toBe(0);
  });
});

// ─── 2. FUNCTIONAL ──────────────────────────────────────────────────

describe('SequenceStore — functional', () => {
  it('typical use: composed in a recorder field', () => {
    class AuditRecorder implements ScopeRecorder {
      readonly id = 'audit';
      private readonly store = new SequenceStore<{ runtimeStageId?: string; type: 'r' | 'w'; key: string }>();

      onRead(e: any) {
        this.store.push({ runtimeStageId: e.runtimeStageId, type: 'r', key: e.key });
      }

      onWrite(e: any) {
        this.store.push({ runtimeStageId: e.runtimeStageId, type: 'w', key: e.key });
      }

      getEntries() {
        return this.store.getAll();
      }

      clear() {
        this.store.clear();
      }
    }
    const rec = new AuditRecorder();
    rec.onWrite({ runtimeStageId: 'a#0', key: 'x' });
    rec.onRead({ runtimeStageId: 'b#1', key: 'x' });
    expect(rec.getEntries()).toHaveLength(2);
  });
});

// ─── 3. INTEGRATION ─────────────────────────────────────────────────

describe('SequenceStore — integration', () => {
  it('attached recorder records scope ops during executor.run()', async () => {
    class WriteRec implements ScopeRecorder {
      readonly id = 'writes';
      readonly store = new SequenceStore<{ runtimeStageId?: string; key: string }>();
      onWrite(e: any) {
        this.store.push({ runtimeStageId: e.runtimeStageId, key: e.key });
      }

      clear() {
        this.store.clear();
      }
    }
    const chart = flowChart(
      'init',
      (scope: any) => {
        scope.x = 1;
        scope.y = 2;
      },
      'init',
    ).build();
    const rec = new WriteRec();
    const ex = new FlowChartExecutor(chart);
    ex.attachScopeRecorder(rec);
    await ex.run();
    expect(rec.store.size).toBeGreaterThan(0);
  });
});

// ─── 4. PROPERTY ────────────────────────────────────────────────────

describe('SequenceStore — property', () => {
  it.each([10, 100, 1000])('after N=%i pushes, size === N and getAll preserves order', (n) => {
    const s = new SequenceStore<Entry>();
    for (let i = 0; i < n; i++) s.push({ runtimeStageId: `k${i % 5}`, v: i });
    expect(s.size).toBe(n);
    const all = s.getAll();
    expect(all).toHaveLength(n);
    expect(all.map((e) => e.v)).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it('aggregate(sum) === sum-of-values for any push sequence', () => {
    for (let trial = 0; trial < 50; trial++) {
      const s = new SequenceStore<Entry>();
      let expected = 0;
      const n = Math.floor(Math.random() * 100) + 1;
      for (let i = 0; i < n; i++) {
        const v = Math.floor(Math.random() * 1000);
        s.push({ runtimeStageId: 'k', v });
        expected += v;
      }
      expect(s.aggregate((sum, e) => sum + e.v, 0)).toBe(expected);
    }
  });
});

// ─── 5. SECURITY ────────────────────────────────────────────────────

describe('SequenceStore — security', () => {
  it('getAll() returns a SHALLOW COPY — caller mutations do not affect store', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    const copy = s.getAll();
    copy.push({ runtimeStageId: 'evil', v: 999 });
    expect(s.size).toBe(1);
    expect(s.getAll().map((e) => e.v)).toEqual([1]);
  });

  it('getByKey() returns a copy — mutation does not affect store', () => {
    const s = new SequenceStore<Entry>();
    s.push({ runtimeStageId: 'a', v: 1 });
    const copy = s.getByKey('a');
    copy.push({ runtimeStageId: 'evil', v: 999 });
    expect(s.getByKey('a')).toHaveLength(1);
  });
});

// ─── 6. PERFORMANCE ────────────────────────────────────────────────

describe('SequenceStore — performance', () => {
  it('push: 100k operations in under 200ms', () => {
    const s = new SequenceStore<Entry>();
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) s.push({ runtimeStageId: `k${i % 1000}`, v: i });
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(ms).toBeLessThan(200);
  });

  it('getByKey: 10k lookups in under 20ms (hot cache)', () => {
    const s = new SequenceStore<Entry>();
    for (let i = 0; i < 1000; i++) s.push({ runtimeStageId: `k${i}`, v: i });
    const start = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) s.getByKey(`k${i % 1000}`);
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(ms).toBeLessThan(20);
  });
});

// ─── 7. LOAD ────────────────────────────────────────────────────────

describe('SequenceStore — load', () => {
  it('1M pushes — store remains responsive (no GC thrash)', () => {
    const s = new SequenceStore<Entry>();
    for (let i = 0; i < 1_000_000; i++) s.push({ runtimeStageId: `k${i % 100}`, v: i });
    expect(s.size).toBe(1_000_000);
    expect(s.keyCount).toBe(100);
    // O(1) lookup still works at 1M entries.
    expect(s.getByKey('k0').length).toBe(10000);
  });
});
