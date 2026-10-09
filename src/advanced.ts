/** Engine internals: scopes, traversal, frame policy, redaction and contracts. */

export type {
  ExecOptions,
  FlowChartOptions,
  FlowChartSpec,
  ILogger,
  ScopeProtectionMode,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  StageFn,
  StageNode,
  StreamCallback,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
  SubflowRef,
} from './lib/builder/index.js';
export { ArrayMergeMode, DeciderList, SelectorFnList, specToStageNode } from './lib/builder/index.js';
export { createTypedScopeFactory } from './lib/builder/typedFlowChart.js';
export { normalizeSchema, zodToJsonSchema } from './lib/contract/index.js';
export type { FilterCondition } from './lib/decide/index.js';
export { evaluateFilter } from './lib/decide/index.js';
export type { TraverserOptions } from './lib/engine/index.js';
export type { Decider } from './lib/engine/index.js';
export type { IControlFlowNarrative } from './lib/engine/index.js';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './lib/engine/index.js';
export type {
  BranchResult,
  BranchResults,
  SerializedPipelineStructure as EngineSerializedPipelineStructure,
  HandlerDeps,
  IExecutionRuntime,
  NodeResultType,
  RuntimeStructureMetadata,
  ScopeFactory,
  SerializedPipelineNode,
  StageFunction,
  SubflowResult,
  TraversalResult,
} from './lib/engine/index.js';
export type { ExecuteNodeFn, QueuedPause, ResumeHop, RunStageFn } from './lib/engine/index.js';
export { FlowchartTraverser } from './lib/engine/index.js';
export { isStageNodeReturn } from './lib/engine/index.js';
export { NullControlFlowNarrativeGenerator } from './lib/engine/index.js';
export {
  applyOutputMapping,
  ChildrenExecutor,
  computeNodeType,
  ContinuationResolver,
  createSubflowHandlerDeps,
  DeciderHandler,
  DEFAULT_MAX_ITERATIONS,
  extractParentScopeValues,
  getInitialScopeValues,
  NodeResolver,
  ResumeEntry,
  RuntimeStructureManager,
  seedSubflowGlobalStore,
  SelectorHandler,
  StageRunner,
  SubflowExecutor,
} from './lib/engine/index.js';
export type {
  FlowControlType,
  FlowMessage,
  ReadSummaryMarker,
  ReadTrackingMode,
  RetentionPolicy,
  StageSnapshot,
  WriteSummaryMarker,
  WriteTrackingMode,
} from './lib/memory/index.js';
export type { RedactionVerdict } from './lib/memory/index.js';
export type { RunPolicy } from './lib/memory/index.js';
export { StageContext } from './lib/memory/index.js';
export { DiagnosticCollector } from './lib/memory/index.js';
export { RedactionRule } from './lib/memory/index.js';
export { DEFAULT_RUN_POLICY, runPolicy } from './lib/memory/index.js';
export type { ReactiveOptions, ReactiveTarget } from './lib/reactive/index.js';
export {
  buildNestedPatch,
  createArrayProxy,
  isHandle,
  joinPath,
  SCOPE_METHOD_NAMES,
  shouldWrapWithProxy,
  unwrapHandles,
  valueBehind,
} from './lib/reactive/index.js';
export type { RuntimeSnapshot } from './lib/runner/index.js';
export { ExecutionRuntime } from './lib/runner/index.js';
export type {
  ProviderResolver,
  ResolveOptions,
  ScopeProvider,
  StageContextLike,
  StrictMode,
} from './lib/scope/index.js';
export type {
  AggregatedMetrics,
  DebugEntry,
  DebugRecorderOptions,
  DebugVerbosity,
  RecorderContext,
  StageEvent,
  StageMetrics,
} from './lib/scope/index.js';
export { createErrorMessage, createProtectedScope, ScopeFacade } from './lib/scope/index.js';
export {
  attachScopeMethods,
  isSubclassOfScopeFacade,
  looksLikeClassCtor,
  looksLikeFactory,
  makeClassProvider,
  makeFactoryProvider,
  registerScopeResolver,
  resolveScopeProvider,
  toScopeFactory,
} from './lib/scope/index.js';
export type { ScopeRuntime, ScopeRuntimeTarget } from './lib/scope/runtime.js';
export { registerScopeRuntime } from './lib/scope/runtime.js';
