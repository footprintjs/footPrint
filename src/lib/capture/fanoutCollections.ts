/** Parent-owned bounded collections; runtimes are replaced per run/resume, never reconstructed. */
import { type FanoutCollection, type FanoutCollections, privateCollections, referenceBytes } from './subflowHandoff.js';
const stores = new WeakMap<
  object,
  { collections: FanoutCollection[]; items: number; chars: number; partial: boolean }
>();
export function keepCollection(runtime: object, collection: FanoutCollection): void {
  let store = stores.get(runtime);
  if (!store) {
    store = { collections: [], items: 0, chars: 0, partial: false };
    stores.set(runtime, store);
  }
  const refs = [
    collection.parent.address.logRunId,
    ...collection.parent.address.drillPath,
    collection.parent.runtimeStageId,
    collection.parent.path,
    ...collection.slots.flatMap((slot) => [slot.child.address.logRunId, ...slot.child.address.drillPath]),
  ];
  const chars = refs.reduce((sum, name) => sum + referenceBytes(name), 0);
  const items = 1 + collection.slots.length;
  if (store.collections.length >= 128 || store.items + items > 4096 || store.chars + chars > 64 * 1024) {
    store.partial = true;
    // The retained final observation states why the supplied parent view is incomplete.
    const last = store.collections.at(-1);
    if (last)
      store.collections[store.collections.length - 1] = Object.freeze({
        ...last,
        status: 'partial',
        limitations: Object.freeze([...new Set([...last.limitations, 'budget-exhausted' as const])]),
      });
    return;
  }
  store.items += items;
  store.chars += chars;
  store.collections.push(collection);
  store.partial ||= collection.status === 'partial';
}
export function fanoutView(runtime: object, redact = false): FanoutCollections | undefined {
  const store = stores.get(runtime);
  if (!store) return;
  const view: FanoutCollections = Object.freeze({
    version: 1,
    status: store.partial ? 'partial' : 'captured',
    collections: Object.freeze([...store.collections]),
  });
  return redact ? privateCollections(view) : view;
}

/** A resumed leg starts a fresh observation view; earlier snapshots remain immutable. */
export function resetFanoutView(runtime: object): void {
  stores.delete(runtime);
}
