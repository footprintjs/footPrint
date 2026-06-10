/* istanbul ignore file */
/**
 * observer-queue/ — RFC-001 deferred observer delivery, Blocks 2–5.
 *
 * The pure "one beat behind" pipeline:
 *
 *   producer ─► capture (Block 1, `capture/envelope`) ─► MergedQueue
 *   (Block 3, seq-stamped over a BoundedRing, Block 2) ─► FlushDriver
 *   (Block 4, armed-once microtask checkpoints, flushBudgetMs) ─►
 *   DeferredDispatcher (Block 5, isolated listeners + inflight + stats)
 *
 * INTERNAL MODULE — deliberately NOT exported from the public footprintjs
 * barrels yet. The engine wiring + public surface land with Blocks 6–10
 * (see docs/design/rfc-001-deferred-observers.md). Zero engine imports:
 * this directory may import only `../capture/` and its own files.
 */

export type {
  CaptureChannel,
  CaptureEnvelope,
  CaptureHooks,
  CapturePolicy,
  CaptureRequest,
  PayloadSummary,
  PayloadSummaryNode,
  PayloadSummaryType,
} from '../capture/envelope.js';
export {
  capture,
  PAYLOAD_SUMMARY_MAX_DEPTH,
  PAYLOAD_SUMMARY_MAX_ENTRIES,
  PAYLOAD_SUMMARY_MAX_NODES,
  summarizePayload,
} from '../capture/envelope.js';
export type {
  DeferredDispatcherOptions,
  DeferredListener,
  DispatchErrorContext,
  DispatchErrorHandler,
  DispatcherStats,
  DrainResult,
  ListenerStats,
} from './deferredDispatcher.js';
export { DeferredDispatcher } from './deferredDispatcher.js';
export type { FlushDriverOptions, FlushDriverStats, FlushOutcome, FlushSyncResult } from './flushDriver.js';
export { FLUSH_SAMPLE_WINDOW, FlushDriver } from './flushDriver.js';
export type { EnqueueInput, EnqueueOutcome, EnqueueResult, MergedQueueOptions } from './mergedQueue.js';
export { DEFAULT_MAX_QUEUE, MergedQueue } from './mergedQueue.js';
export type { OverflowPolicy, RingCounters, RingOptions, RingPushResult } from './ring.js';
export { BoundedRing } from './ring.js';
