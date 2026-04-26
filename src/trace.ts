/**
 * footprintjs/trace — Execution tracing, debugging, and backtracking utilities.
 *
 * Runtime stage IDs, commit log queries, and recorder base classes.
 *
 * @example
 * ```typescript
 * import { parseRuntimeStageId, findLastWriter, KeyedRecorder, SequenceRecorder } from 'footprintjs/trace';
 *
 * // Parse a runtimeStageId
 * const { stageId, executionIndex } = parseRuntimeStageId('call-llm#5');
 *
 * // Backtrack: who wrote 'systemPrompt' before stage at idx 8?
 * const writer = findLastWriter(commitLog, 'systemPrompt', 8);
 *
 * // Build a keyed recorder (1:1 — one entry per step)
 * class MyRecorder extends KeyedRecorder<MyEntry> { ... }
 *
 * // Build a sequence recorder (1:N — multiple entries per step, ordering matters)
 * class AuditRecorder extends SequenceRecorder<AuditEntry> { ... }
 * ```
 */

// Runtime stage ID — unique execution step identifiers
export type { ExecutionCounter } from './lib/engine/runtimeStageId.js';
export { buildRuntimeStageId, createExecutionCounter, parseRuntimeStageId } from './lib/engine/runtimeStageId.js';

// Commit log queries — typed utilities for backtracking
export { findCommit, findCommits, findLastWriter } from './lib/memory/commitLogUtils.js';

// Causal chain — backward program slicing on commit log (DAG)
export type { CausalChainOptions, CausalNode, KeysReadLookup } from './lib/memory/backtrack.js';
export { causalChain, flattenCausalDAG, formatCausalChain } from './lib/memory/backtrack.js';

// KeyedRecorder — base class for 1:1 Map-based recorders
export { KeyedRecorder } from './lib/recorder/KeyedRecorder.js';

// SequenceRecorder — base class for 1:N ordered sequence recorders with keyed index
export { SequenceRecorder } from './lib/recorder/SequenceRecorder.js';

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
