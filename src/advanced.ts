/**
 * FootPrint — Advanced / Internal API
 *
 * These exports are for advanced use cases, testing, and building
 * custom execution engines. Most users should use the main 'footprint' entry point.
 *
 * Import via: import { ... } from 'footprint/advanced'
 */

// ============================================================================
// Memory — Low-level transactional state primitives
// ============================================================================

export type {
  CommitBundle,
  FlowControlType,
  FlowMessage,
  MemoryPatch,
  ScopeFactory,
  StageSnapshot,
  TraceEntry,
} from './lib/memory';
export { SharedMemory } from './lib/memory';
export { StageContext } from './lib/memory';
export { EventLog } from './lib/memory';
export { TransactionBuffer } from './lib/memory';
export { DiagnosticCollector } from './lib/memory';
export {
  applySmartMerge,
  deepSmartMerge,
  getNestedValue,
  getRunAndGlobalPaths,
  normalisePath,
  redactPatch,
  setNestedValue,
  updateNestedValue,
  updateValue,
} from './lib/memory';

// ============================================================================
// Builder — Types and internals
// ============================================================================

export type {
  BuildTimeExtractor,
  BuildTimeNodeMetadata,
  ExecOptions,
  FlowChartSpec,
  ILogger,
  PipelineStageFunction,
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
} from './lib/builder';
export { DeciderList, SelectorFnList, specToStageNode } from './lib/builder';

// ============================================================================
// Scope — Providers, protection, recorder options, and event types
// ============================================================================

export type { ProviderResolver, ResolveOptions, ScopeProvider, StageContextLike, StrictMode } from './lib/scope';
export { createErrorMessage, createProtectedScope } from './lib/scope';
export {
  attachBaseStateCompat,
  attachScopeMethods,
  isSubclassOfScopeFacade,
  looksLikeClassCtor,
  looksLikeFactory,
  makeClassProvider,
  makeFactoryProvider,
  registerScopeResolver,
  resolveScopeProvider,
  toScopeFactory,
} from './lib/scope';

// Recorder config/option types
export type {
  AggregatedMetrics,
  DebugEntry,
  DebugRecorderOptions,
  DebugVerbosity,
  DefineScopeOptions,
  NarrativeDetail,
  NarrativeOperation,
  NarrativeRecorderOptions,
  RecorderContext,
  StageEvent,
  StageMetrics,
  StageNarrativeData,
} from './lib/scope';

// Zod internals
export { createScopeProxyFromZod, defineScopeSchema, isScopeSchema, ZodScopeResolver } from './lib/scope';

// ============================================================================
// Runner — Internals
// ============================================================================

export type { NarrativeEntry, RuntimeSnapshot } from './lib/runner';
export { ExecutionRuntime } from './lib/runner';

// ============================================================================
// Engine — DFS graph traversal internals
// ============================================================================

export type { TraverserOptions } from './lib/engine';
export type { Decider } from './lib/engine';
export { FlowchartTraverser } from './lib/engine';
export { isStageNodeReturn } from './lib/engine';

// Narrative internals
export type { IControlFlowNarrative } from './lib/engine';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './lib/engine';
export type {
  BranchResult,
  BranchResults,
  SerializedPipelineStructure as EngineSerializedPipelineStructure,
  StageSnapshot as EngineStageSnapshot,
  ExtractorError,
  HandlerDeps,
  IExecutionRuntime,
  NodeResultType,
  RuntimeStructureMetadata,
  SerializedPipelineNode,
  StageFunction,
  SubflowResult,
  TraversalExtractor,
  TraversalResult,
} from './lib/engine';
export { ControlFlowNarrativeGenerator } from './lib/engine';
export { NullControlFlowNarrativeGenerator } from './lib/engine';

// Handlers (testing / custom engines)
export type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn } from './lib/engine';
export {
  applyOutputMapping,
  ChildrenExecutor,
  computeNodeType,
  ContinuationResolver,
  createSubflowHandlerDeps,
  DeciderHandler,
  DEFAULT_MAX_ITERATIONS,
  ExtractorRunner,
  extractParentScopeValues,
  getInitialScopeValues,
  NodeResolver,
  RuntimeStructureManager,
  seedSubflowGlobalStore,
  SelectorHandler,
  StageRunner,
  SubflowExecutor,
} from './lib/engine';
