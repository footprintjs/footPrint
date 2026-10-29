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
 * one line here. The four `toSnapshot?()` signatures (`ScopeRecorder`, `FlowRecorder`,
 * `CombinedRecorder`, and `EmitRecorder`) all name `RecorderBundle`, so they follow.
 */

import { copyCaptureAcknowledgement } from '../capture/nativeCoverage.js';
import type { RecorderSnapshot } from '../runner/ExecutionRuntime.js';

/** A snapshot row without the `id` the attach site owns. */
type BundleFields = Omit<RecorderSnapshot, 'id'>;

/**
 * What `toSnapshot()` returns: the row's fields, where each OPTIONAL member also takes an
 * explicit `undefined` (required members are unchanged).
 *
 * A declaration emitted without `exactOptionalPropertyTypes` (this library's own build, for one)
 * spells an inferred optional member as `capture?: … | undefined`, and an app compiled WITH the
 * flag must still be able to attach that recorder. `copyBundle` copies field by field, so an
 * explicit `undefined` gives the same row as an absent key. The row, `RecorderSnapshot`, is unchanged.
 */
export type RecorderBundle = {
  [K in keyof BundleFields]: Pick<BundleFields, K> extends Required<Pick<BundleFields, K>>
    ? BundleFields[K]
    : BundleFields[K] | undefined;
};

/** Rebuild `bundle` as the snapshot row for the recorder attached under `id`. */
export function copyBundle(id: string, bundle: RecorderBundle, includeCapture = false): RecorderSnapshot {
  const capture = includeCapture
    ? copyCaptureAcknowledgement(Object.getOwnPropertyDescriptor(bundle, 'capture')?.value)
    : undefined;
  return {
    id,
    name: bundle.name,
    description: bundle.description,
    preferredOperation: bundle.preferredOperation,
    data: bundle.data,
    meta: bundle.meta,
    ...(capture && { capture }),
  };
}
