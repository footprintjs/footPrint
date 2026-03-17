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
export { flowChart, specToStageNode } from './FlowChartBuilder.js';

// Types
export type {
  BuildTimeExtractor,
  BuildTimeNodeMetadata,
  ExecOptions,
  FlowChart,
  FlowChartSpec,
  ILogger,
  PipelineStageFunction,
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
  TraversalExtractor,
} from './types.js';
