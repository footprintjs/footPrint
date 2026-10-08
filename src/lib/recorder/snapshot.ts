/**
 * recorder/snapshot.ts — the ONE copier for a recorder's `toSnapshot()` bundle (F6).
 *
 * A bundle is never passed through as returned: it is rebuilt field by field, so a recorder
 * cannot spoof its own `id` (the executor's, and consumers index by it) and nothing it adds
 * beyond the contract leaks into the snapshot. The cost is that a field this copier forgets
 * is dropped in silence — which is why there is exactly one copier, and why
 * `runner/snapshot.ts · collectRecorderSnapshots` and `CompositeRecorder · toSnapshot` both
 * call it (the composite used to keep only `name`/`data` and lost `meta`/`description`).
 *
 * A new bundle field is: one member on `RecorderSnapshot` (runner/ExecutionRuntime.ts) and
 * one line here. The three `toSnapshot?()` signatures (`ScopeRecorder`, `FlowRecorder`,
 * `CombinedRecorder`, and `EmitRecorder`) all name `RecorderBundle`, so they follow.
 *
 * SERVED (9.45.0): `data` and `meta` are fresh copies (`capture/freeze.ts · serveCopy`). A
 * recorder's `toSnapshot()` may hand back its own store, so a row that held it let a holder of one
 * snapshot rewrite what the recorder — and every later snapshot — reports. A row a recorder made
 * uncloneable (against the snapshot contract: rows survive `structuredClone`) is served as it is.
 */

import { serveCopy } from '../capture/freeze.js';
import type { RecorderSnapshot } from '../runner/ExecutionRuntime.js';

/** What `toSnapshot()` returns: a snapshot row without the `id` the attach site owns. */
export type RecorderBundle = Omit<RecorderSnapshot, 'id'>;

/** Rebuild `bundle` as the snapshot row for the recorder attached under `id`. */
export function copyBundle(id: string, bundle: RecorderBundle): RecorderSnapshot {
  return {
    id,
    name: bundle.name,
    description: bundle.description,
    preferredOperation: bundle.preferredOperation,
    data: serveCopy(bundle.data),
    meta: serveCopy(bundle.meta),
  };
}
