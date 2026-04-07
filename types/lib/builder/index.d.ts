/**
 * builder/ — Flowchart construction library (zero deps on old code)
 *
 * Fluent API for building StageNode trees and SerializedPipelineStructure.
 * Can be used standalone for building flowchart specs without execution.
 */
export { DeciderList, FlowChartBuilder, SelectorFnList } from './FlowChartBuilder.js';
export { flowChart, specToStageNode } from './FlowChartBuilder.js';
export type { BuildTimeExtractor, BuildTimeNodeMetadata, ExecOptions, FlowChart, FlowChartSpec, ILogger, ScopeProtectionMode, SerializedPipelineStructure, SimplifiedParallelSpec, StageFn, StageFunction, StageNode, StreamCallback, StreamHandlers, StreamLifecycleHandler, StreamTokenHandler, SubflowMountOptions, SubflowRef, TraversalExtractor, } from './types.js';
export { ArrayMergeMode } from './types.js';
