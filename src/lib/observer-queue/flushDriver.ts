/**
 * observer-queue/flushDriver.ts — RFC-001 Block 4: armed-once microtask batcher.
 *
 * Pattern:  Kernel-style bottom-half. Producers only set a flag ("work
 *           pending") and return; the actual work runs at the next
 *           scheduling checkpoint (a microtask), drains under a time
 *           budget, and re-arms itself if backlog remains. Same shape as
 *           the detach module's `microtaskBatchDriver` — accumulate during
 *           the current sync slice, drain at the boundary.
 * Role:     The scheduler of the deferred-observer pipeline. Owns WHEN
 *           delivery happens; knows nothing about envelopes or listeners
 *           (the dispatcher, Block 5, injects `depth`/`processNext`).
 *           Pure module — zero imports, zero engine knowledge.
 *
 * Scheduling semantics (normative, RFC-001 §5 + amendment A1):
 *   - `arm()` is idempotent: at most ONE pending flush exists (armed flag).
 *     N captures between checkpoints ⇒ exactly 1 flush.
 *   - A flush drains a SNAPSHOT: at most `depth()`-at-flush-start items.
 *     Events enqueued BY listeners during the flush exceed the snapshot and
 *     land at the NEXT checkpoint — listener-driven cascades cannot starve
 *     the event loop.
 *   - `flushBudgetMs` (default 2; `Infinity` = full snapshot drain): the
 *     flush stops once the budget is exhausted, counts `budgetExhausted`,
 *     and re-arms. At least ONE item is processed per flush regardless of
 *     budget — guaranteed progress under any clock.
 *   - If backlog remains after the flush (budget cut OR listener enqueues),
 *     the driver re-arms for the next checkpoint.
 *
 * Why stage boundaries make this safe: the engine `await`s every stage, so
 * the microtask queue runs at EVERY stage boundary — flushes are at most
 * "one beat behind" the producing stage. See
 * `docs/guides/execution-model.md` ("Stage boundaries are scheduling
 * points") and the FAQ in `docs/design/rfc-001-deferred-observers.md`.
 *
 * Testability: `now` (clock) and `schedule` (checkpoint primitive) are
 * injectable — tests pump flushes deterministically with a fake clock and
 * a captured-callback scheduler; production uses `performance.now` and
 * `queueMicrotask`.
 */

/** Result of one flush (also delivered to `onFlushEnd`). */
export interface FlushOutcome {
  /** Items processed in this flush. */
  readonly processed: number;
  /** True when the time budget cut the flush before the snapshot drained. */
  readonly budgetExhausted: boolean;
  /** True when backlog remained and the driver re-armed itself. */
  readonly rearmed: boolean;
}

/** Result of a synchronous {@link FlushDriver.flushSync} drain. */
export interface FlushSyncResult {
  /** Items processed across all rounds. */
  readonly drained: number;
  /** Items still queued when `maxRounds` stopped a runaway cascade. */
  readonly remaining: number;
}

export interface FlushDriverOptions {
  /** Current backlog of the queue this driver drains. */
  readonly depth: () => number;
  /** Process exactly ONE queued item. Precondition: `depth() > 0`. */
  readonly processNext: () => void;
  /**
   * Per-flush time budget in ms. Default 2. `Infinity` drains the full
   * snapshot every checkpoint. Must be > 0.
   */
  readonly flushBudgetMs?: number;
  /** Clock — default `performance.now` (falls back to `Date.now`). */
  readonly now?: () => number;
  /** Checkpoint primitive — default `queueMicrotask`. */
  readonly schedule?: (cb: () => void) => void;
  /** Fires before the first item of every flush (incl. `flushSync`). */
  readonly onFlushStart?: () => void;
  /** Fires after every flush with its outcome (incl. `flushSync`). */
  readonly onFlushEnd?: (outcome: FlushOutcome) => void;
}

export interface FlushDriverStats {
  /** Completed flushes (zero-work wakeups are not counted). */
  readonly flushes: number;
  /** Flushes cut short by `flushBudgetMs` (A1 — backlog visibility). */
  readonly budgetExhausted: number;
  /** Duration of the most recent flush, ms. */
  readonly lastFlushMs: number;
  /** p95 over the last {@link FLUSH_SAMPLE_WINDOW} flush durations, ms. */
  readonly p95FlushMs: number;
  /** True while a flush is scheduled but not yet run. */
  readonly armed: boolean;
}

/** Rolling sample window for the p95 flush-duration stat (A4). */
export const FLUSH_SAMPLE_WINDOW = 128;

/** Default cascade cap for {@link FlushDriver.flushSync}. */
const DEFAULT_MAX_SYNC_ROUNDS = 1_000;

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class FlushDriver {
  private readonly depth: () => number;
  private readonly processNext: () => void;
  private readonly flushBudgetMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => void;
  private readonly onFlushStart?: () => void;
  private readonly onFlushEnd?: (outcome: FlushOutcome) => void;

  private armed = false;
  private flushes = 0;
  private budgetExhaustedCount = 0;
  private lastFlushMs = 0;
  private readonly samples: number[] = [];
  private sampleWriteIdx = 0;

  constructor(opts: FlushDriverOptions) {
    const budget = opts.flushBudgetMs ?? 2;
    if (Number.isNaN(budget) || budget <= 0) {
      throw new RangeError(`flushBudgetMs must be > 0 (got ${budget}); use Infinity for full drains`);
    }
    this.depth = opts.depth;
    this.processNext = opts.processNext;
    this.flushBudgetMs = budget;
    this.now = opts.now ?? defaultNow;
    this.schedule = opts.schedule ?? ((cb) => queueMicrotask(cb));
    this.onFlushStart = opts.onFlushStart;
    this.onFlushEnd = opts.onFlushEnd;
  }

  /**
   * Request a flush at the next checkpoint. Idempotent — while one flush
   * is pending, further arms are free no-ops (the armed-once invariant).
   */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.schedule(() => this.flush());
  }

  /**
   * Synchronous full drain — the terminal-flush primitive (end of run /
   * shutdown). Repeats snapshot rounds until the queue is empty so
   * listener-enqueued cascades drain too, capped at `maxRounds` so a
   * listener that enqueues forever cannot hang the process (`remaining`
   * reports what the cap left behind).
   */
  flushSync(opts?: { maxRounds?: number }): FlushSyncResult {
    const maxRounds = opts?.maxRounds ?? DEFAULT_MAX_SYNC_ROUNDS;
    if (this.depth() === 0) return { drained: 0, remaining: 0 };

    this.onFlushStart?.();
    const start = this.now();
    let drained = 0;
    for (let round = 0; round < maxRounds && this.depth() > 0; round++) {
      const snapshot = this.depth();
      for (let i = 0; i < snapshot && this.depth() > 0; i++) {
        this.processNext();
        drained += 1;
      }
    }
    this.recordFlush(this.now() - start, false);
    const remaining = this.depth();
    this.onFlushEnd?.({ processed: drained, budgetExhausted: false, rearmed: false });
    return { drained, remaining };
  }

  getStats(): FlushDriverStats {
    return {
      flushes: this.flushes,
      budgetExhausted: this.budgetExhaustedCount,
      lastFlushMs: this.lastFlushMs,
      p95FlushMs: this.p95FlushMs(),
      armed: this.armed,
    };
  }

  /** The microtask body — see the module-header semantics. */
  private flush(): void {
    this.armed = false;
    const snapshot = this.depth();
    if (snapshot === 0) return; // raced with flushSync — zero-work wakeup

    this.onFlushStart?.();
    const start = this.now();
    let processed = 0;
    let exhausted = false;
    while (processed < snapshot && this.depth() > 0) {
      // Budget check AFTER the first item — guaranteed progress per flush.
      if (processed > 0 && this.now() - start >= this.flushBudgetMs) {
        exhausted = true;
        break;
      }
      this.processNext();
      processed += 1;
    }
    this.recordFlush(this.now() - start, exhausted);

    // Backlog left (budget cut, or listeners enqueued past the snapshot):
    // hand it to the NEXT checkpoint — never starve, never spin.
    const rearmed = this.depth() > 0;
    if (rearmed) this.arm();
    this.onFlushEnd?.({ processed, budgetExhausted: exhausted, rearmed });
  }

  private recordFlush(elapsedMs: number, exhausted: boolean): void {
    this.flushes += 1;
    this.lastFlushMs = elapsedMs;
    if (exhausted) this.budgetExhaustedCount += 1;
    if (this.samples.length < FLUSH_SAMPLE_WINDOW) this.samples.push(elapsedMs);
    else {
      this.samples[this.sampleWriteIdx] = elapsedMs;
      this.sampleWriteIdx = (this.sampleWriteIdx + 1) % FLUSH_SAMPLE_WINDOW;
    }
  }

  private p95FlushMs(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
}
