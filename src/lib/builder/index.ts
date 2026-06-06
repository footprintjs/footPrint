/* istanbul ignore file */
/**
 * builder/ — Flowchart construction library (zero deps on old code)
 *
 * Fluent API for building StageNode trees and SerializedPipelineStructure.
 * Can be used standalone for building flowchart specs without execution.
 */

// Classes
export { DeciderList, FlowChartBuilder, SelectorFnList } from './FlowChartBuilder.js';

// Factory & utilities
export { flowChart, flowChartSelector, specToStageNode } from './FlowChartBuilder.js';

// Types
export type {
  ExecOptions,
  FlowChart,
  FlowChartOptions,
  FlowChartSpec,
  ILogger,
  ScopeProtectionMode,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  StageFn,
  StageFunction,
  StageNode,
  StreamCallback,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
  SubflowRef,
} from './types.js';
export { ArrayMergeMode } from './types.js';

// ── L7 — Structural observer surface ────────────────────────────────────────
// `StructureRecorder` is the build-time twin of `FlowRecorder`. Together they
// cover both phases of chart life — see `StructureRecorder.ts` JSDoc for the
// architectural rationale (why two interfaces, not one phase-tagged event).
export type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureEdgeKind,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
  StructureSubflowMountedEvent,
} from './structure/StructureRecorder.js';
