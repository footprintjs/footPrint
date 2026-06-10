/**
 * observer-queue/deferredDispatcher.ts — RFC-001 Block 5: deferred delivery façade.
 *
 * Pattern:  capture → enqueue → (microtask) flush → invoke, with per-listener
 *           error isolation. Composes the whole pure pipeline: MergedQueue
 *           (Block 3, which captures via Block 1) + FlushDriver (Block 4) +
 *           a listener registry with timing/inflight accounting.
 * Role:     The object the engine wiring (Block 6) will hold. Producers call
 *           `capture()` (cheap, never throws, never blocks); listeners
 *           receive envelopes at the next checkpoint, "one beat behind".
 *           Pure module — zero engine imports.
 *
 * Delivery semantics (normative, RFC-001 §5 + amendments A2/A4):
 *   - Per-listener FIFO: every listener sees envelopes in seq order
 *     (invocation order; an async listener's COMPLETION order is its own
 *     concern).
 *   - Error isolation: a throwing listener (sync) or rejecting listener
 *     (async) never affects siblings or the producer. Both failure modes
 *     route to the injected `onError`; a throwing `onError` is itself
 *     swallowed.
 *   - The flush NEVER awaits a listener. Async continuations are tracked in
 *     an inflight set; `drain({ timeoutMs })` settles them
 *     (`Promise.allSettled` + deadline, shaped like `flushAllDetached`).
 *   - `'block'` overflow: a refused enqueue is delivered synchronously
 *     INLINE from `capture()` — re-introducing blocking delivery by the
 *     consumer's explicit choice. Ordering caveat (documented + tested): an
 *     inline event overtakes the queued backlog — `'block'` trades global
 *     ordering for zero loss and bounded memory. `seq` still tells the
 *     true arrival order.
 *   - Listener registry is idempotent by id (same id replaces, different
 *     ids coexist) — mirrors the repo-wide recorder ID contract. Stats
 *     accumulate per id across replacement; `removeListener` keeps the
 *     id's accumulated stats for post-run reports.
 *   - Events captured BEFORE any listener attaches stay queued — a listener
 *     attached before the next checkpoint still receives the backlog.
 *
 * Per-listener time accounting (amendment A2 — "name the hog"): cumulative
 * `totalMs` and per-checkpoint `lastFlushMs` of SYNC time per listener id —
 * the time that actually blocks the flush. An async listener's continuation
 * time is intentionally not attributed (it does not block delivery).
 */

import { type CaptureEnvelope, type CaptureHooks, type CapturePolicy } from '../capture/envelope.js';
import { type FlushSyncResult, FlushDriver } from './flushDriver.js';
import { type EnqueueInput, MergedQueue } from './mergedQueue.js';
import { type OverflowPolicy } from './ring.js';

/**
 * One deferred observer. May return a Promise — the dispatcher tracks it in
 * the inflight set but NEVER awaits it during a flush.
 */
export type DeferredListener = (envelope: CaptureEnvelope) => void | Promise<void>;

export interface DispatchErrorContext {
  readonly listenerId: string;
  readonly envelope: CaptureEnvelope;
  /** `'sync'` = listener threw; `'async'` = returned promise rejected. */
  readonly phase: 'sync' | 'async';
}

/** Injected error sink — the wiring layer routes these (Block 6). */
export type DispatchErrorHandler = (error: unknown, context: DispatchErrorContext) => void;

export interface DeferredDispatcherOptions {
  /** Queue bound — default 10 000 (see `MergedQueue`). */
  readonly maxQueue?: number;
  /** Overflow policy — default `'drop-oldest'`. */
  readonly overflow?: OverflowPolicy;
  /** `'sample'` overflow only — admit 1 in this many saturated arrivals. */
  readonly sampleEvery?: number;
  /** Default capture policy — default `'summary'`. */
  readonly capturePolicy?: CapturePolicy;
  /** Per-flush time budget, ms (A1) — default 2; `Infinity` = full drain. */
  readonly flushBudgetMs?: number;
  /** Listener-failure sink. No default — without it, failures are silent. */
  readonly onError?: DispatchErrorHandler;
  /** Capture seams (dev-warn, capturedAt clock) — see `CaptureHooks`. */
  readonly hooks?: CaptureHooks;
  /** Timing clock for budget + per-listener accounting. Injectable. */
  readonly now?: () => number;
  /** Checkpoint primitive — default `queueMicrotask`. Injectable. */
  readonly schedule?: (cb: () => void) => void;
}

/** Per-listener accounting (A2/A4). */
export interface ListenerStats {
  /** Envelopes delivered (invocations, including ones that threw). */
  readonly events: number;
  /** Cumulative sync delivery time, ms. */
  readonly totalMs: number;
  /** Sync delivery time since the last flush started, ms. */
  readonly lastFlushMs: number;
}

/** The Block 9 observability surface (amendment A4) — pure getter. */
export interface DispatcherStats {
  /** Current backlog. */
  readonly depth: number;
  /** Events LOST (overflow) — never silent; also visible as seq gaps. */
  readonly drops: number;
  /** Completed checkpoint flushes. */
  readonly flushes: number;
  /** Flushes cut short by `flushBudgetMs` (A1). */
  readonly budgetExhausted: number;
  /** p95 flush duration, ms (rolling window). */
  readonly p95FlushMs: number;
  /** `'block'`-policy refusals delivered synchronously inline. */
  readonly inlineDeliveries: number;
  /** Async listener continuations not yet settled. */
  readonly inflight: number;
  /** Per-listener time accounting — "name the hog" (A2). */
  readonly perListener: Readonly<Record<string, ListenerStats>>;
}

/** Result of {@link DeferredDispatcher.drain} — `flushAllDetached` shape. */
export interface DrainResult {
  /** Async continuations seen settling fulfilled. Best-effort count — a
   *  continuation that settles between checks is drained but may not be
   *  counted (same semantics as `flushAllDetached`). */
  readonly done: number;
  /** Continuations whose listener promise rejected (routed to onError). */
  readonly failed: number;
  /** Still in flight (or queued) when the deadline expired. `0` = drained. */
  readonly pending: number;
}

interface MutableListenerStats {
  events: number;
  totalMs: number;
  lastFlushMs: number;
}

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function isThenable(value: void | Promise<void>): value is Promise<void> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<void>).then === 'function';
}

export class DeferredDispatcher {
  private readonly queue: MergedQueue;
  private readonly driver: FlushDriver;
  private readonly listeners = new Map<string, DeferredListener>();
  private readonly listenerStats = new Map<string, MutableListenerStats>();
  /** Tracked async continuations — resolve `true` (ok) / `false` (failed). */
  private readonly inflight = new Set<Promise<boolean>>();
  private readonly onError?: DispatchErrorHandler;
  private readonly now: () => number;
  private inlineDeliveries = 0;

  constructor(opts?: DeferredDispatcherOptions) {
    this.onError = opts?.onError;
    this.now = opts?.now ?? defaultNow;
    this.queue = new MergedQueue({
      maxQueue: opts?.maxQueue,
      overflow: opts?.overflow,
      sampleEvery: opts?.sampleEvery,
      capturePolicy: opts?.capturePolicy,
      hooks: opts?.hooks,
    });
    this.driver = new FlushDriver({
      depth: () => this.queue.depth,
      processNext: () => this.deliverNext(),
      flushBudgetMs: opts?.flushBudgetMs,
      now: opts?.now,
      schedule: opts?.schedule,
      onFlushStart: () => {
        for (const stats of this.listenerStats.values()) stats.lastFlushMs = 0;
      },
    });
  }

  /** Idempotent by id — same id replaces (stats continue), ids coexist. */
  addListener(id: string, listener: DeferredListener): void {
    this.listeners.set(id, listener);
    if (!this.listenerStats.has(id)) {
      this.listenerStats.set(id, { events: 0, totalMs: 0, lastFlushMs: 0 });
    }
  }

  /** Stop delivering to `id`. Accumulated stats are kept for reports. */
  removeListener(id: string): void {
    this.listeners.delete(id);
  }

  /**
   * Producer entry point: capture the event (seq-stamped, payload per
   * policy) and stage it for the next checkpoint. Cheap; NEVER throws;
   * never blocks — except under `'block'` overflow, where a refused
   * enqueue is delivered synchronously inline (explicit consumer choice).
   */
  capture(input: EnqueueInput, policy?: CapturePolicy): void {
    const result = this.queue.enqueue(input, policy);
    if (result.outcome === 'queued') {
      this.driver.arm();
      return;
    }
    if (result.outcome === 'inline') {
      this.inlineDeliveries += 1;
      this.deliver(result.envelope);
    }
    // 'dropped': counted by the queue; loss surfaces in stats + seq gaps.
  }

  /**
   * Terminal flush — synchronously deliver everything queued (end of run /
   * shutdown). Async listener continuations are NOT awaited; follow with
   * `drain()` for that.
   */
  flushNow(opts?: { maxRounds?: number }): FlushSyncResult {
    return this.driver.flushSync(opts);
  }

  /**
   * Flush the backlog, then settle all inflight async continuations —
   * `Promise.allSettled` under a deadline, shaped like `flushAllDetached`.
   * Loops while continuations spawn new captures, until quiescent or the
   * deadline expires.
   */
  async drain(opts?: { timeoutMs?: number }): Promise<DrainResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    let done = 0;
    let failed = 0;

    this.flushNow();
    while (this.inflight.size > 0) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return { done, failed, pending: this.inflight.size + this.queue.depth };

      const batch = [...this.inflight];
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'__drain_timeout__'>((resolve) => {
        timerId = setTimeout(() => resolve('__drain_timeout__'), remainingMs);
      });
      const settled = await Promise.race([Promise.allSettled(batch), timeoutPromise]);
      if (timerId !== undefined) clearTimeout(timerId);
      if (settled === '__drain_timeout__') {
        return { done, failed, pending: this.inflight.size + this.queue.depth };
      }
      for (const r of settled) {
        // Tracked promises never reject — they resolve true (ok) / false.
        if (r.status === 'fulfilled' && r.value === false) failed += 1;
        else done += 1;
      }
      // Continuations may have captured more events — flush and re-check.
      this.flushNow();
    }
    return { done, failed, pending: this.queue.depth };
  }

  /** A4 — the stats object Block 9 consumes. Pure getter, fresh snapshot. */
  getStats(): DispatcherStats {
    const counters = this.queue.getCounters();
    const driverStats = this.driver.getStats();
    const perListener: Record<string, ListenerStats> = {};
    for (const [id, stats] of this.listenerStats) {
      perListener[id] = { events: stats.events, totalMs: stats.totalMs, lastFlushMs: stats.lastFlushMs };
    }
    return {
      depth: this.queue.depth,
      drops: counters.drops,
      flushes: driverStats.flushes,
      budgetExhausted: driverStats.budgetExhausted,
      p95FlushMs: driverStats.p95FlushMs,
      inlineDeliveries: this.inlineDeliveries,
      inflight: this.inflight.size,
      perListener,
    };
  }

  private deliverNext(): void {
    const envelope = this.queue.shift();
    if (envelope === undefined) return;
    this.deliver(envelope);
  }

  /** Invoke every listener with full error isolation + time accounting. */
  private deliver(envelope: CaptureEnvelope): void {
    for (const [id, listener] of this.listeners) {
      const stats = this.listenerStats.get(id) as MutableListenerStats;
      const start = this.now();
      try {
        const result = listener(envelope);
        if (isThenable(result)) this.track(result, id, envelope);
      } catch (error) {
        this.safeOnError(error, { listenerId: id, envelope, phase: 'sync' });
      } finally {
        const elapsed = this.now() - start;
        stats.events += 1;
        stats.totalMs += elapsed;
        stats.lastFlushMs += elapsed;
      }
    }
  }

  /** Track an async continuation; route its rejection; never reject. */
  private track(promise: Promise<void>, listenerId: string, envelope: CaptureEnvelope): void {
    const tracked: Promise<boolean> = promise.then(
      () => true,
      (error) => {
        this.safeOnError(error, { listenerId, envelope, phase: 'async' });
        return false;
      },
    );
    this.inflight.add(tracked);
    // Self-cleanup — `tracked` never rejects, so this chain cannot float an
    // unhandled rejection.
    tracked.then(() => this.inflight.delete(tracked));
  }

  /** The error sink must never become an error source. */
  private safeOnError(error: unknown, context: DispatchErrorContext): void {
    try {
      this.onError?.(error, context);
    } catch {
      // Swallow — isolation is absolute.
    }
  }
}
