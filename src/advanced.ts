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
  ReadSummaryMarker,
  ReadTrackingMode,
  RetentionPolicy,
  StageSnapshot,
  TraceEntry,
  UntrackedSource,
  WriteSummaryMarker,
  WriteTrackingMode,
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

// ScopeRecorder config/option types
export type {
  AggregatedMetrics,
  DebugEntry,
  DebugRecorderOptions,
  DebugVerbosity,
  RecorderContext,
  StageEvent,
  StageMetrics,
} from './lib/scope/index.js';
// `DefineScopeOptions` (zod scope options) moved to 'footprintjs/zod'.

// Zod internals moved to the opt-in `footprintjs/zod` entry (keeps zod — an
// optional peer — out of the `footprintjs/advanced` load path). Import
// createScopeProxyFromZod / defineScopeSchema / isScopeSchema / ZodScopeResolver
// from 'footprintjs/zod'.

// ============================================================================
// Runner — Internals
// ============================================================================

export type { RuntimeSnapshot } from './lib/runner/index.js';
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
export { NullControlFlowNarrativeGenerator } from './lib/engine/index.js';

// Handlers (testing / custom engines)
export type { ExecuteNodeFn, RunStageFn } from './lib/engine/index.js';
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
  RuntimeStructureManager,
  seedSubflowGlobalStore,
  SelectorHandler,
  StageRunner,
  SubflowExecutor,
} from './lib/engine/index.js';

// Trace utilities — re-exported here for convenience. Canonical path: 'footprintjs/trace'
export type { ExecutionCounter } from './lib/engine/runtimeStageId.js';
export { buildRuntimeStageId, createExecutionCounter, parseRuntimeStageId } from './lib/engine/runtimeStageId.js';
export { findCommit, findCommits, findLastWriter } from './lib/memory/commitLogUtils.js';

// ============================================================================
// Decide — pure guard evaluation (for custom availability/decision engines)
// ============================================================================
// evaluateFilter is engine-free: a pure function over (getValue, isRedacted)
// callbacks that evaluates a WhereFilter and returns per-condition evidence.
// External drivers (e.g. hcifootprint's available()) evaluate edge guards with
// it outside any run — no scope, no commit, worker-safe.
export type { FilterCondition } from './lib/decide/index.js';
export { evaluateFilter } from './lib/decide/index.js';

// ============================================================================
// Contract — schema normalization (for custom tool emitters)
// ============================================================================
// Pure chart-metadata helpers behind toMCPTool/toOpenAPI. Custom emitters
// (per-edge MCP descriptors) reuse the Zod→JSON-Schema conversion without
// importing the runner. Gate inputs with detectSchema (main barrel): a
// non-Zod 'parseable' schema (yup/superstruct) passes through unconverted.
export { normalizeSchema, zodToJsonSchema } from './lib/contract/index.js';
