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

export { SharedMemory } from './lib/memory';
export { StageContext } from './lib/memory';
export { EventLog } from './lib/memory';
export { TransactionBuffer } from './lib/memory';
export { DiagnosticCollector } from './lib/memory';

export type {
  MemoryPatch,
  TraceEntry,
  CommitBundle,
  FlowControlType,
  FlowMessage,
  StageSnapshot,
  ScopeFactory,
} from './lib/memory';

export {
  deepSmartMerge,
  applySmartMerge,
  normalisePath,
  redactPatch,
  getNestedValue,
  setNestedValue,
  updateNestedValue,
  updateValue,
  getRunAndGlobalPaths,
} from './lib/memory';

// ============================================================================
// Builder — Types and internals
// ============================================================================

export { DeciderList, SelectorFnList, specToStageNode } from './lib/builder';

export type {
  FlowChartSpec,
  StageFn,
  PipelineStageFunction,
  ExecOptions,
  BuildTimeNodeMetadata,
  BuildTimeExtractor,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  SubflowRef,
  StageNode,
  SubflowMountOptions,
  ScopeProtectionMode,
  StreamCallback,
  StreamTokenHandler,
  StreamLifecycleHandler,
  ILogger,
} from './lib/builder';

// ============================================================================
// Scope — Providers, protection, recorder options, and event types
// ============================================================================

export { createProtectedScope, createErrorMessage } from './lib/scope';

export {
  toScopeFactory,
  registerScopeResolver,
  resolveScopeProvider,
  looksLikeClassCtor,
  looksLikeFactory,
  isSubclassOfScopeFacade,
  makeFactoryProvider,
  makeClassProvider,
  attachScopeMethods,
  attachBaseStateCompat,
} from './lib/scope';

export type {
  StageContextLike,
  ScopeProvider,
  ProviderResolver,
  StrictMode,
  ResolveOptions,
} from './lib/scope';

// Recorder config/option types
export type {
  StageMetrics,
  AggregatedMetrics,
  DebugEntry,
  DebugVerbosity,
  DebugRecorderOptions,
  NarrativeDetail,
  NarrativeOperation,
  StageNarrativeData,
  NarrativeRecorderOptions,
  RecorderContext,
  StageEvent,
  DefineScopeOptions,
} from './lib/scope';

// Zod internals
export { defineScopeSchema, isScopeSchema, createScopeProxyFromZod, ZodScopeResolver } from './lib/scope';

// ============================================================================
// Runner — Internals
// ============================================================================

export { ExecutionRuntime } from './lib/runner';
export type { RuntimeSnapshot, NarrativeEntry } from './lib/runner';

// ============================================================================
// Engine — DFS graph traversal internals
// ============================================================================

export { FlowchartTraverser } from './lib/engine';
export type { TraverserOptions } from './lib/engine';
export type { Decider } from './lib/engine';
export { isStageNodeReturn } from './lib/engine';

// Narrative internals
export { ControlFlowNarrativeGenerator } from './lib/engine';
export { NullControlFlowNarrativeGenerator } from './lib/engine';
export type { IControlFlowNarrative } from './lib/engine';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './lib/engine';

export type {
  TraversalResult,
  BranchResult,
  BranchResults,
  SubflowResult,
  HandlerDeps,
  IExecutionRuntime,
  StageFunction,
  NodeResultType,
  RuntimeStructureMetadata,
  StageSnapshot as EngineStageSnapshot,
  TraversalExtractor,
  ExtractorError,
  SerializedPipelineNode,
  SerializedPipelineStructure as EngineSerializedPipelineStructure,
} from './lib/engine';

// Handlers (testing / custom engines)
export {
  StageRunner,
  NodeResolver,
  ChildrenExecutor,
  DeciderHandler,
  SelectorHandler,
  ContinuationResolver,
  DEFAULT_MAX_ITERATIONS,
  SubflowExecutor,
  extractParentScopeValues,
  getInitialScopeValues,
  createSubflowHandlerDeps,
  seedSubflowGlobalStore,
  applyOutputMapping,
  ExtractorRunner,
  RuntimeStructureManager,
  computeNodeType,
} from './lib/engine';

export type { ExecuteNodeFn, RunStageFn, CallExtractorFn, GetStagePathFn } from './lib/engine';
