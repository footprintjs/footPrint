/**
 * TreeOfFunctionsLib - Public API
 * 
 * This file defines the public interface for library consumers.
 * Internal implementation details are not exported.
 * 
 * Main entry points:
 * - flowChart(): D3-style factory function for building flowcharts (recommended)
 * - FlowChartBuilder: DSL class for building flow charts
 * - FlowChartExecutor: Runtime execution engine
 * - FlowChart: Type representing a compiled flowchart
 * - BaseState: Base class for custom scope implementations
 */

// ============================================================================
// FlowChartBuilder - Primary API for building flows
// ============================================================================

export { 
  FlowChartBuilder,
  // D3-style factory function (recommended entry point)
  flowChart,
  // Types for flow definition
  FlowChartSpec,
  StageFn,
  ParallelSpec,
  BranchBody,
  BranchSpec,
  // FlowChart type (renamed from BuiltFlow)
  FlowChart,
  // Legacy alias for backward compatibility
  BuiltFlow,
  ExecOptions,
  // Fluent helpers returned by builder methods
  DeciderList,
  SelectorList,
  // Utility for BE to convert spec back to StageNode
  specToStageNode,
  // Re-exported for consumers who need the Selector type
  Selector as FlowChartSelector,
  // Build-time extractor types for customizing toSpec() output
  BuildTimeNodeMetadata,
  BuildTimeExtractor,
} from './builder/FlowChartBuilder';

// ============================================================================
// Scope - Base class for custom scope implementations
// ============================================================================

export { BaseState } from './scope/core/BaseState';

export { 
  StageContextLike, 
  ScopeFactory, 
  ScopeProvider, 
  ProviderResolver,
} from './scope/core/types';

// ============================================================================
// Context - Runtime execution context classes
// ============================================================================

// StageContext: Per-stage execution context
export { StageContext, StageSnapshot } from './core/context/StageContext';

// PipelineRuntime: Top-level runtime that manages the execution tree
export { PipelineRuntime, RuntimeSnapshot, NarrativeEntry } from './core/context/PipelineRuntime';

// GlobalStore: Shared state across all stages
export { GlobalStore } from './core/context/GlobalStore';

// StageMetadata: Debug/error info for a stage
export { StageMetadata } from './core/context/StageMetadata';

// ============================================================================
// State Management - Write buffer and execution history
// ============================================================================

// WriteBuffer: Buffered writes before commit
export { WriteBuffer, MemoryPatch } from './core/stateManagement/WriteBuffer';

// ExecutionHistory: Committed state history
export { ExecutionHistory, CommitBundle, TraceItem } from './core/stateManagement/ExecutionHistory';

// ============================================================================
// FlowChartExecutor - Runtime execution engine (recommended)
// ============================================================================

export { 
  FlowChartExecutor,
  // Re-export FlowChart type from executor module as well
  FlowChart as ExecutorFlowChart,
} from './core/pipeline/FlowChartExecutor';

// ============================================================================
// Pipeline - Legacy runtime execution engine (use FlowChartExecutor instead)
// ============================================================================

export { 
  Pipeline, 
  Selector, 
  Decider, 
  StageNode, 
  isStageNodeReturn,
} from './core/pipeline/GraphTraverser';

// Pipeline types for consumers
export { 
  SubflowResult,
  SerializedPipelineNode,
  StageSnapshot as PipelineStageSnapshot,
  TraversalExtractor,
  ExtractorError,
  PipelineStageFunction,
  StreamCallback,
  StreamTokenHandler,
  StreamLifecycleHandler,
  StreamHandlers,
  TreeOfFunctionsResponse,
  PipelineResponse,
  PipelineResponses,
  NodeResultType,
  // Flow control narrative types
  FlowControlType,
  FlowMessage,
} from './core/pipeline/types';

// ============================================================================
// Scope Protection - Prevents direct property assignment on scope objects
// ============================================================================

export {
  createProtectedScope,
  createErrorMessage,
  ScopeProtectionMode,
  ScopeProtectionOptions,
} from './scope/protection';
