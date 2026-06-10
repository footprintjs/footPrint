/**
 * observer-queue/mergedQueue.ts — RFC-001 Block 3: seq stamping + multi-channel merge.
 *
 * Pattern:  Single totally-ordered staging queue. All three observer
 *           channels (`scope` / `flow` / `emit`) funnel through ONE queue;
 *           the `seq` counter is assigned at capture under the single JS
 *           thread, so drain order == arrival order ACROSS channels with no
 *           cross-queue merge logic ever needed.
 * Role:     Glue between the capture tier (Block 1) and the flush driver
 *           (Block 4). Pure module — imports only `capture/envelope` and
 *           the ring (Block 2); zero engine knowledge.
 *
 * Seq semantics (normative, RFC-001 §5):
 *   - Stamped BEFORE admission — an event that is then dropped (overflow)
 *     or refused (`'block'`) still consumed its seq. Drops therefore leave
 *     VISIBLE gaps in the delivered stream (honest loss accounting), and
 *     `'block'`-refused events delivered inline keep their true arrival
 *     stamp even though they overtake the queued backlog.
 *   - Monotonic, starts at 0, never reused for the lifetime of the queue.
 *
 * Enqueue outcomes:
 *   - `'queued'`  — staged for the next flush (drop-oldest may have evicted
 *     an older event to make room; that loss is counted, never silent).
 *   - `'dropped'` — the event was sampled out at saturation. Lost; counted.
 *   - `'inline'`  — `'block'` policy refused the enqueue. NOT lost: the
 *     caller (the dispatcher, Block 5) must deliver the returned envelope
 *     synchronously inline — blocking delivery by explicit consumer choice.
 */

import {
  type CaptureChannel,
  type CaptureEnvelope,
  type CaptureHooks,
  type CapturePolicy,
  capture,
} from '../capture/envelope.js';
import { type OverflowPolicy, type RingCounters, BoundedRing } from './ring.js';

/** RFC-001 §5 default queue bound. */
export const DEFAULT_MAX_QUEUE = 10_000;

/** One observer event to merge — {@link capture}'s request minus `seq`. */
export interface EnqueueInput {
  readonly channel: CaptureChannel;
  readonly method: string;
  readonly runtimeStageId: string;
  readonly runId: string;
  /** LIVE payload — materialized per capture policy at enqueue time. */
  readonly payload: unknown;
}

/** Fate of one enqueued event — see the module header. */
export type EnqueueOutcome = 'queued' | 'dropped' | 'inline';

export interface EnqueueResult {
  /** The captured, seq-stamped envelope (built even when not queued). */
  readonly envelope: CaptureEnvelope;
  readonly outcome: EnqueueOutcome;
}

export interface MergedQueueOptions {
  /** Ring capacity. Default {@link DEFAULT_MAX_QUEUE} (10 000). */
  readonly maxQueue?: number;
  /** Overflow policy at capacity. Default `'drop-oldest'`. */
  readonly overflow?: OverflowPolicy;
  /** `'sample'` only — admit 1 in this many saturated arrivals. */
  readonly sampleEvery?: number;
  /** Default capture policy when `enqueue` gets none. Default `'summary'`. */
  readonly capturePolicy?: CapturePolicy;
  /** Engine-free seams (dev-warn, clock) passed through to {@link capture}. */
  readonly hooks?: CaptureHooks;
}

export class MergedQueue {
  private readonly ring: BoundedRing<CaptureEnvelope>;
  private readonly overflow: OverflowPolicy;
  private readonly defaultPolicy: CapturePolicy;
  private readonly hooks?: CaptureHooks;
  /** Arrival stamp — monotonic across ALL channels (see module header). */
  private seq = 0;

  constructor(opts?: MergedQueueOptions) {
    this.overflow = opts?.overflow ?? 'drop-oldest';
    this.ring = new BoundedRing<CaptureEnvelope>({
      capacity: opts?.maxQueue ?? DEFAULT_MAX_QUEUE,
      policy: this.overflow,
      sampleEvery: opts?.sampleEvery,
    });
    this.defaultPolicy = opts?.capturePolicy ?? 'summary';
    this.hooks = opts?.hooks;
  }

  /**
   * Capture one event (seq-stamped at arrival) and stage it for deferred
   * delivery. `policy` overrides the queue default per call — e.g. `'ref'`
   * for payloads the caller proved immutable. Never throws.
   */
  enqueue(input: EnqueueInput, policy?: CapturePolicy): EnqueueResult {
    const envelope = capture(
      {
        seq: this.seq,
        channel: input.channel,
        method: input.method,
        runtimeStageId: input.runtimeStageId,
        runId: input.runId,
        payload: input.payload,
      },
      policy ?? this.defaultPolicy,
      this.hooks,
    );
    this.seq += 1;

    const pushed = this.ring.push(envelope);
    if (pushed.accepted) return { envelope, outcome: 'queued' };
    return { envelope, outcome: this.overflow === 'block' ? 'inline' : 'dropped' };
  }

  /** Pop the oldest staged envelope (total arrival order across channels). */
  shift(): CaptureEnvelope | undefined {
    return this.ring.shift();
  }

  /** Current backlog. */
  get depth(): number {
    return this.ring.size;
  }

  /** Ring capacity (the `maxQueue` bound). */
  get capacity(): number {
    return this.ring.capacity;
  }

  /** The next seq to be assigned == total events captured so far. */
  get nextSeq(): number {
    return this.seq;
  }

  /** Lifetime loss/delivery accounting — delegated to the ring. */
  getCounters(): RingCounters {
    return this.ring.getCounters();
  }
}
