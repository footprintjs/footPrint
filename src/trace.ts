/**
 * footprintjs/trace — Execution tracing, debugging, and backtracking utilities.
 *
 * Runtime stage IDs, commit log queries, and recorder base classes.
 *
 * @example
 * ```typescript
 * import { parseRuntimeStageId, findLastWriter, KeyedStore, SequenceStore } from 'footprintjs/trace';
 *
 * // Parse a runtimeStageId
 * const { stageId, executionIndex } = parseRuntimeStageId('call-llm#5');
 *
 * // Backtrack: who wrote 'systemPrompt' before commit at idx 8?
 * const writer = findLastWriter(commitLog, 'systemPrompt', 8);
 *
 * // v5 primary API: compose a Store as a field (one purpose per recorder).
 * // KeyedStore<T> — 1:1 (one entry per step)
 * class MyRecorder {
 *   readonly id = 'my-recorder';
 *   private store = new KeyedStore<MyEntry>();
 *   onWrite(e) { this.store.set(e.runtimeStageId, { ... }); }
 * }
 *
 * // SequenceStore<T> — 1:N (multiple entries per step, ordering matters)
 * class AuditRecorder {
 *   readonly id = 'audit';
 *   private store = new SequenceStore<AuditEntry>();
 *   onRead(e) { this.store.push({ runtimeStageId: e.runtimeStageId, ... }); }
 * }
 * ```
 */

// Runtime stage ID — unique execution step identifiers
export type { ExecutionCounter } from './lib/engine/runtimeStageId.js';
export {
  buildRuntimeStageId,
  createExecutionCounter,
  parseRuntimeStageId,
  splitStageId,
} from './lib/engine/runtimeStageId.js';

// walkSubflowSpec — flat ordered traversal of a subflow's structure
// (consume via StructureRecorder.onSubflowMounted's subflowSpec payload)
export type { WalkerItem, WalkerOptions } from './lib/engine/walkSubflowSpec.js';
export { walkSubflowSpec } from './lib/engine/walkSubflowSpec.js';

// Commit log queries — typed utilities for backtracking
export { findCommit, findCommits, findLastWriter } from './lib/memory/commitLogUtils.js';

// Causal chain — backward program slicing on commit log (DAG)
export type { CausalChainOptions, CausalNode, KeysReadLookup } from './lib/memory/backtrack.js';
export { causalChain, flattenCausalDAG, formatCausalChain } from './lib/memory/backtrack.js';

// ── v5 Stores (concrete, composable — primary recorder API) ─────
// Compose these via `new Store<T>()` as a field on your recorder
// class. One purpose per recorder: stores are storage; recorders
// are event-hook interface implementations.
export { BoundaryStateStore } from './lib/recorder/BoundaryStateStore.js';
export { KeyedStore } from './lib/recorder/KeyedStore.js';
export { SequenceStore } from './lib/recorder/SequenceStore.js';

// ── v5.1 Commit grouping primitive ──────────────────────────────
// Interval index over commit indices. Built incrementally during
// traversal: open() on boundary entry, close() on exit. Query at any
// commit position with enclosing()/overlapping(). Generic over TLabel
// — footprintjs owns ZERO knowledge of what consumers use as labels.
// See docs/design/commit-range-index.md for the full contract.
export type { RangeEntry, RangeToken } from './lib/recorder/CommitRangeIndex.js';
export { CommitRangeIndex } from './lib/recorder/CommitRangeIndex.js';

// ── Abstract bases (DEPRECATED in v5 — slated for removal) ───────
// Kept during the v5 migration window for downstream consumers
// (agentfootprint, agentfootprint-lens, etc.) that still extend
// them. Migrate to the corresponding Store class above.
// KeyedRecorder — base class for 1:1 Map-based recorders
export { KeyedRecorder } from './lib/recorder/KeyedRecorder.js';

// SequenceRecorder — base class for 1:N ordered sequence recorders with keyed index
export { SequenceRecorder } from './lib/recorder/SequenceRecorder.js';

// BoundaryStateTracker — base class for transient bracket-scoped state
// (live state DURING a matched [start, stop] event interval; clears on stop)
export { BoundaryStateTracker } from './lib/recorder/BoundaryStateTracker.js';

// TopologyRecorder — composition graph accumulator (subflows + control-flow edges)
export type {
  Topology,
  TopologyEdge,
  TopologyIncomingKind,
  TopologyNode,
  TopologyRecorderOptions,
} from './lib/recorder/TopologyRecorder.js';
export { TopologyRecorder, topologyRecorder } from './lib/recorder/TopologyRecorder.js';

// InOutRecorder — chart in/out stream (entry/exit pairs at every chart boundary,
// including the top-level run and every subflow)
export type { InOutEntry, InOutPhase, InOutRecorderOptions } from './lib/recorder/InOutRecorder.js';
export { InOutRecorder, inOutRecorder, ROOT_RUNTIME_STAGE_ID, ROOT_SUBFLOW_ID } from './lib/recorder/InOutRecorder.js';

// QualityRecorder — per-step quality scoring with backtracking
export type { QualityEntry, QualityRecorderOptions, QualityScoringFn } from './lib/recorder/QualityRecorder.js';
export { QualityRecorder } from './lib/recorder/QualityRecorder.js';

// qualityTrace — Quality Stack Trace (backtrack from low-scoring steps)
export type { QualityFrame, QualityStackTrace } from './lib/recorder/qualityTrace.js';
export { formatQualityTrace, qualityTrace } from './lib/recorder/qualityTrace.js';
