/**
 * snapshot — what `FlowChartExecutor.getSnapshot()` serves (F9).
 *
 * The traverser's runtime snapshot, plus what only the executor knows: the
 * served subflow results (each subflow's own mirror under `redact: true`), one
 * recorder row per recorder id, and the deferred tier's accounting.
 */

import { deepFreeze } from '../capture/freeze.js';
import { isDevMode } from '../devMode.js';
import { servedSubflowResults } from '../engine/handlers/servedSubflowResults.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import { copyBundle } from '../recorder/snapshot.js';
import type { ScopeRecorder } from '../scope/types.js';
import type { RunObservers } from './attach.js';
import type { RecorderSnapshot, RuntimeSnapshot } from './ExecutionRuntime.js';

/**
 * The served snapshot. `sharedState` is the LIVE view in production (zero
 * copy); in dev mode it is a deep-frozen CLONE, so a consumer mutation throws
 * instead of corrupting engine state.
 */
export function servedSnapshot(
  traverser: FlowchartTraverser<any, any>,
  observers: RunObservers,
  options?: { redact?: boolean },
): RuntimeSnapshot {
  const snapshot = traverser.getSnapshot(options) as RuntimeSnapshot;
  if (isDevMode()) {
    // Dev-mode mutation guard: freeze a CLONE, never the live engine
    // state — `snapshot.sharedState` IS SharedMemory's current generation,
    // whose unchanged subtrees every later generation shares
    // (copy-on-write, 9.29.0).
    // Production stays zero-copy; clone-always is a measured decision
    // deferred until the bench says it's affordable (BACKLOG #8).
    // NOTE: deepFreeze (capture/freeze.ts — the one walk) cannot reach
    // Map/Set INTERNALS (`map.set()` on the frozen clone won't throw) and
    // skips typed arrays. The CLONE still isolates the engine.
    snapshot.sharedState = deepFreeze(structuredClone(snapshot.sharedState));
  }
  const sfResults = traverser.getSubflowResults();
  if (sfResults.size > 0) {
    // Under `redact: true` each subflow's `globalContext` is its own mirror
    // (9.20.0) — served, never written into the record (see
    // engine/handlers/servedSubflowResults.ts). Plain: the records as they are.
    snapshot.subflowResults = servedSubflowResults(sfResults, options?.redact === true);
  }

  const recorderSnapshots = collectRecorderSnapshots(observers);
  if (recorderSnapshots.length > 0) {
    snapshot.recorders = recorderSnapshots;
  }

  // RFC-001 Block 9: the deferred-observer accounting surface. Present
  // ONLY when a deferred observer was attached on this executor —
  // zero-cost discipline for everyone else.
  if (observers.deferredTier) {
    snapshot.observerStats = observers.deferredTier.getStats();
  }

  return snapshot;
}

/**
 * Collect `toSnapshot()` bundles from every attached recorder — ONE entry
 * per recorder id, across all channels and both delivery tiers.
 *
 * The dedupe is load-bearing, not tidiness. A recorder that implements a
 * shared-name hook (`onError` / `onPause` / `onResume` — declared on BOTH
 * the scope and flow interfaces) is legitimately registered on BOTH inline
 * lists by `attachCombinedRecorder`, and that is by design: each channel
 * calls the hook with its own payload variant. `MetricRecorder.onPause` is
 * the everyday case. Walking the lists without a shared `seen` set turned
 * that into a DUPLICATED snapshot entry (same id twice), which breaks every
 * consumer that indexes `snapshot.recorders` by id.
 *
 * Ordering is scope list → flow list → deferred tier, and the FIRST bundle
 * for an id wins. A recorder with no `toSnapshot` never claims an id, so it
 * cannot shadow a same-id recorder that does have one.
 *
 * The row is REBUILT field by field by the one copier (`recorder/snapshot.ts
 * · copyBundle`, shared with `CompositeRecorder`) rather than spread, so a
 * recorder cannot smuggle an `id` of its own choosing into the snapshot (the
 * id is the executor's, and consumers index by it).
 */
export function collectRecorderSnapshots(observers: RunObservers): RecorderSnapshot[] {
  const out: RecorderSnapshot[] = [];
  const seen = new Set<string>();
  const collect = (r: ScopeRecorder | FlowRecorder): void => {
    if (!r.toSnapshot || seen.has(r.id)) return;
    seen.add(r.id);
    out.push(copyBundle(r.id, r.toSnapshot()));
  };
  for (const r of observers.scopeRecorders) collect(r);
  for (const r of observers.flowRecorders) collect(r);
  if (observers.deferredTier) {
    for (const r of observers.deferredTier.scopeListRecorders()) collect(r);
    for (const r of observers.deferredTier.flowListRecorders()) collect(r);
  }
  return out;
}
