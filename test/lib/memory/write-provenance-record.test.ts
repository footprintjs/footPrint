/**
 * Record-owned provenance: stamping, default byte shape, delta aggregation, temporal prefixes and cost.
 * writeProvenance.test.ts retains the executor-option, read-dial, subflow and redaction witnesses.
 */
import { describe, expect, it } from 'vitest';

import { TransactionBuffer } from '../../../src/lib/memory/TransactionBuffer.js';

describe('TransactionBuffer readKeys stamping — unit', () => {
  it('stamps the provider value per op; different writes capture different prefixes', () => {
    const reads: string[] = [];
    const buf = new TransactionBuffer({}, 'full', () => [...reads]);
    buf.set(['x'], 1);
    reads.push('a');
    buf.set(['y'], 2);
    reads.push('b');
    buf.merge(['z'], { n: 1 });
    const { trace } = buf.commit();
    expect(trace.find((t) => t.path === 'x')!.readKeys).toEqual([]);
    expect(trace.find((t) => t.path === 'y')!.readKeys).toEqual(['a']);
    expect(trace.find((t) => t.path === 'z')!.readKeys).toEqual(['a', 'b']);
  });

  it('NO provider (default) → readKeys absent on every entry — byte parity', () => {
    const buf = new TransactionBuffer({}, 'full');
    buf.set(['x'], 1);
    buf.merge(['z'], { n: 1 });
    const { trace } = buf.commit();
    expect(trace.every((t) => !Object.prototype.hasOwnProperty.call(t, 'readKeys'))).toBe(true);
  });

  it('delta mode: one entry per path carries the LAST write prefix (the union)', () => {
    const reads: string[] = [];
    const buf = new TransactionBuffer({}, 'delta', () => [...reads]);
    buf.set(['arr'], ['m0']);
    reads.push('a');
    buf.set(['arr'], ['m0', 'm1']); // second write of same path, later prefix
    const { trace } = buf.commit();
    const arrEntries = trace.filter((t) => t.path === 'arr');
    expect(arrEntries).toHaveLength(1); // delta dedup: one entry per path
    expect(arrEntries[0].readKeys).toEqual(['a']); // LAST prefix, not the first
  });
});

describe('writeProvenance — property (temporal prefix is monotone and exact)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('every staged write records exactly the reads that preceded it (30 random interleavings)', () => {
    for (let run = 0; run < 30; run++) {
      const rand = mulberry32(7 + run);
      const reads: string[] = [];
      const seen = new Set<string>();
      const buf = new TransactionBuffer({}, 'full', () => [...reads]);
      const expected: Array<{ path: string; prefix: string[] }> = [];
      let w = 0;
      for (let i = 0; i < 20; i++) {
        if (rand() < 0.5) {
          const k = `r${Math.floor(rand() * 6)}`;
          if (!seen.has(k)) {
            seen.add(k);
            reads.push(k);
          } // registry = insertion-ordered set
        } else {
          const path = `w${w++}`;
          expected.push({ path, prefix: [...reads] });
          buf.set([path], i);
        }
      }
      const { trace } = buf.commit();
      for (const { path, prefix } of expected) {
        expect(trace.find((t) => t.path === path)!.readKeys).toEqual(prefix);
      }
      // Monotonicity: prefixes never shrink across write order.
      for (let i = 1; i < expected.length; i++) {
        expect(expected[i].prefix.length).toBeGreaterThanOrEqual(expected[i - 1].prefix.length);
      }
    }
  });
});

describe('writeProvenance — record stamping cost', () => {
  it('perf: 2000 stamped writes with a 50-key prefix under 250ms', () => {
    const reads = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const buf = new TransactionBuffer({}, 'full', () => [...reads]);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) buf.set([`w${i}`], i);
    buf.commit();
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
