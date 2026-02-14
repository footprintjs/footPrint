/**
 * Core Module - Barrel Export
 *
 * WHY: This barrel export provides a single entry point for all core public API
 * exports. The core module contains the primary building blocks for constructing
 * and executing flowchart-based pipelines.
 *
 * LAYER: Public API
 * Consumers should import from this module for all core functionality.
 *
 * SUBMODULES:
 * - builder/: FlowChartBuilder for constructing flowcharts
 * - memory/: StageContext, GlobalStore, PipelineRuntime for state management
 * - executor/: FlowChartExecutor, Pipeline for execution
 */

// ─────────────────────────── Builder Module ───────────────────────────
export {
  FlowChartBuilder,
  DeciderList,
  SelectorList,
  flowChart,
  specToStageNode,
} from './builder';

export type {
  FlowChartSpec,
  BuildTimeNodeMetadata,
  BuildTimeExtractor,
  SimplifiedParallelSpec,
  SerializedPipelineStructure,
  FlowChart,
  ExecOptions,
  BuiltFlow,
  StageFn,
  ParallelSpec,
  BranchBody,
  BranchSpec,
  SubflowRef,
} from './builder';

// ─────────────────────────── Memory Module ───────────────────────────
export {
  StageContext,
  GlobalStore,
  PipelineRuntime,
  StageMetadata,
} from './memory';

export type {
  ScopeFactory,
  RuntimeSnapshot,
} from './memory';

// ─────────────────────────── Executor Module ───────────────────────────
export {
  FlowChartExecutor,
  Pipeline,
  isStageNodeReturn,
} from './executor';

export type {
  StageNode,
  Decider,
  Selector,
  PipelineStageFunction,
  StreamHandlers,
  StreamTokenHandler,
  StreamLifecycleHandler,
  TreeOfFunctionsResponse,
  PipelineResponse,
  PipelineResponses,
  SubflowResult,
  RuntimeStructureMetadata,
  StageSnapshot,
  TraversalExtractor,
  ExtractorError,
  SubflowMountOptions,
  PipelineContext,
  FlowControlType,
  FlowMessage,
} from './executor';

// Narrative generation
export {
  NarrativeGenerator,
  NullNarrativeGenerator,
} from './executor';

export type {
  INarrativeGenerator,
} from './executor';

// Re-export handlers for advanced use cases
export {
  StageRunner,
  NodeResolver,
  ChildrenExecutor,
  SubflowExecutor,
  LoopHandler,
  DeciderHandler,
  // SubflowInputMapper functions
  extractParentScopeValues,
  getInitialScopeValues,
  createSubflowPipelineContext,
  seedSubflowGlobalStore,
  applyOutputMapping,
} from './executor/handlers';
