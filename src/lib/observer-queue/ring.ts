/**
 * observer-queue/ring.ts — RFC-001 Block 2: bounded ring with overflow policies.
 *
 * Pattern:  Fixed-capacity circular buffer with explicit, COUNTED overflow
 *           behavior. The deferred-observer queue must never grow without
 *           bound (a slow consumer cannot OOM the producer), and must never
 *           lose an event silently (every loss increments `drops`).
 * Role:     Storage primitive under the merged queue (Block 3). Pure data
 *           structure — zero imports, zero engine knowledge, generic over T.
 *
 * Overflow policies (RFC-001 §5, with the accepted 'block' resolution):
 *   - `'drop-oldest'` — evict the oldest queued item to admit the new one.
 *     The evicted item is LOST (`drops`++) and returned on the push result
 *     so the caller can account for it. Sequence stamps on surviving items
 *     keep loss visible as seq gaps (honest loss accounting). DEFAULT
 *     posture for telemetry-grade delivery.
 *   - `'sample'` — while saturated, admit 1 in `sampleEvery` arrivals
 *     (evicting the oldest to make room — that eviction is also a counted
 *     loss); refuse the rest (each a counted loss). Keeps a thinned,
 *     still-fresh stream under sustained overload. The saturation counter
 *     is episode-scoped: it resets whenever a push succeeds through the
 *     non-full path.
 *   - `'block'` — the ring REFUSES the new item (`accepted: false`,
 *     `rejections`++) and drops NOTHING. In a single-threaded runtime a
 *     queue cannot literally block its producer; the dispatcher (Block 5)
 *     interprets a refusal as "deliver this event synchronously inline" —
 *     re-introducing blocking delivery by the consumer's EXPLICIT choice.
 *     Rejections are NOT losses: the event is still delivered (inline), so
 *     `drops` stays untouched.
 *
 * Conservation invariant (property-tested):
 *   pushes === delivered + drops + rejections + size
 *
 * CURSOR-READY (amendment A2): v1 consumes destructively through ONE cursor
 * (`shift()` advances `head`). The designed v1.1 path keeps items in the
 * ring and gives each listener its own read cursor; `head` then advances to
 * `min(cursors)` (the reclaim watermark) instead of on read. The storage
 * layout (contiguous circular window, `head` + `count`) already supports
 * that — only the consumption surface changes. Documented, not implemented.
 */

/** How the ring treats a push when it is at capacity (RFC-001 §5). */
export type OverflowPolicy = 'block' | 'drop-oldest' | 'sample';

export interface RingOptions {
  /** Max queued items. Positive integer. */
  readonly capacity: number;
  /** Overflow behavior at capacity — see the module header. */
  readonly policy: OverflowPolicy;
  /**
   * `'sample'` only: admit 1 in this many arrivals while saturated.
   * Positive integer; default 10.
   */
  readonly sampleEvery?: number;
}

/** Outcome of one {@link BoundedRing.push}. */
export interface RingPushResult<T> {
  /** True when the pushed item is now queued. */
  readonly accepted: boolean;
  /**
   * The oldest item, when admitting the new one evicted it
   * (`'drop-oldest'`, or a `'sample'` admission). Already counted in
   * `drops` — surfaced so callers can do their own loss accounting.
   */
  readonly evicted?: T;
}

/** Monotonic counters — never reset for the lifetime of the ring. */
export interface RingCounters {
  /** Total `push()` calls. */
  readonly pushes: number;
  /** `shift()` calls that returned an item. */
  readonly delivered: number;
  /** Items LOST — evictions plus sampled-out refusals. Never silent. */
  readonly drops: number;
  /** `'block'` refusals — NOT losses; the caller delivers these inline. */
  readonly rejections: number;
}

const DEFAULT_SAMPLE_EVERY = 10;

export class BoundedRing<T> {
  private readonly buffer: Array<T | undefined>;
  private readonly policy: OverflowPolicy;
  private readonly sampleEvery: number;
  /** Index of the oldest queued item — the single v1 cursor (see header). */
  private head = 0;
  private count = 0;
  /** Arrivals seen while saturated in the current episode (`'sample'`). */
  private saturatedArrivals = 0;

  private pushes = 0;
  private delivered = 0;
  private drops = 0;
  private rejections = 0;

  constructor(opts: RingOptions) {
    if (!Number.isInteger(opts.capacity) || opts.capacity <= 0) {
      throw new RangeError(`BoundedRing capacity must be a positive integer (got ${opts.capacity})`);
    }
    const sampleEvery = opts.sampleEvery ?? DEFAULT_SAMPLE_EVERY;
    if (!Number.isInteger(sampleEvery) || sampleEvery <= 0) {
      throw new RangeError(`BoundedRing sampleEvery must be a positive integer (got ${opts.sampleEvery})`);
    }
    this.buffer = new Array<T | undefined>(opts.capacity);
    this.policy = opts.policy;
    this.sampleEvery = sampleEvery;
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.buffer.length;
  }

  /** Lifetime counters — see {@link RingCounters}. */
  getCounters(): RingCounters {
    return { pushes: this.pushes, delivered: this.delivered, drops: this.drops, rejections: this.rejections };
  }

  /** Admit, evict-and-admit, refuse, or sample per policy — never throws. */
  push(item: T): RingPushResult<T> {
    this.pushes += 1;

    if (this.count < this.buffer.length) {
      this.saturatedArrivals = 0; // new saturation episode starts fresh
      this.store(item);
      return { accepted: true };
    }

    if (this.policy === 'block') {
      this.rejections += 1;
      return { accepted: false };
    }

    if (this.policy === 'sample') {
      this.saturatedArrivals += 1;
      if (this.saturatedArrivals % this.sampleEvery !== 0) {
        this.drops += 1; // the incoming item is sampled out — lost
        return { accepted: false };
      }
      // The 1-in-N admission falls through to evict-and-store.
    }

    // 'drop-oldest' (and the 'sample' admission): evict the oldest — lost.
    const evicted = this.buffer[this.head] as T;
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.buffer.length;
    this.count -= 1;
    this.drops += 1;
    this.store(item);
    return { accepted: true, evicted };
  }

  /** Pop the oldest queued item (FIFO). `undefined` when empty. */
  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.buffer[this.head] as T;
    this.buffer[this.head] = undefined; // release the reference for GC
    this.head = (this.head + 1) % this.buffer.length;
    this.count -= 1;
    this.delivered += 1;
    return item;
  }

  private store(item: T): void {
    this.buffer[(this.head + this.count) % this.buffer.length] = item;
    this.count += 1;
  }
}
