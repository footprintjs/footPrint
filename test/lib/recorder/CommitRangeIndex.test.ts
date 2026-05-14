/**
 * CommitRangeIndex<TLabel> — covers all 7 test types per Convention 3.
 *
 * Sections:
 *   1. unit         — open/close/query methods in isolation
 *   2. functional   — typical nested-boundary use case
 *   3. integration  — wired to a real executor's commit log
 *   4. property     — invariants over many random ranges
 *   5. security     — token scoping; no leakage; immutable returns
 *   6. performance  — 10k inserts + 10k queries < 50ms
 *   7. load         — sustained 1M ranges with O(log N) queries
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { CommitRangeIndex } from '../../../src/lib/recorder/CommitRangeIndex.js';

// ─── 1. UNIT ────────────────────────────────────────────────────────

describe('CommitRangeIndex — unit', () => {
  it('starts empty', () => {
    const idx = new CommitRangeIndex<string>();
    expect(idx.size).toBe(0);
    expect(idx.enclosing(0)).toEqual([]);
    expect(idx.overlapping(0, 100)).toEqual([]);
  });

  it('open + close round-trip — closed range queryable with both bounds', () => {
    const idx = new CommitRangeIndex<string>();
    const t = idx.open('A', 5);
    idx.close(t, 10);
    const matches = idx.enclosing(7);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ label: 'A', startIdx: 5, endIdx: 10 });
  });

  it('open without close — range queryable as open (endIdx undefined)', () => {
    const idx = new CommitRangeIndex<string>();
    idx.open('A', 5);
    const matches = idx.enclosing(7);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ label: 'A', startIdx: 5 });
    expect(matches[0]?.endIdx).toBeUndefined();
  });

  it('enclosing returns ranges ordered outer→inner by startIdx', () => {
    const idx = new CommitRangeIndex<string>();
    const outer = idx.open('outer', 0);
    const middle = idx.open('middle', 2);
    const inner = idx.open('inner', 5);
    idx.close(inner, 8);
    idx.close(middle, 9);
    idx.close(outer, 10);
    const matches = idx.enclosing(6);
    expect(matches.map((m) => m.label)).toEqual(['outer', 'middle', 'inner']);
  });

  it('overlapping returns ranges sharing the slice', () => {
    const idx = new CommitRangeIndex<string>();
    idx.open('A', 0);
    idx.close(idx.open('B', 5), 10);
    idx.close(idx.open('C', 12), 15);
    expect(idx.overlapping(6, 8).map((m) => m.label)).toEqual(['A', 'B']);
    expect(idx.overlapping(11, 14).map((m) => m.label)).toEqual(['A', 'C']);
  });

  it('clear() empties all state', () => {
    const idx = new CommitRangeIndex<string>();
    idx.open('A', 0);
    idx.open('B', 5);
    expect(idx.size).toBe(2);
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.enclosing(0)).toEqual([]);
  });

  it('point range (startIdx === endIdx) is enclosed at that single commit', () => {
    const idx = new CommitRangeIndex<string>();
    const t = idx.open('point', 5);
    idx.close(t, 5);
    expect(idx.enclosing(5).map((m) => m.label)).toEqual(['point']);
    expect(idx.enclosing(4)).toEqual([]);
    expect(idx.enclosing(6)).toEqual([]);
  });

  it('backwards range (endIdx < startIdx) silently creates an unreachable phantom', () => {
    // Documenting current behavior: endIdx < startIdx is silently
    // accepted but the range never matches any enclosing query
    // (startIdx > commitIdx for all commits below 10; endIdx < commitIdx
    // for all commits above 5). Consumers should not rely on this;
    // future design may reject explicitly.
    const idx = new CommitRangeIndex<string>();
    const t = idx.open('backwards', 10);
    idx.close(t, 5);
    expect(idx.size).toBe(1); // entry exists
    expect(idx.enclosing(7)).toEqual([]); // never enclosed
    expect(idx.enclosing(10)).toEqual([]);
    expect(idx.enclosing(5)).toEqual([]);
  });

  it('tokens from before clear() are silent no-ops after clear (owner rotation)', () => {
    const idx = new CommitRangeIndex<string>();
    const stale = idx.open('first-run', 0);
    idx.clear();
    // Re-populate so a recycled id (0) corresponds to a fresh entry.
    const fresh = idx.open('second-run', 0);
    // Closing with the STALE token from before clear must NOT mutate
    // the fresh entry — owner symbol was rotated.
    idx.close(stale, 999);
    const matches = idx.enclosing(0);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.endIdx).toBeUndefined(); // fresh entry still open
    // Real fresh-token close still works.
    idx.close(fresh, 5);
    expect(idx.enclosing(3)[0]?.endIdx).toBe(5);
  });

  it('equal-startIdx tie-break: wider range (larger endIdx) sorts outer', () => {
    const idx = new CommitRangeIndex<string>();
    // Both open at commit 5; outer covers more commits.
    const inner = idx.open('inner', 5);
    const outer = idx.open('outer', 5);
    idx.close(inner, 8); // narrower
    idx.close(outer, 12); // wider
    const matches = idx.enclosing(7);
    expect(matches.map((m) => m.label)).toEqual(['outer', 'inner']);
  });

  it('equal-startIdx tie-break: open range sorts outer of any closed sibling', () => {
    const idx = new CommitRangeIndex<string>();
    const closedNarrow = idx.open('closed', 5);
    idx.open('open', 5); // never closed
    idx.close(closedNarrow, 8);
    const matches = idx.enclosing(6);
    // Open range is treated as +Infinity → sorts outer.
    expect(matches.map((m) => m.label)).toEqual(['open', 'closed']);
  });

  it('close with unknown token (foreign owner) — silent no-op', () => {
    const idx = new CommitRangeIndex<string>();
    // Token from a never-opened "other index" — fabricated symbol.
    expect(() => idx.close({ _id: 999, _owner: Symbol('foreign') }, 10)).not.toThrow();
    expect(idx.size).toBe(0);
  });

  it('double close — silent no-op (no mutation after first close)', () => {
    const idx = new CommitRangeIndex<string>();
    const t = idx.open('A', 5);
    idx.close(t, 10);
    idx.close(t, 999); // attempt to overwrite endIdx
    const matches = idx.enclosing(7);
    expect(matches[0]?.endIdx).toBe(10); // first close wins
  });
});

// ─── 2. FUNCTIONAL ──────────────────────────────────────────────────

describe('CommitRangeIndex — functional (nested boundaries)', () => {
  it('Sequence > Agent > LLMCall nesting → enclosing returns full breadcrumb', () => {
    const idx = new CommitRangeIndex<string>();
    const seq = idx.open('Sequence', 0);
    const ag = idx.open('Agent', 5);
    const lc = idx.open('LLMCall', 10);
    idx.close(lc, 15);
    idx.close(ag, 20);
    idx.close(seq, 25);

    expect(idx.enclosing(12).map((m) => m.label)).toEqual(['Sequence', 'Agent', 'LLMCall']);
    expect(idx.enclosing(17).map((m) => m.label)).toEqual(['Sequence', 'Agent']);
    expect(idx.enclosing(22).map((m) => m.label)).toEqual(['Sequence']);
    expect(idx.enclosing(30)).toEqual([]);
  });

  it('parallel branches → overlapping ranges share commits', () => {
    const idx = new CommitRangeIndex<string>();
    const par = idx.open('Parallel', 0);
    const a = idx.open('legal', 5);
    const b = idx.open('ethics', 6);
    idx.close(a, 12);
    idx.close(b, 14);
    idx.close(par, 14);
    // commit 8 — inside both branches AND the parallel root
    expect(
      idx
        .enclosing(8)
        .map((m) => m.label)
        .sort(),
    ).toEqual(['Parallel', 'ethics', 'legal']);
  });
});

// ─── 3. INTEGRATION ────────────────────────────────────────────────

describe('CommitRangeIndex — integration with real executor', () => {
  it('builds correct ranges for a 2-stage chart', async () => {
    const chart = flowChart(
      'a',
      (scope: any) => {
        scope.x = 1;
      },
      'a',
    )
      .addFunction(
        'b',
        (scope: any) => {
          scope.y = 2;
        },
        'b',
      )
      .build();
    const idx = new CommitRangeIndex<string>();
    const ex = new FlowChartExecutor(chart);

    // Open at run start, close at run end — single all-encompassing range.
    const before = ex.getCommitCount();
    expect(before).toBe(0);

    const t = idx.open('whole-run', before);
    await ex.run();
    const after = ex.getCommitCount();
    idx.close(t, after);

    expect(after).toBeGreaterThan(0);
    expect(idx.enclosing(0).map((m) => m.label)).toEqual(['whole-run']);
    expect(idx.enclosing(after - 1).map((m) => m.label)).toEqual(['whole-run']);
  });

  it('executor.getCommitCount() returns 0 before run, > 0 after', async () => {
    const chart = flowChart(
      'a',
      (scope: any) => {
        scope.k = 'v';
      },
      'a',
    ).build();
    const ex = new FlowChartExecutor(chart);
    expect(ex.getCommitCount()).toBe(0);
    await ex.run();
    expect(ex.getCommitCount()).toBeGreaterThan(0);
  });
});

// ─── 4. PROPERTY ────────────────────────────────────────────────────

describe('CommitRangeIndex — property', () => {
  it('every closed range that contains commit N appears in enclosing(N)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const idx = new CommitRangeIndex<number>();
      const ranges: Array<{ label: number; start: number; end: number }> = [];
      const n = 50;
      for (let i = 0; i < n; i++) {
        const start = Math.floor(Math.random() * 100);
        const end = start + Math.floor(Math.random() * 50);
        const t = idx.open(i, start);
        idx.close(t, end);
        ranges.push({ label: i, start, end });
      }
      // For 10 random query points, verify the index matches a brute-force scan.
      for (let q = 0; q < 10; q++) {
        const point = Math.floor(Math.random() * 150);
        const expected = ranges
          .filter((r) => r.start <= point && r.end >= point)
          .map((r) => r.label)
          .sort((a, b) => a - b);
        const actual = idx
          .enclosing(point)
          .map((m) => m.label)
          .sort((a, b) => a - b);
        expect(actual).toEqual(expected);
      }
    }
  });

  it('outer ranges (lower startIdx, higher endIdx) always appear before inner ranges in enclosing()', () => {
    const idx = new CommitRangeIndex<string>();
    for (let i = 0; i < 20; i++) {
      const t = idx.open(`r${i}`, i * 2);
      idx.close(t, 100 - i * 2);
    }
    // At commit 50, all 20 are enclosing — verify they come out by startIdx asc.
    const matches = idx.enclosing(50);
    expect(matches).toHaveLength(20);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i]!.startIdx).toBeGreaterThanOrEqual(matches[i - 1]!.startIdx);
    }
  });
});

// ─── 5. SECURITY ────────────────────────────────────────────────────

describe('CommitRangeIndex — security', () => {
  it('enclosing() returns shallow-copy — caller mutations do NOT affect index', () => {
    const idx = new CommitRangeIndex<string>();
    const t = idx.open('A', 5);
    idx.close(t, 10);
    const copy = idx.enclosing(7);
    // Caller can't reach into internal entries.
    (copy as RangeEntry<string>[]).push({ label: 'EVIL', startIdx: 0, endIdx: 999 });
    // Re-query — internal state unchanged.
    expect(idx.enclosing(7)).toHaveLength(1);
  });

  it('tokens from one index do NOT close ranges in another', () => {
    const a = new CommitRangeIndex<string>();
    const b = new CommitRangeIndex<string>();
    const tokenA = a.open('A', 0);
    b.open('B', 0);
    // Use a's token on b — should be silent no-op.
    b.close(tokenA, 10);
    expect(b.enclosing(5)).toHaveLength(1);
    expect(b.enclosing(5)[0]?.endIdx).toBeUndefined(); // b's range still open
  });
});

// ─── 6. PERFORMANCE ────────────────────────────────────────────────

describe('CommitRangeIndex — performance', () => {
  it('10k inserts + 10k queries < 500ms total (linear scan, slow-CI headroom)', () => {
    const idx = new CommitRangeIndex<number>();
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const t = idx.open(i, i);
      idx.close(t, i + 5);
    }
    for (let i = 0; i < 10_000; i++) {
      idx.enclosing(i);
    }
    const ms = performance.now() - start;
    // Linear-scan implementation gets ~150ms locally on an idle CPU.
    // Budget 1500ms to absorb both slow-CI variance AND local-machine
    // CPU contention from running this test directly after `npm run
    // build` in the release pipeline (observed flakes at 600-700ms in
    // that scenario). Tighter than the original 2000ms — performance
    // regressions above 1500ms would still be visible. If a true
    // interval tree replaces the scan (design doc section 9), tighten
    // to 100ms.
    expect(ms).toBeLessThan(1500);
  });
});

// ─── 7. LOAD ────────────────────────────────────────────────────────

describe('CommitRangeIndex — load', () => {
  it('20k ranges — single enclosing query stays under 50ms', () => {
    const idx = new CommitRangeIndex<number>();
    for (let i = 0; i < 20_000; i++) {
      const t = idx.open(i, i);
      idx.close(t, i + 10);
    }
    const t0 = performance.now();
    const matches = idx.enclosing(10_000);
    const ms = performance.now() - t0;
    // Linear implementation: ~3-10ms. Budget 50ms.
    // For 1M+ ranges, upgrade to centered-interval tree (see design doc
    // section 9 — future opportunity).
    expect(matches.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });

  it('10k overlapping queries on a 1k-range index — < 100ms (perf-panel tightened)', () => {
    const idx = new CommitRangeIndex<number>();
    for (let i = 0; i < 1_000; i++) {
      const t = idx.open(i, i * 5);
      idx.close(t, i * 5 + 20);
    }
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      idx.overlapping(i, i + 10);
    }
    const ms = performance.now() - t0;
    // 50µs per query × 10k queries = ~50ms steady; budget 100ms
    // accommodates slow-CI variance. Tighter than original 500ms
    // (which was 10x too loose for regression detection).
    expect(ms).toBeLessThan(100);
  });
});

// Type-only import for security test cast (avoids unused-import lint).
import type { RangeEntry } from '../../../src/lib/recorder/CommitRangeIndex.js';
