/**
 * flushDriver.test.ts — RFC-001 Block 4 acceptance (armed-once batcher + budget).
 *
 * Convention 3 sections: unit / functional / property.
 * Acceptance (RFC table + A1): N pushes ⇒ 1 flush; re-arms; listener-emitted
 * events land NEXT flush (snapshot semantics); budget stops the flush and
 * re-arms (injected now() clock — no real sleeps); Infinity drains fully.
 */

import fc from 'fast-check';

import { type FlushDriverOptions, FlushDriver } from '../../../src/lib/observer-queue/flushDriver';

/** Deterministic harness: array-backed queue + captured-callback scheduler. */
function makeHarness(opts?: Partial<FlushDriverOptions> & { onProcess?: (item: number) => void }) {
  const queue: number[] = [];
  const processed: number[] = [];
  const scheduled: Array<() => void> = [];
  const driver = new FlushDriver({
    depth: () => queue.length,
    processNext: () => {
      const item = queue.shift();
      if (item === undefined) throw new Error('processNext called on empty queue');
      processed.push(item);
      opts?.onProcess?.(item);
    },
    schedule: (cb) => scheduled.push(cb),
    flushBudgetMs: opts?.flushBudgetMs,
    now: opts?.now,
    onFlushStart: opts?.onFlushStart,
    onFlushEnd: opts?.onFlushEnd,
  });
  /** Run pending checkpoints to quiescence (bounded — fails loud on spin). */
  const pump = (maxCheckpoints = 1_000): number => {
    let ran = 0;
    while (scheduled.length > 0) {
      if (ran >= maxCheckpoints) throw new Error('pump exceeded maxCheckpoints — runaway re-arm');
      const cb = scheduled.shift() as () => void;
      cb();
      ran += 1;
    }
    return ran;
  };
  return { queue, processed, scheduled, driver, pump };
}

/** Fake clock: every now() call advances time by `stepMs`. */
function fakeClock(stepMs = 1) {
  const clock = { t: 0 };
  return {
    clock,
    now: () => {
      const v = clock.t;
      clock.t += stepMs;
      return v;
    },
  };
}

describe('FlushDriver — unit', () => {
  it('arm() is idempotent — N arms schedule exactly ONE pending flush', () => {
    const h = makeHarness();
    h.queue.push(1, 2, 3);
    h.driver.arm();
    h.driver.arm();
    h.driver.arm();
    expect(h.scheduled).toHaveLength(1);
    expect(h.driver.getStats().armed).toBe(true);
  });

  it('N pushes ⇒ 1 flush draining the whole batch (within budget)', () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) {
      h.queue.push(i);
      h.driver.arm(); // producer arms on every enqueue
    }
    expect(h.pump()).toBe(1);
    expect(h.processed).toEqual([0, 1, 2, 3, 4]);
    expect(h.driver.getStats().flushes).toBe(1);
    expect(h.driver.getStats().armed).toBe(false);
  });

  it('validates flushBudgetMs (0, negative, NaN rejected; Infinity allowed)', () => {
    const opts = { depth: () => 0, processNext: () => undefined };
    expect(() => new FlushDriver({ ...opts, flushBudgetMs: 0 })).toThrow(RangeError);
    expect(() => new FlushDriver({ ...opts, flushBudgetMs: -1 })).toThrow(RangeError);
    expect(() => new FlushDriver({ ...opts, flushBudgetMs: Number.NaN })).toThrow(RangeError);
    expect(() => new FlushDriver({ ...opts, flushBudgetMs: Infinity })).not.toThrow();
  });

  it('a zero-work wakeup (queue already drained) does not count as a flush', () => {
    const h = makeHarness();
    h.queue.push(1);
    h.driver.arm();
    h.driver.flushSync(); // drains before the scheduled checkpoint runs
    expect(h.driver.getStats().flushes).toBe(1); // the sync drain
    h.pump(); // the armed microtask finds an empty queue
    expect(h.driver.getStats().flushes).toBe(1);
  });
});

describe('FlushDriver — functional (snapshot + budget + re-arm)', () => {
  it('events enqueued BY the consumer during a flush land at the NEXT checkpoint', () => {
    const flushBatches: number[][] = [];
    let batch: number[] = [];
    const h = makeHarness({
      onProcess: (item) => {
        batch.push(item);
        if (item < 100) {
          // a listener emitting during delivery — exceeds the snapshot
          h.queue.push(item + 100);
          h.driver.arm();
        }
      },
      onFlushEnd: () => {
        flushBatches.push(batch);
        batch = [];
      },
    });
    h.queue.push(1, 2, 3);
    h.driver.arm();
    h.pump();
    // First flush drains EXACTLY the snapshot (1,2,3); cascades go next.
    expect(flushBatches[0]).toEqual([1, 2, 3]);
    expect(flushBatches[1]).toEqual([101, 102, 103]);
    expect(h.queue).toHaveLength(0);
  });

  it('budget exhaustion stops the flush, counts it, re-arms, and finishes later (fake clock)', () => {
    const { now } = fakeClock(1); // each now() call advances 1ms
    const outcomes: Array<{ processed: number; budgetExhausted: boolean }> = [];
    const h = makeHarness({
      flushBudgetMs: 2,
      now,
      onFlushEnd: (o) => outcomes.push({ processed: o.processed, budgetExhausted: o.budgetExhausted }),
    });
    h.queue.push(0, 1, 2, 3, 4);
    h.driver.arm();
    const checkpoints = h.pump();
    // Budget 2ms with a 1ms-per-check clock ⇒ 2 items per flush.
    expect(h.processed).toEqual([0, 1, 2, 3, 4]);
    expect(checkpoints).toBe(3);
    expect(outcomes.map((o) => o.processed)).toEqual([2, 2, 1]);
    expect(outcomes.map((o) => o.budgetExhausted)).toEqual([true, true, false]);
    expect(h.driver.getStats().budgetExhausted).toBe(2);
    expect(h.driver.getStats().flushes).toBe(3);
  });

  it('guarantees progress: at least one item per flush even under a tiny budget', () => {
    const { now } = fakeClock(10); // clock jumps 10ms per call — budget always "exhausted"
    const h = makeHarness({ flushBudgetMs: 0.5, now });
    h.queue.push(0, 1, 2);
    h.driver.arm();
    expect(h.pump()).toBe(3); // one item per checkpoint
    expect(h.processed).toEqual([0, 1, 2]);
  });

  it('flushBudgetMs: Infinity drains the full snapshot in one flush regardless of clock', () => {
    const { now } = fakeClock(1_000); // pathologically slow clock
    const h = makeHarness({ flushBudgetMs: Infinity, now });
    for (let i = 0; i < 1_000; i++) h.queue.push(i);
    h.driver.arm();
    expect(h.pump()).toBe(1);
    expect(h.processed).toHaveLength(1_000);
    expect(h.driver.getStats().budgetExhausted).toBe(0);
  });

  it('runs on real queueMicrotask by default (one awaited microtask delivers)', async () => {
    const queue: number[] = [];
    const processed: number[] = [];
    const driver = new FlushDriver({
      depth: () => queue.length,
      processNext: () => processed.push(queue.shift() as number),
    });
    queue.push(1, 2, 3);
    driver.arm();
    expect(processed).toHaveLength(0); // nothing synchronous
    await Promise.resolve(); // the flush microtask runs before this continuation
    expect(processed).toEqual([1, 2, 3]);
  });

  it('flushSync drains listener cascades across rounds; maxRounds caps a runaway', () => {
    let extra = 3;
    const h = makeHarness({
      onProcess: () => {
        if (extra > 0) {
          h.queue.push(900 + extra);
          extra -= 1;
        }
      },
    });
    h.queue.push(1, 2);
    const result = h.driver.flushSync();
    expect(result).toEqual({ drained: 5, remaining: 0 });

    // Runaway: every processed item enqueues another — the cap must stop it.
    const runaway = makeHarness({ onProcess: (i) => runaway.queue.push(i + 1) });
    runaway.queue.push(0);
    const capped = runaway.driver.flushSync({ maxRounds: 5 });
    expect(capped.remaining).toBeGreaterThan(0); // honest leftover, no hang
  });

  it('stats: lastFlushMs and p95FlushMs reflect the injected clock', () => {
    const { now } = fakeClock(1);
    const h = makeHarness({ flushBudgetMs: Infinity, now });
    h.queue.push(0, 1, 2);
    h.driver.arm();
    h.pump();
    const stats = h.driver.getStats();
    expect(stats.lastFlushMs).toBeGreaterThan(0);
    expect(stats.p95FlushMs).toBeGreaterThan(0);
  });
});

describe('FlushDriver — property', () => {
  it('any arrival pattern fully drains, FIFO, with flushes ≤ checkpoints ≤ arrivals', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 30 }), (batchSizes) => {
        const h = makeHarness();
        let next = 0;
        for (const size of batchSizes) {
          for (let i = 0; i < size; i++) {
            h.queue.push(next++);
            h.driver.arm();
          }
          h.pump();
        }
        expect(h.processed).toEqual(Array.from({ length: next }, (_, i) => i));
        expect(h.queue).toHaveLength(0);
        expect(h.driver.getStats().flushes).toBeLessThanOrEqual(batchSizes.length);
      }),
      { numRuns: 150 },
    );
  });
});
