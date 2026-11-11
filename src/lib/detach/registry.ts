/**
 * detach/registry.ts — Process-singleton handle registry.
 *
 * Pattern:  Registry (GoF). Same shape as the cache strategy registry
 *           in agentfootprint v2.6 — a Map keyed by stable string id.
 * Role:     Glue between drivers and `flushAllDetached`. When a driver
 *           schedules work it `register`s the handle here; later
 *           `flushAllDetached` and diagnostics `lookup` it by refId.
 *
 * Why a singleton?
 *   - refIds are minted per detach call (`spawn.ts`:
 *     `${runtimeStageId}:detach:${n}`, or `__executor__:detach:${n}`
 *     outside a stage)
 *   - handles are reached from MULTIPLE call sites (each driver
 *     registers and unregisters, `flushAllDetached` reads, tests reset)
 *     without each one
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
 *   - Drivers call `unregister(refId)` once the
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
 * Replacing an existing registration is a programming error (refIds are
 * supposed to be unique). It does not throw — throwing inside a driver's
 * hot path could cascade into the parent stage — and it does not warn:
 * the new handle silently replaces the old one.
 */
export function register(handle: DetachHandle): void {
  HANDLES.set(handle.id, handle);
}

/**
 * Look up a handle by refId. Returns `undefined` for unknown ids — the
 * caller decides whether that's an error or just a stale reference.
 *
 * Used by:
 *   - `flushAllDetached` (`flush.ts`: the handles still in flight)
 *   - Diagnostic tooling (`lookupDetachedHandle`: dump handle state for a
 *     refId in a log line)
 */
export function lookup(refId: string): DetachHandle | undefined {
  return HANDLES.get(refId);
}

/**
 * Drop a handle from the registry. Idempotent — calling on an already-
 * removed refId is a no-op (matches `Map.delete` semantics; useful when
 * cleanup may run more than once).
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
 * dumps during shutdown or oncall debugging.
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
