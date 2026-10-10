/**
 * footprintjs/trace — recorder stores, topology, chart boundaries and control dependencies.
 *
 * Record readers, types and runtime-ID grammar belong to `foottrace`; record path helpers belong
 * to `foottrace/paths`, and record writers to `foottrace/write`. This door exports only engine-owned
 * observer tools. Record symbols are never re-exported across the package boundary.
 */

export type { WalkerItem, WalkerOptions } from './lib/engine/walkSubflowSpec.js';
export { walkSubflowSpec } from './lib/engine/walkSubflowSpec.js';
export {
  BRANCH_SEGMENT_MARKER,
  buildBranchSegment,
  hasBranchSegmentMarker,
  isBranchSegment,
  parseBranchSegment,
} from './lib/ids/branchSegment.js';
export { BoundaryStateStore } from './lib/recorder/BoundaryStateStore.js';
export type { ControlDecisionRecord, ControlDepRecorderOptions } from './lib/recorder/ControlDepRecorder.js';
export { ControlDepRecorder, controlDepRecorder } from './lib/recorder/ControlDepRecorder.js';
export type { InOutEntry, InOutPhase, InOutRecorderOptions } from './lib/recorder/InOutRecorder.js';
export { InOutRecorder, inOutRecorder, ROOT_RUNTIME_STAGE_ID, ROOT_SUBFLOW_ID } from './lib/recorder/InOutRecorder.js';
export { KeyedStore } from './lib/recorder/KeyedStore.js';
export type { QualityEntry, QualityRecorderOptions, QualityScoringFn } from './lib/recorder/QualityRecorder.js';
export { QualityRecorder } from './lib/recorder/QualityRecorder.js';
export type { QualityFrame, QualityStackTrace } from './lib/recorder/qualityTrace.js';
export { formatQualityTrace, qualityTrace } from './lib/recorder/qualityTrace.js';
export { SequenceStore } from './lib/recorder/SequenceStore.js';
export type {
  Topology,
  TopologyEdge,
  TopologyIncomingKind,
  TopologyNode,
  TopologyRecorderOptions,
} from './lib/recorder/TopologyRecorder.js';
export { TopologyRecorder, topologyRecorder } from './lib/recorder/TopologyRecorder.js';
