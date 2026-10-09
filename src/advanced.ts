/**
 * footprintjs/advanced — Low-level internals for custom execution engines and testing.
 *
 * Most users never need this. Use `footprintjs` (main) instead.
 * This entry point exposes the engine's frame (`StageContext`), the traverser
 * (`FlowchartTraverser`), the scope providers and the other primitives that
 * power the engine. The record has doors of its own: write one with
 * `footprintjs/write` (`SharedMemory`, `EventLog`, `RecordFrame`), read one
 * with `footprintjs/trace` (`CommitBundle`, `applySmartMerge`, the readers).
 *
 * ```ts
 * import { StageContext } from 'footprintjs/advanced';
 * import { SharedMemory } from 'footprintjs/write';
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
// Memory — the engine's frame, its run policy and the redaction verdict
// ============================================================================
// The record itself is not here: `SharedMemory`, `EventLog` and `RecordFrame` are on
// `footprintjs/write`; `CommitBundle`, `TraceEntry`, `MemoryPatch`, `applySmartMerge` and the
// log readers are on `footprintjs/trace` (C5).

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
export { StageContext } from './lib/memory/index.js';
export { DiagnosticCollector } from './lib/memory/index.js';
export { RedactionRule } from './lib/memory/index.js';

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
export type { ScopeRuntime, ScopeRuntimeTarget } from './lib/scope/runtime.js';
export { registerScopeRuntime } from './lib/scope/runtime.js';

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
/** The run's policy an `ExecutionRuntime` is constructed with (F5). */
export type { RunPolicy } from './lib/memory/index.js';
export { DEFAULT_RUN_POLICY, runPolicy } from './lib/memory/index.js';

// ============================================================================
// Reactive — TypedScope internals (for custom proxy implementations)
// ============================================================================

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
export type { ExecuteNodeFn, QueuedPause, ResumeHop, RunStageFn } from './lib/engine/index.js';
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
