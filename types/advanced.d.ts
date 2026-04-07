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
export type { CommitBundle, FlowControlType, FlowMessage, MemoryPatch, StageSnapshot, TraceEntry, } from './lib/memory/index.js';
export { SharedMemory } from './lib/memory/index.js';
export { StageContext } from './lib/memory/index.js';
export { EventLog } from './lib/memory/index.js';
export { TransactionBuffer } from './lib/memory/index.js';
export { DiagnosticCollector } from './lib/memory/index.js';
export { applySmartMerge, deepSmartMerge, getNestedValue, getRunAndGlobalPaths, normalisePath, redactPatch, setNestedValue, updateNestedValue, updateValue, } from './lib/memory/index.js';
export type { BuildTimeExtractor, BuildTimeNodeMetadata, ExecOptions, FlowChartSpec, ILogger, ScopeProtectionMode, SerializedPipelineStructure, SimplifiedParallelSpec, StageFn, StageNode, StreamCallback, StreamLifecycleHandler, StreamTokenHandler, SubflowMountOptions, SubflowRef, } from './lib/builder/index.js';
export { ArrayMergeMode, DeciderList, SelectorFnList, specToStageNode } from './lib/builder/index.js';
export { createTypedScopeFactory } from './lib/builder/typedFlowChart.js';
export type { ProviderResolver, ResolveOptions, ScopeProvider, StageContextLike, StrictMode, } from './lib/scope/index.js';
export { createErrorMessage, createProtectedScope, ScopeFacade } from './lib/scope/index.js';
export { attachScopeMethods, isSubclassOfScopeFacade, looksLikeClassCtor, looksLikeFactory, makeClassProvider, makeFactoryProvider, registerScopeResolver, resolveScopeProvider, toScopeFactory, } from './lib/scope/index.js';
export type { AggregatedMetrics, DebugEntry, DebugRecorderOptions, DebugVerbosity, DefineScopeOptions, RecorderContext, StageEvent, StageMetrics, } from './lib/scope/index.js';
export { createScopeProxyFromZod, defineScopeSchema, isScopeSchema, ZodScopeResolver } from './lib/scope/index.js';
export type { RuntimeSnapshot } from './lib/runner/index.js';
export { ExecutionRuntime } from './lib/runner/index.js';
export type { ReactiveOptions, ReactiveTarget } from './lib/reactive/index.js';
export { BREAK_SETTER, buildNestedPatch, createArrayProxy, joinPath, SCOPE_METHOD_NAMES, shouldWrapWithProxy, } from './lib/reactive/index.js';
export type { TraverserOptions } from './lib/engine/index.js';
export type { Decider } from './lib/engine/index.js';
export { FlowchartTraverser } from './lib/engine/index.js';
export { isStageNodeReturn } from './lib/engine/index.js';
export type { IControlFlowNarrative } from './lib/engine/index.js';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './lib/engine/index.js';
export type { BranchResult, BranchResults, SerializedPipelineStructure as EngineSerializedPipelineStructure, StageSnapshot as EngineStageSnapshot, ExtractorError, HandlerDeps, IExecutionRuntime, NodeResultType, RuntimeStructureMetadata, ScopeFactory, SerializedPipelineNode, StageFunction, SubflowResult, TraversalExtractor, TraversalResult, } from './lib/engine/index.js';
export { NullControlFlowNarrativeGenerator } from './lib/engine/index.js';
export type { CallExtractorFn, ExecuteNodeFn, GetStagePathFn, RunStageFn } from './lib/engine/index.js';
export { applyOutputMapping, ChildrenExecutor, computeNodeType, ContinuationResolver, createSubflowHandlerDeps, DeciderHandler, DEFAULT_MAX_ITERATIONS, ExtractorRunner, extractParentScopeValues, getInitialScopeValues, NodeResolver, RuntimeStructureManager, seedSubflowGlobalStore, SelectorHandler, StageRunner, SubflowExecutor, } from './lib/engine/index.js';
