/**
 * footprintjs/advanced — Low-level internals for custom execution engines and testing.
 *
 * Most users never need this. Use `footprintjs` (main) instead.
 * This entry point exposes `SharedMemory`, `StageContext`, `FlowchartTraverser`,
 * and other primitives that power the engine.
 *
 * ```ts
 * import { SharedMemory, StageContext } from 'footprintjs/advanced';
 * ```
 *
 * @module advanced
 */
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
} from './lib/memory/index.js';
export { SharedMemory } from './lib/memory/index.js';
export { StageContext } from './lib/memory/index.js';
export { EventLog } from './lib/memory/index.js';
export { TransactionBuffer } from './lib/memory/index.js';
export { DiagnosticCollector } from './lib/memory/index.js';
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
} from './lib/memory/index.js';

// ============================================================================
// Builder — Types and internals
// ============================================================================

export type {
  BuildTimeExtractor,
  BuildTimeNodeMetadata,
  ExecOptions,
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
export { DeciderList, SelectorFnList, specToStageNode } from './lib/builder/index.js';
export { createTypedScopeFactory, typedFlowChart } from './lib/builder/typedFlowChart.js';

// ============================================================================
// Scope — Providers, protection, recorder options, and event types
// ============================================================================

export type {
  ProviderResolver,
  ResolveOptions,
  ScopeProvider,
  StageContextLike,
  StrictMode,
} from './lib/scope/index.js';
export { createErrorMessage, createProtectedScope } from './lib/scope/index.js';
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
} from './lib/scope/index.js';

// Zod internals
export { createScopeProxyFromZod, defineScopeSchema, isScopeSchema, ZodScopeResolver } from './lib/scope/index.js';

// ============================================================================
// Runner — Internals
// ============================================================================

export type { NarrativeEntry, RuntimeSnapshot } from './lib/runner/index.js';
export { ExecutionRuntime } from './lib/runner/index.js';

// ============================================================================
// Reactive — TypedScope internals (for custom proxy implementations)
// ============================================================================

export type { ReactiveOptions, ReactiveTarget } from './lib/reactive/index.js';
export {
  BREAK_SETTER,
  buildNestedPatch,
  createArrayProxy,
  joinPath,
  SCOPE_METHOD_NAMES,
  shouldWrapWithProxy,
} from './lib/reactive/index.js';

// ============================================================================
// Engine — DFS graph traversal internals
// ============================================================================

export type { TraverserOptions } from './lib/engine/index.js';
export type { Decider } from './lib/engine/index.js';
export { FlowchartTraverser } from './lib/engine/index.js';
export { isStageNodeReturn } from './lib/engine/index.js';

// Narrative internals
export type { IControlFlowNarrative } from './lib/engine/index.js';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './lib/engine/index.js';
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
} from './lib/engine/index.js';
export { ControlFlowNarrativeGenerator } from './lib/engine/index.js';
export { NullControlFlowNarrativeGenerator } from './lib/engine/index.js';

// Handlers (testing / custom engines)
export type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn } from './lib/engine/index.js';
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
} from './lib/engine/index.js';
