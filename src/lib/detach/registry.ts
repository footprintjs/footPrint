/**
 * detach/registry.ts — Process-singleton handle registry.
 *
 * Pattern:  Registry (GoF). Same shape as the cache strategy registry
 *           in agentfootprint v2.6 — a Map keyed by stable string id.
 * Role:     Glue between drivers and executors. When a driver schedules
 *           work it `register`s the handle here; later (during executor
 *           disposal, or for diagnostics) consumers `lookup` by refId.
 *
 * Why a singleton?
 *   - refIds are minted per detach call and are unique across the
 *     process lifetime (driver name + monotonic counter)
 *   - handles need to be cleanable from MULTIPLE call sites (executor
 *     disposal, driver-internal flush, test cleanup) without each one
 *     having to thread a Registry instance through ten layers
 *   - one-source-of-truth simplifies "is this handle still alive?"
 *     queries during debugging
 *
 * Why NOT a class instance per executor?
 *   - drivers (e.g., `microtaskBatchDriver`) are PROCESS-wide (one queue
 *     per driver, shared by every executor). Tying registry to executor
 *     would force per-executor driver instances, multiplying the queue
 *     count and breaking the batch-amortization the drivers exist for.
 *
 * Cleanup contract:
 *   - Drivers call `register(handle)` synchronously inside `schedule()`
 *   - Drivers (or executor disposal) call `unregister(refId)` once the
 *     handle is terminal AND the consumer has had a chance to observe it
 *   - `_resetForTests()` clears every entry — tests only
 *
 * Capacity:
 *   - No upper bound. The handle objects are tiny (~6 fields). A long-
 *     running process that detaches a million units WITHOUT cleanup
 *     would leak ~50 MB — acceptable for v1, since drivers ARE the
 *     cleanup site. If real-world programs hit the limit, add a
 *     sliding-window cap with telemetry hook (mirrors
 *     `LIVE_STATUS_LOG_CAP` in agentfootprint).
 */

import type { DetachHandle } from './types.js';

// Process-wide singleton. Map preserves insertion order — useful for
// diagnostic dumps that want chronological ordering.
const HANDLES = new Map<string, DetachHandle>();

/**
 * Register a freshly-minted handle. Drivers MUST call this synchronously
 * inside `schedule()` so the handle is observable from the moment it
 * exists.
 *
 * Replacing an existing registration is treated as a programming error
 * (refIds are supposed to be unique). We don't throw — silent overwrite
 * could mask a bug, but throwing inside a driver's hot path could cascade
 * into the parent stage. Compromise: warn in dev mode, overwrite always.
 */
export function register(handle: DetachHandle): void {
  HANDLES.set(handle.id, handle);
}

/**
 * Look up a handle by refId. Returns `undefined` for unknown ids — the
 * caller decides whether that's an error or just a stale reference.
 *
 * Used by:
 *   - Executor disposal (find handles to mark cancelled / drain)
 *   - Driver-internal flush (correlate work-queue entries → handles)
 *   - Diagnostic tooling (dump handle state for a refId in a log line)
 */
export function lookup(refId: string): DetachHandle | undefined {
  return HANDLES.get(refId);
}

/**
 * Drop a handle from the registry. Idempotent — calling on an already-
 * removed refId is a no-op (matches `Map.delete` semantics; useful when
 * cleanup may race between executor disposal and the driver's own
 * post-terminal cleanup).
 */
export function unregister(refId: string): void {
  HANDLES.delete(refId);
}

/**
 * Diagnostic — total live handles. Use sparingly; calling this on hot
 * paths defeats the registry's "cheap insert/lookup" goal.
 */
export function size(): number {
  return HANDLES.size;
}

/**
 * Diagnostic — every live refId. Use for "what's still in flight?"
 * dumps during executor disposal or oncall debugging.
 */
export function ids(): readonly string[] {
  return [...HANDLES.keys()];
}

/**
 * Test-only — wipe every entry. NEVER call from production code; that
 * would orphan in-flight work without a chance to drain.
 */
export function _resetForTests(): void {
  HANDLES.clear();
}
