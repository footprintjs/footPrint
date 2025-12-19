/* istanbul ignore file */
/**
 * builder/ — Flowchart construction library (zero deps on old code)
 *
 * Fluent API for building StageNode trees and SerializedPipelineStructure.
 * Can be used standalone for building flowchart specs without execution.
 */

// Classes
export {
  FlowChartBuilder,
  DeciderList,
  SelectorFnList,
} from './FlowChartBuilder';

// Factory & utilities
export { flowChart, specToStageNode } from './FlowChartBuilder';

// Types
export type {
  StageNode,
  PipelineStageFunction,
  StageFn,
  StreamCallback,
  StreamHandlers,
  StreamTokenHandler,
  StreamLifecycleHandler,
  SubflowMountOptions,
  FlowChart,
  FlowChartSpec,
  BuildTimeNodeMetadata,
  BuildTimeExtractor,
  TraversalExtractor,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  ExecOptions,
  SubflowRef,
  ILogger,
  ScopeProtectionMode,
} from './types';
