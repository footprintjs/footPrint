// ── Stores (concrete, composable — v5 primary API) ────────────────────
// Compose these via `new Store<T>()` as a field on your recorder class.
// One purpose per recorder: stores are storage; recorders are event hooks.
export { BoundaryStateStore } from './BoundaryStateStore.js';
export { KeyedStore } from './KeyedStore.js';
export { SequenceStore } from './SequenceStore.js';

// ── Interfaces (event hooks) ──────────────────────────────────────────
export type { CombinedRecorder } from './CombinedRecorder.js';
export { hasEmitRecorderMethods, hasFlowRecorderMethods, hasRecorderMethods, isFlowEvent } from './CombinedRecorder.js';
export type { CompositeSnapshot } from './CompositeRecorder.js';
export { CompositeRecorder } from './CompositeRecorder.js';
export type { EmitEvent, EmitRecorder } from './EmitRecorder.js';
export { RecorderOperation } from './RecorderOperation.js';
