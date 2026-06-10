/**
 * ring.test.ts — RFC-001 Block 2 acceptance (BoundedRing + overflow policies).
 *
 * Convention 3 sections: unit / functional / property / security / load.
 * Acceptance (RFC table):
 *   - size ≤ capacity under ANY random push/drain sequence (property)
 *   - conservation: pushes === delivered + drops + rejections + size
 *   - per-policy behavior ('drop-oldest' / 'sample' / 'block')
 *   - seq-gap detectability under drop-oldest (drops leave visible holes)
 */

import fc from 'fast-check';

import { type OverflowPolicy, BoundedRing } from '../../../src/lib/observer-queue/ring';

function conservationHolds<T>(ring: BoundedRing<T>): boolean {
  const c = ring.getCounters();
  return c.pushes === c.delivered + c.drops + c.rejections + ring.size;
}

describe('BoundedRing — unit', () => {
  it('is FIFO below capacity', () => {
    const ring = new BoundedRing<number>({ capacity: 4, policy: 'drop-oldest' });
    expect(ring.push(1)).toEqual({ accepted: true });
    ring.push(2);
    ring.push(3);
    expect(ring.size).toBe(3);
    expect(ring.shift()).toBe(1);
    expect(ring.shift()).toBe(2);
    expect(ring.shift()).toBe(3);
    expect(ring.shift()).toBeUndefined();
    expect(ring.size).toBe(0);
  });

  it('wraps around the circular buffer correctly', () => {
    const ring = new BoundedRing<number>({ capacity: 3, policy: 'drop-oldest' });
    for (let i = 0; i < 10; i++) {
      ring.push(i);
      if (i % 2 === 0) ring.shift();
    }
    const out: number[] = [];
    let v = ring.shift();
    while (v !== undefined) {
      out.push(v);
      v = ring.shift();
    }
    // Survivors drain in push order.
    expect(out).toEqual([...out].sort((a, b) => a - b));
    expect(conservationHolds(ring)).toBe(true);
  });

  it('validates capacity and sampleEvery', () => {
    expect(() => new BoundedRing({ capacity: 0, policy: 'block' })).toThrow(RangeError);
    expect(() => new BoundedRing({ capacity: 2.5, policy: 'block' })).toThrow(RangeError);
    expect(() => new BoundedRing({ capacity: 4, policy: 'sample', sampleEvery: 0 })).toThrow(RangeError);
  });

  it("'drop-oldest': evicts the oldest, returns it, counts the loss", () => {
    const ring = new BoundedRing<number>({ capacity: 2, policy: 'drop-oldest' });
    ring.push(1);
    ring.push(2);
    expect(ring.push(3)).toEqual({ accepted: true, evicted: 1 });
    expect(ring.getCounters().drops).toBe(1);
    expect(ring.shift()).toBe(2);
    expect(ring.shift()).toBe(3);
  });

  it("'block': refuses at capacity, drops NOTHING (rejections counted separately)", () => {
    const ring = new BoundedRing<number>({ capacity: 2, policy: 'block' });
    ring.push(1);
    ring.push(2);
    expect(ring.push(3)).toEqual({ accepted: false });
    const c = ring.getCounters();
    expect(c.rejections).toBe(1);
    expect(c.drops).toBe(0);
    expect(ring.shift()).toBe(1); // queued content untouched
  });

  it("'sample': admits 1 in sampleEvery saturated arrivals, evicting the oldest", () => {
    const ring = new BoundedRing<number>({ capacity: 2, policy: 'sample', sampleEvery: 3 });
    ring.push(0);
    ring.push(1);
    expect(ring.push(2)).toEqual({ accepted: false }); // saturated arrival 1 — sampled out
    expect(ring.push(3)).toEqual({ accepted: false }); // saturated arrival 2 — sampled out
    expect(ring.push(4)).toEqual({ accepted: true, evicted: 0 }); // arrival 3 — admitted
    expect(ring.push(5)).toEqual({ accepted: false }); // arrival 4 (1 of next window)
    const c = ring.getCounters();
    // Losses: arrivals 2, 3, 5 sampled out + eviction of 0 = 4 drops.
    expect(c.drops).toBe(4);
    expect(c.rejections).toBe(0);
    expect([ring.shift(), ring.shift()]).toEqual([1, 4]);
  });

  it("'sample': the saturation counter is episode-scoped (resets after drain)", () => {
    const ring = new BoundedRing<number>({ capacity: 1, policy: 'sample', sampleEvery: 2 });
    ring.push(0);
    expect(ring.push(1).accepted).toBe(false); // saturated arrival 1
    ring.shift(); // episode ends
    expect(ring.push(2).accepted).toBe(true); // non-full path resets the counter
    expect(ring.push(3).accepted).toBe(false); // fresh episode, arrival 1 again
    expect(ring.push(4).accepted).toBe(true); // arrival 2 — admitted
  });
});

describe('BoundedRing — functional', () => {
  it('sustains interleaved producer/consumer traffic with honest accounting', () => {
    const ring = new BoundedRing<number>({ capacity: 8, policy: 'drop-oldest' });
    const drained: number[] = [];
    for (let i = 0; i < 100; i++) {
      ring.push(i);
      if (i % 3 === 0) {
        const v = ring.shift();
        if (v !== undefined) drained.push(v);
      }
    }
    let v = ring.shift();
    while (v !== undefined) {
      drained.push(v);
      v = ring.shift();
    }
    // Order preserved, gaps = drops.
    expect(drained).toEqual([...drained].sort((a, b) => a - b));
    expect(100 - drained.length).toBe(ring.getCounters().drops);
    expect(conservationHolds(ring)).toBe(true);
  });
});

describe('BoundedRing — property', () => {
  const policies: OverflowPolicy[] = ['block', 'drop-oldest', 'sample'];

  it('size ≤ capacity and conservation hold for ANY push/drain sequence', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.constantFrom(...policies),
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 400 }),
        (capacity, policy, sampleEvery, ops) => {
          const ring = new BoundedRing<number>({ capacity, policy, sampleEvery });
          let seq = 0;
          for (const isPush of ops) {
            if (isPush) ring.push(seq++);
            else ring.shift();
            expect(ring.size).toBeLessThanOrEqual(capacity);
            expect(conservationHolds(ring)).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('drained items always come out in push order (every policy)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.constantFrom(...policies),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 300 }),
        (capacity, policy, ops) => {
          const ring = new BoundedRing<number>({ capacity, policy });
          const drained: number[] = [];
          let seq = 0;
          for (const isPush of ops) {
            if (isPush) ring.push(seq++);
            else {
              const v = ring.shift();
              if (v !== undefined) drained.push(v);
            }
          }
          let v = ring.shift();
          while (v !== undefined) {
            drained.push(v);
            v = ring.shift();
          }
          for (let i = 1; i < drained.length; i++) expect(drained[i]).toBeGreaterThan(drained[i - 1]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('drop-oldest: seq gaps in the drained stream equal the drop counter (gap detectability)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 200 }), (capacity, pushes) => {
        const ring = new BoundedRing<number>({ capacity, policy: 'drop-oldest' });
        for (let seq = 0; seq < pushes; seq++) ring.push(seq);
        const drained: number[] = [];
        let v = ring.shift();
        while (v !== undefined) {
          drained.push(v);
          v = ring.shift();
        }
        // Holes in [0, pushes) not present in the drained stream == drops.
        const missing = pushes - drained.length;
        expect(missing).toBe(ring.getCounters().drops);
        // And the survivors are exactly the most recent window.
        expect(drained).toEqual(Array.from({ length: drained.length }, (_, i) => pushes - drained.length + i));
      }),
      { numRuns: 150 },
    );
  });
});

describe('BoundedRing — security', () => {
  it('shift() releases the stored reference (no retention of delivered payloads)', () => {
    const ring = new BoundedRing<{ secret: string }>({ capacity: 2, policy: 'drop-oldest' });
    ring.push({ secret: 'a' });
    ring.shift();
    // Reach into the private buffer to assert the slot was cleared.
    const buffer = (ring as unknown as { buffer: unknown[] }).buffer;
    expect(buffer.every((slot) => slot === undefined)).toBe(true);
  });

  it('eviction clears the evicted slot too', () => {
    const ring = new BoundedRing<number>({ capacity: 1, policy: 'drop-oldest' });
    ring.push(1);
    ring.push(2);
    ring.shift();
    const buffer = (ring as unknown as { buffer: unknown[] }).buffer;
    expect(buffer.every((slot) => slot === undefined)).toBe(true);
  });
});

describe('BoundedRing — load', () => {
  it('sustains 200k mixed ops with conservation intact', () => {
    const ring = new BoundedRing<number>({ capacity: 1_000, policy: 'drop-oldest' });
    const start = Date.now();
    for (let i = 0; i < 200_000; i++) {
      ring.push(i);
      if (i % 2 === 0) ring.shift();
    }
    expect(conservationHolds(ring)).toBe(true);
    // Generous budget — regression detection, not absolute perf.
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
