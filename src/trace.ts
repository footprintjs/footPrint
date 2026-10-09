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
export type { CommitIdx, ExecutionCounter, ExecutionIndex, RuntimeStageId } from './lib/ids/runtimeStageId.js';
export {
  buildRuntimeStageId,
  createExecutionCounter,
  parseRuntimeStageId,
  splitStageId,
} from './lib/ids/runtimeStageId.js';

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
} from './lib/ids/branchSegment.js';

// walkSubflowSpec — flat ordered traversal of a subflow's structure
// (consume via StructureRecorder.onSubflowMounted's subflowSpec payload)
export type { WalkerItem, WalkerOptions } from './lib/engine/walkSubflowSpec.js';
export { walkSubflowSpec } from './lib/engine/walkSubflowSpec.js';

// Path segments — the supported way to take a `TraceEntry.path` apart. Paths
// are joined with an ASCII Unit-Separator (never a dot: a state key may itself
// contain a dot, so a dot separator would make `['a.b']` and `['a','b']`
// indistinguishable), which is an encoding, not a display character. Render a
// path through this instead of splitting on the delimiter yourself.
export { pathSegments } from './lib/memory/utils.js';

// The refusal the commit-log readers raise for a row whose verb is not
// set | merge | append | delete (`commitValueAt`, `arrayProvenance`, and
// `applySmartMerge` below): a foreign or corrupted log fails loudly,
// naming the row, instead of being folded as a merge.
export { UnknownVerbError } from './lib/memory/index.js';

// The record's own shapes — one bundle per executed stage (`CommitBundle`), its
// rows (`TraceEntry`) and its value patches (`MemoryPatch`) — and the one fold
// of a bundle onto a state that hands back a fully detached result
// (`applySmartMerge`, the verb law's public door). On `/advanced` before C5;
// a record is WRITTEN through `footprintjs/write`. See docs/guides/record-contract.md.
export type { CommitBundle, MemoryPatch, TraceEntry } from './lib/memory/types.js';
export { applySmartMerge } from './lib/memory/verbs.js';

// Commit log queries — typed utilities for backtracking.
// commitValueAt reconstructs the FULL value of a key at a commit index —
// required under `commitValues: 'delta'` (#13c-B), where an `append`
// bundle's `overwrite[key]` holds only the tail.
export type {
  ValueBasis,
  ValueBasisOptions,
  ValueWithBasis,
  WriterBasis,
  WriterWithBasis,
} from './lib/memory/commitLogUtils.js';
export {
  buildCommitIndex,
  commitIndexOf,
  commitValueAt,
  commitValueAtWithBasis,
  findCommit,
  findCommits,
  findLastWriter,
  findLastWriterWithBasis,
  // One stage, one record (F8, 9.39.0): does a log record its continuations
  // (`CommitBundle.phase`), and — for a log written before it — the ONE legacy
  // reader that infers them the way 9.38.0 did.
  inferLegacyPhases,
  recordsPhases,
} from './lib/memory/commitLogUtils.js';
export type { CommitPhase } from './lib/memory/types.js';

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
// is the only stop grammar the substrate itself knows — and, since 9.21.0,
// `tagStops(tags?)`: the stops a chart DECLARED at build time (`.tag()`),
// read back off `CommitBundle.tags`, so a stored recording scrubs by its own
// milestones with no id conventions in the reader.
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
  tagStops,
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

// ── honesty — the ONE registry of what a reader cannot see ─────────────────
// The honesty signals this door's readers produce — a slice's `HonestyNote.code` and `missing`
// reason, a fed edge's and an element birth's `basis`, a fold's `basis` and `redacted` paths, a
// `LogGap`, a causal node's `incompleteSources` and `truncated` — each has a code here and the ONE
// sentence that says what it means, so a lens or an agent tool explains any of them from one place
// instead of keeping its own table. The unions of those codes exported above (`HonestyNoteCode`,
// `MissingSliceReason`, `MissingProvenanceReason`, `FedBasis`, `AttributionBasis`, `FoldBasis`) are
// subsets of `HonestyCode`, and test/architecture/honesty-vocabulary.test.ts fails on a union of
// string literals this door exports that is neither registered nor named there as a different kind
// of word. See src/lib/memory/README.md.
export type { HonestyCode } from './lib/memory/index.js';
export { HONESTY_CODES } from './lib/memory/index.js';

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
