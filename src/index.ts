/**
 * FootPrint - Public API
 * 
 * WHY: This file defines the public interface for library consumers.
 * Internal implementation details are not exported.
 * 
 * LAYER STRUCTURE:
 * - core/: Public API (builder, memory, executor)
 * - internal/: Library internals (not exported here)
 * - scope/: Consumer extensibility (BaseState, recorders, providers)
 * - utils/: Shared utilities (not exported here)
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
  // Fluent helpers returned by builder methods
  DeciderList,
  SelectorList,
  // Utility for BE to convert spec back to StageNode
  specToStageNode,
} from './core/builder';

export type {
  // Types for flow definition
  FlowChartSpec,
  StageFn,
  FlowChart,
  ExecOptions,
  // Build-time extractor types for customizing toSpec() output
  BuildTimeNodeMetadata,
  BuildTimeExtractor,
  // Serialized structure for frontend consumption
  SerializedPipelineStructure,
} from './core/builder';

// ============================================================================
// Scope - Base class for custom scope implementations
// ============================================================================

export { BaseState } from './scope/BaseState';

export type { 
  StageContextLike, 
  ScopeFactory, 
  ScopeProvider, 
  ProviderResolver,
} from './scope/providers/types';

// ============================================================================
// Context - Runtime execution context classes (from core/memory)
// ============================================================================

// StageContext: Per-stage execution context
export { StageContext } from './core/memory/StageContext';

// PipelineRuntime: Top-level runtime that manages the execution tree
export { PipelineRuntime } from './core/memory/PipelineRuntime';
export type { RuntimeSnapshot, NarrativeEntry } from './core/memory/PipelineRuntime';

// GlobalStore: Shared state across all stages
export { GlobalStore } from './core/memory/GlobalStore';

// StageMetadata: Debug/error info for a stage
export { StageMetadata } from './core/memory/StageMetadata';

// ============================================================================
// State Management - Write buffer and execution history (from internal/)
// ============================================================================

// WriteBuffer: Buffered writes before commit
export { WriteBuffer } from './internal/memory/WriteBuffer';
export type { MemoryPatch } from './internal/memory/WriteBuffer';

// ExecutionHistory: Committed state history
export { ExecutionHistory } from './internal/history/ExecutionHistory';
export type { CommitBundle, TraceItem } from './internal/history/ExecutionHistory';

// ============================================================================
// FlowChartExecutor - Runtime execution engine (recommended)
// ============================================================================

export {
  FlowChartExecutor,
} from './core/executor/FlowChartExecutor';

// CombinedNarrativeBuilder - Unified flow + step + conditions narrative
export { CombinedNarrativeBuilder } from './core/executor/narrative/CombinedNarrativeBuilder';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './core/executor/narrative/CombinedNarrativeBuilder';

// ============================================================================
// Pipeline - Runtime execution engine
// ============================================================================

export { 
  Pipeline, 
  isStageNodeReturn,
} from './core/executor/Pipeline';

export type {
  Selector, 
  Decider, 
  StageNode, 
} from './core/executor/Pipeline';

// Pipeline types for consumers
export type { 
  SubflowResult,
  SerializedPipelineNode,
  StageSnapshot as PipelineStageSnapshot,
  RuntimeStructureMetadata,
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
  // Subflow input mapping types
  SubflowMountOptions,
} from './core/executor/types';

// StageSnapshot type from StageContext (different from PipelineStageSnapshot)
export type { StageSnapshot } from './core/memory/StageContext';

// SubflowInputMapper helpers for advanced use cases
export {
  extractParentScopeValues,
  getInitialScopeValues,
  seedSubflowGlobalStore,
  applyOutputMapping,
} from './core/executor/handlers/SubflowInputMapper';

// ============================================================================
// Scope Protection - Prevents direct property assignment on scope objects
// ============================================================================

export {
  createProtectedScope,
  createErrorMessage,
} from './scope/protection';

export type {
  ScopeProtectionMode,
  ScopeProtectionOptions,
} from './scope/protection';

// ============================================================================
// Recorders - Pluggable scope observers
// ============================================================================

export { NarrativeRecorder } from './scope/recorders/NarrativeRecorder';
export type { NarrativeOperation, StageNarrativeData, NarrativeDetail, NarrativeRecorderOptions } from './scope/recorders/NarrativeRecorder';

// ============================================================================
// Logger - Pluggable logging interface
// ============================================================================

export type { ILogger } from './utils/logger';
