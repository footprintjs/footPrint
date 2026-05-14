// ── Stores (concrete, composable — v5 primary API) ────────────────────
// Compose these via `new Store<T>()` as a field on your recorder class.
// One purpose per recorder: stores are storage; recorders are event hooks.
export { BoundaryStateStore } from './BoundaryStateStore.js';
export { KeyedStore } from './KeyedStore.js';
export { SequenceStore } from './SequenceStore.js';

// ── Abstract bases (DEPRECATED — slated for removal in 5.0 final) ─────
// Kept during the v5 migration window for downstream consumers (agentfootprint,
// agentfootprint-lens) that still extend them. New code should compose Stores
// instead. See `docs/design/v5-recorder-redesign.md`.
export { BoundaryStateTracker } from './BoundaryStateTracker.js';
export { KeyedRecorder } from './KeyedRecorder.js';
export { SequenceRecorder } from './SequenceRecorder.js';

// ── Interfaces (event hooks) ──────────────────────────────────────────
export type { CombinedRecorder } from './CombinedRecorder.js';
export { hasEmitRecorderMethods, hasFlowRecorderMethods, hasRecorderMethods, isFlowEvent } from './CombinedRecorder.js';
export type { CompositeSnapshot } from './CompositeRecorder.js';
export { CompositeRecorder } from './CompositeRecorder.js';
export type { EmitEvent, EmitRecorder } from './EmitRecorder.js';
export { RecorderOperation } from './RecorderOperation.js';
