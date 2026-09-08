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

// Generated branch segments — the subflow path segments `addParallelForEach`
// mints for its branches (`<stageId>~<index>`). A branch is addressed by the
// ORDINARY grammar above, so nothing here is needed to READ one; these exist so
// a consumer can TELL a generated branch from a hand-authored subflow (to label
// it "branch 2 of review-chunks" instead of a subflow name), and so the
// reserved marker is discoverable rather than folklore.
// Design: docs/design/execution-control.md.
export {
  BRANCH_SEGMENT_MARKER,
  buildBranchSegment,
  hasBranchSegmentMarker,
  isBranchSegment,
  parseBranchSegment,
} from './lib/engine/branchSegment.js';

// walkSubflowSpec — flat ordered traversal of a subflow's structure
// (consume via StructureRecorder.onSubflowMounted's subflowSpec payload)
export type { WalkerItem, WalkerOptions } from './lib/engine/walkSubflowSpec.js';
export { walkSubflowSpec } from './lib/engine/walkSubflowSpec.js';

// Commit log queries — typed utilities for backtracking.
// commitValueAt reconstructs the FULL value of a key at a commit index —
// required under `commitValues: 'delta'` (#13c-B), where an `append`
// bundle's `overwrite[key]` holds only the tail.
export {
  buildCommitIndex,
  commitIndexOf,
  commitValueAt,
  findCommit,
  findCommits,
  findLastWriter,
} from './lib/memory/commitLogUtils.js';

// ── time-travel/ — the READER'S cursor over a finished trace ──────────────
// A Trace is what the run recorded; time travel is a cursor over it with a
// Fold at each stop. It is NOT the engine's walk and never becomes a second
// live cursor: everything below is a read-time query over already-collected
// data.
//
// `stateAt(snapshot | subtree, commitIdx)` is the fold — the run's
// `initialState` replayed through `commitLog[0..commitIdx]` with the SAME verb
// switch the live commit uses, returned detached and frozen, and honest about
// how it was derived (`basis`) and where the log was scrubbed (`redacted`).
//
// `timeTravel(snapshot)` is the cursor: stops, prev/next/jumpTo, marks beside
// the log, and `drill(mount)` into a subflow's own log — the same interface,
// its own base. How stops are DERIVED is the seam (`TimeTravelStrategy`);
// footprintjs ships `commitStops` (one stop per executed stage) because that
// is the only stop grammar the substrate itself knows.
// See src/lib/time-travel/README.md.
export type {
  AxisRefusal,
  AxisSplit,
  BookendedAxis,
  FoldBasis,
  FoldedState,
  FoldSource,
  LogGap,
  Mark,
  Move,
  MoveRefusal,
  Stop,
  StopFilter,
  StopKind,
  TimeTravel,
  TimeTravelOptions,
  TimeTravelSource,
  TimeTravelStrategy,
} from './lib/time-travel/index.js';
export {
  commitStops,
  commitStopsStrategy,
  filterStops,
  isCommitBundle,
  splitAxis,
  stateAt,
  timeTravel,
} from './lib/time-travel/index.js';

// Causal chain — backward program slicing on commit log (DAG).
// RFC-003 D3: `CausalEdge` (typed/keyed/weighted parent links on
// `CausalNode.parentEdges`) + the `controlDeps` option (`ControlDepLookup`)
// add control-dependence edges to the slice.
export type {
  CausalChainOptions,
  CausalEdge,
  CausalNode,
  ControlDependency,
  ControlDepLookup,
  EdgeWeigher,
  KeysReadLookup,
} from './lib/memory/backtrack.js';
export { causalChain, flattenCausalDAG, formatCausalChain } from './lib/memory/backtrack.js';
// RFC-003 D2 — honesty markers: the untracked read paths a stage consumed
// (`CommitBundle.untrackedSources` → `CausalNode.incompleteSources`).
export type { UntrackedSource } from './lib/memory/types.js';

// ── slice/ — variable-first slicing, both directions (triage query layer) ──
// One contract for every triage surface (UI panel, LLM tool, offline
// autopsy agent): variable in → slice out.
//
// BACKWARD — `sliceForKey` anchors at the key's last writer then delegates
// to causalChain; `arrayProvenance` / `elementProvenance` (append-fold)
// answer element-level questions like "which stage produced history[7]?" —
// the fix for the agent mega-key problem, with honest attribution labels.
//
// FORWARD — `forwardSliceForKey` walks the other way: from a write, through
// the value's LIVE RANGE (it lives until the key's next write), to every
// stage that read it and every write those reads fed. `keyTimeline` is the
// flat chronological view of the same facts. Fed edges are EXACT under the
// `writeProvenance: 'reads-prefix'` dial and stamped CONSERVATIVE without
// it — never the other way round. See src/lib/slice/README.md.
export type {
  ArrayProvenance,
  AttributionBasis,
  ElementBirth,
  FedBasis,
  ForwardEdge,
  ForwardNode,
  ForwardRead,
  ForwardSlice,
  ForwardSliceJSON,
  HonestyNote,
  HonestyNoteCode,
  KeyMoment,
  KeysReadSource,
  KeyTimeline,
  MissingProvenanceReason,
  MissingSliceReason,
  ReadsCoverage,
  SliceJSON,
  StateKey,
  VariableSlice,
} from './lib/slice/index.js';
export type { ForwardSliceForKeyOptions, KeyTimelineOptions, SliceForKeyOptions } from './lib/slice/index.js';
export {
  arrayProvenance,
  elementProvenance,
  formatForwardSlice,
  formatSlice,
  formatTimeline,
  forwardSliceForKey,
  forwardSliceToJSON,
  keysReadFromExecutionTree,
  keysReadFromMap,
  keyTimeline,
  normaliseStateKey,
  resolveKeysReadSource,
  sliceForKey,
  sliceToJSON,
} from './lib/slice/index.js';

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

// ControlDepRecorder — control-dependence tracking (RFC-003 D5): records
// onDecision/onSelected + the D1 runtime ancestor chain, answers "which
// decision allowed this stage to run?" — the built-in producer for
// causalChain's `controlDeps` option.
export type { ControlDecisionRecord, ControlDepRecorderOptions } from './lib/recorder/ControlDepRecorder.js';
export { ControlDepRecorder, controlDepRecorder } from './lib/recorder/ControlDepRecorder.js';

// QualityRecorder — per-step quality scoring with backtracking
export type { QualityEntry, QualityRecorderOptions, QualityScoringFn } from './lib/recorder/QualityRecorder.js';
export { QualityRecorder } from './lib/recorder/QualityRecorder.js';

// qualityTrace — Quality Stack Trace (backtrack from low-scoring steps)
export type { QualityFrame, QualityStackTrace } from './lib/recorder/qualityTrace.js';
export { formatQualityTrace, qualityTrace } from './lib/recorder/qualityTrace.js';
