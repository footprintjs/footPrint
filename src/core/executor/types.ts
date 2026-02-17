/**
 * types.ts
 *
 * WHY: Defines all types used by the executor module and its handlers.
 * This module centralizes type definitions to avoid circular dependencies
 * and provide a single source of truth for executor-related types.
 *
 * RESPONSIBILITIES:
 * - Define pipeline execution types (PipelineContext, PipelineStageFunction)
 * - Define streaming types (StreamCallback, StreamHandlers)
 * - Define subflow types (SubflowMountOptions, SubflowResult)
 * - Define extractor types (TraversalExtractor, StageSnapshot)
 * - Define flow control narrative types (FlowControlType, FlowMessage)
 *
 * DESIGN DECISIONS:
 * - Types are grouped by concern (subflow, streaming, extractor, etc.)
 * - Generic types use sensible defaults (TOut = any, TScope = any)
 * - Interfaces are preferred over type aliases for extensibility
 *
 * RELATED:
 * - {@link Pipeline} - Uses these types for execution
 * - {@link StageContext} - Referenced by StageSnapshot
 * - {@link PipelineRuntime} - Referenced by PipelineContext
 */

import { StageContext } from '../memory/StageContext';
import { PipelineRuntime } from '../memory/PipelineRuntime';
import { ScopeFactory } from '../memory/types';
import type { StageNode } from './Pipeline';
import { ScopeProtectionMode } from '../../scope/protection/types';
import type { INarrativeGenerator } from './narrative/types';

// ─────────────────────────────────────────────────────────────────────────────
// Subflow Input Mapping Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SubflowMountOptions
 * ------------------------------------------------------------------
 * Options for mounting a subflow via addSubFlowChart methods.
 *
 * WHY: Provides explicit data contracts between parent and subflow,
 * enabling the "Subflow = Pure Function" mental model.
 *
 * ## Mental Model: Subflow = Pure Function
 *
 * A **Subflow** behaves like a **pure function** in programming:
 * - Has its own isolated scope (local variables)
 * - Cannot access parent scope directly (no closure)
 * - Must receive inputs via parameters (`inputMapper`)
 * - Must return outputs via return value (`outputMapper`)
 *
 * DESIGN DECISIONS:
 * - Separation of Concerns: Subflow doesn't know about parent's scope structure
 * - Build-time Definition, Runtime Execution: Mappers defined at build time, executed at runtime
 * - Type Safety: TypeScript generics provide compile-time errors
 * - Testability: Subflows can be tested in isolation with mock inputs
 *
 * @template TParentScope - Type of the parent flow's scope
 * @template TSubflowInput - Type of the initial values for subflow scope
 * @template TSubflowOutput - Type of the subflow's final output
 *
 * _Requirements: subflow-input-mapping 4.1, 4.2, 4.4, 6.4_
 * _Requirements: subflow-scope-isolation 7.1_
 */
export interface SubflowMountOptions<
  TParentScope = any,
  TSubflowInput = any,
  TSubflowOutput = any
> {
  /**
   * Function that extracts data from parent scope to seed subflow's initial scope.
   * Called synchronously before subflow execution begins.
   *
   * @param parentScope - The parent flow's scope object
   * @returns Object of key-value pairs to seed in subflow's GlobalStore
   *
   * _Requirements: subflow-input-mapping 1.4, 2.1_
   */
  inputMapper?: (parentScope: TParentScope) => TSubflowInput;

  /**
   * Function that extracts data from subflow output to write back to parent scope.
   * Called after subflow completes successfully.
   *
   * @param subflowOutput - The subflow's final output value
   * @param parentScope - The parent flow's scope object (for reading context)
   * @returns Object of key-value pairs to write to parent scope
   *
   * _Requirements: subflow-input-mapping 3.4, 3.5_
   */
  outputMapper?: (subflowOutput: TSubflowOutput, parentScope: TParentScope) => Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Context Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PipelineContext
 * ------------------------------------------------------------------
 * Shared context passed to all pipeline modules (NodeResolver, ChildrenExecutor, etc.).
 *
 * WHY: Avoids circular dependencies by providing access to Pipeline internals
 * without direct Pipeline coupling. Enables the modular architecture where
 * each module receives the context it needs.
 *
 * _Requirements: 5.3, 6.6_
 */
export interface PipelineContext<TOut = any, TScope = any> {
  /** Stage function lookup map */
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  /** Root node of the pipeline */
  root: StageNode<TOut, TScope>;
  /** Runtime for context management */
  pipelineRuntime: PipelineRuntime;
  /** Scope factory for creating new scopes */
  ScopeFactory: ScopeFactory<TScope>;
  /** Memoized subflow definitions (key: subflow name, value: subflow root) */
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  /** Function to check if an error is a throttling error */
  throttlingErrorChecker?: (error: unknown) => boolean;
  /** Stream handlers for streaming stages */
  streamHandlers?: StreamHandlers;
  /** Scope protection mode for intercepting direct property assignments */
  scopeProtectionMode: ScopeProtectionMode;
  /** Read-only context passed to scope factory */
  readOnlyContext?: unknown;
  /** Optional traversal extractor function */
  extractor?: TraversalExtractor;
  /** Narrative generator for producing human-readable execution story */
  narrativeGenerator: INarrativeGenerator;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control Narrative Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FlowControlType
 * ------------------------------------------------------------------
 * Types of control flow decisions captured by the execution engine.
 *
 * WHY: These represent the "headings" in the narrative story of pipeline execution,
 * enabling debugging and visualization of flow control decisions.
 *
 * - next: Linear continuation to the next stage
 * - branch: Decider selected a specific branch
 * - children: Fork executing parallel children
 * - selected: Selector chose specific children to run
 * - subflow: Entering or exiting a subflow
 * - loop: Dynamic next looping back to a previous stage
 *
 * _Requirements: flow-control-narrative REQ-1, REQ-2_
 */
export type FlowControlType = 'next' | 'branch' | 'children' | 'selected' | 'subflow' | 'loop';

/**
 * FlowMessage
 * ------------------------------------------------------------------
 * A single flow control narrative entry.
 *
 * WHY: Captures what the execution engine decided and why, enabling
 * debugging and visualization of flow control decisions.
 *
 * @property type - The type of flow control decision
 * @property description - Human-readable description of the decision
 * @property targetStage - The stage(s) being transitioned to
 * @property rationale - Why this decision was made (for deciders)
 * @property count - Number of children/selected (for fork/selector)
 * @property iteration - Loop iteration number (for loops)
 * @property timestamp - When the decision was made
 *
 * _Requirements: flow-control-narrative REQ-1, REQ-2_
 */
export interface FlowMessage {
  type: FlowControlType;
  description: string;
  targetStage?: string | string[];
  rationale?: string;
  count?: number;
  iteration?: number;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StreamCallback
 * ------------------------------------------------------------------
 * A callback function that receives tokens as they are generated during streaming.
 *
 * WHY: Used by streaming stages to emit tokens incrementally to clients,
 * enabling real-time UI updates during LLM generation.
 */
export type StreamCallback = (token: string) => void;

/**
 * StreamTokenHandler
 * ------------------------------------------------------------------
 * A handler function that receives tokens along with their stream identifier.
 *
 * WHY: Used by consumers to route tokens from multiple concurrent streams,
 * enabling parallel streaming stages.
 *
 * @param streamId - Unique identifier for the stream (typically the stage name)
 * @param token - The token string emitted by the streaming stage
 */
export type StreamTokenHandler = (streamId: string, token: string) => void;

/**
 * StreamLifecycleHandler
 * ------------------------------------------------------------------
 * A handler function for stream lifecycle events (start/end).
 *
 * WHY: Called when a streaming stage begins or completes execution,
 * enabling UI state management for streaming stages.
 *
 * @param streamId - Unique identifier for the stream
 * @param fullText - (Optional) The accumulated text, provided on stream end
 */
export type StreamLifecycleHandler = (streamId: string, fullText?: string) => void;

/**
 * StreamHandlers
 * ------------------------------------------------------------------
 * Configuration object for stream event handlers.
 *
 * WHY: Consumers register these handlers via FlowChartBuilder's fluent API
 * to receive streaming events during pipeline execution.
 *
 * @property onToken - Called when a streaming stage emits a token
 * @property onStart - Called when a streaming stage begins execution
 * @property onEnd - Called when a streaming stage completes, with accumulated text
 */
export interface StreamHandlers {
  onToken?: StreamTokenHandler;
  onStart?: StreamLifecycleHandler;
  onEnd?: StreamLifecycleHandler;
}

/**
 * PipelineStageFunction
 * ------------------------------------------------------------------
 * The function signature for pipeline stage handlers.
 *
 * WHY: Defines the contract between the pipeline and stage functions,
 * supporting both sync and async stages with optional streaming.
 *
 * TOut   – return type produced by the stage
 * TScope – the *scope* object passed to the stage
 *
 * The optional third parameter `streamCallback` is automatically injected
 * by Pipeline for stages marked as streaming. Existing stages with
 * the 2-parameter signature `(scope, breakFn)` remain fully compatible.
 *
 * Dynamic behavior: Any stage can return a StageNode (detected via isStageNodeReturn()
 * duck-typing) to define runtime continuations like parallel children or loops.
 */
export type PipelineStageFunction<TOut, TScope> = (
  scope: TScope,
  breakPipeline: () => void,
  streamCallback?: StreamCallback,
) => Promise<TOut> | TOut;

export type NodeResultType = {
  id: string;
  result: unknown;
  isError?: boolean;
};

export type PipelineResponse = {
  result: string | Error;
  isError: boolean;
};

export type PipelineResponses = { [pipelineId: string]: PipelineResponse };

export type TreeOfFunctionsResponse = PipelineResponses | string | Error;

/**
 * SerializedPipelineNode
 * ------------------------------------------------------------------
 * Serialized representation of a pipeline node for frontend consumption.
 *
 * WHY: Used to represent the structure of pipelines and subflows for visualization
 * in debug UIs and flowchart views.
 */
export interface SerializedPipelineNode {
  /** Stage name */
  name: string;
  /** Optional stable ID */
  id?: string;
  /** Node type for frontend rendering */
  type?: 'stage' | 'decider' | 'fork' | 'streaming' | 'loop' | 'user' | 'tool' | 'function' | 'sequence';
  /** Human-readable display name for UI */
  displayName?: string;
  /** Child nodes (for fork patterns) */
  children?: SerializedPipelineNode[];
  /** Next node (for linear continuation) */
  next?: SerializedPipelineNode;
  /** Branch nodes (for decider patterns) */
  branches?: Record<string, SerializedPipelineNode>;
  /** True if node has a decider function */
  hasDecider?: boolean;
  /** True if node has a selector function */
  hasSelector?: boolean;
  /** True if node has a subtree */
  hasSubtree?: boolean;
  /** True if node is a streaming stage */
  isStreaming?: boolean;
  /** Stream identifier for streaming stages */
  streamId?: string;
  /** True if this is the root node of a mounted subflow */
  isSubflowRoot?: boolean;
  /** Mount id of the subflow (e.g., "llm-core") */
  subflowId?: string;
  /** Display name of the subflow (e.g., "LLM Core") */
  subflowName?: string;
  /** Target node ID for loop-back edges */
  loopTarget?: string;
  /** True if this is a reference node (for loop-back) */
  isLoopReference?: boolean;
  /** True if this is a child of a parallel fork */
  isParallelChild?: boolean;
  /** ID of parent fork for parallel execution grouping */
  parallelGroupId?: string;
  /** True if this node has dynamically-added children at runtime */
  isDynamic?: boolean;
}

/**
 * SubflowResult
 * ------------------------------------------------------------------
 * Result of a subflow execution, containing execution data needed for
 * frontend drill-down navigation and debug UI.
 *
 * WHY: When a subflow executes, it runs with its own isolated TreePipelineContext.
 * This result captures the subflow's execution data for storage in the
 * parent stage's metadata and for inclusion in API responses.
 *
 * KEY INSIGHT: Structure is a build-time concern, execution is a runtime concern.
 * - Structure comes from the build-time `subflows` dictionary (via addSubFlowChart)
 * - Execution data comes from the TraversalExtractor (generates stepNumber, etc.)
 * - No need to serialize structure at runtime - it's already known
 *
 * _Requirements: 3.1, 3.2, 4.3, 4.4_
 */
export interface SubflowResult {
  /** Unique subflow ID (e.g., "llm-core", "smart-context-finder") */
  subflowId: string;
  /** Display name for the subflow */
  subflowName: string;
  /** 
   * Tree context with execution data for the subflow's stages.
   * Contains globalContext, stageContexts, and history.
   */
  treeContext: {
    globalContext: Record<string, unknown>;
    stageContexts: Record<string, unknown>;
    history: unknown[];
  };
  /** Parent stage ID that triggered this subflow */
  parentStageId: string;
  /**
   * Build-time pipeline structure for the subflow.
   * WHY: Enables debug UI to render the subflow's flowchart as a nested
   * visualization. Present when the subflow was registered with its
   * buildTimeStructure (e.g., compiled agent FlowCharts).
   */
  pipelineStructure?: unknown;
}

/**
 * RuntimeStructureMetadata
 * ------------------------------------------------------------------
 * Pre-computed structure metadata provided to the TraversalExtractor.
 *
 * WHY: The library computes these values during traversal so consumers don't need
 * to post-process getRuntimeRoot() with their own serialization logic.
 * This eliminates the need for service-layer functions like serializePipelineStructure().
 * 
 * _Requirements: unified-extractor-architecture 3.1, 3.2_
 */
export interface RuntimeStructureMetadata {
  /** Computed node type based on node properties */
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  
  /** Subflow ID - propagated from subflow root to all children within the subflow */
  subflowId?: string;
  
  /** True if this node is the root of a subflow */
  isSubflowRoot?: boolean;
  
  /** Display name of the subflow (for subflow roots) */
  subflowName?: string;
  
  /** True if this node is a parallel child of a fork */
  isParallelChild?: boolean;
  
  /** Parent fork's ID (for parallel children) */
  parallelGroupId?: string;
  
  /** Target stage ID if this node loops back to a previous stage */
  loopTarget?: string;
  
  /** True if this node has dynamically-added children (e.g., toolBranch) */
  isDynamic?: boolean;
  
  /** True if this is a loop-back reference node */
  isLoopReference?: boolean;
  
  /** Streaming stage identifier */
  streamId?: string;
}

/**
 * StageSnapshot
 * ------------------------------------------------------------------
 * Data passed to the traversal extractor for each stage.
 *
 * WHY: Contains only generic library concepts - no domain-specific data.
 * The structureMetadata allows consumers to transform the pipeline structure
 * to their desired format at runtime, eliminating post-processing of getRuntimeRoot().
 * 
 * _Requirements: unified-extractor-architecture 3.2, 4.1, 4.2, 5.3_
 */
export interface StageSnapshot<TOut = any, TScope = any> {
  // ── Existing fields (always present) ──

  /** The node being executed */
  node: StageNode<TOut, TScope>;
  /** The stage's execution context (provides scope, debugInfo, errorInfo) */
  context: StageContext;
  /** 
   * 1-based step number in execution order (for time traveler sync).
   * Increments by 1 for each stage execution, including loop iterations.
   * _Requirements: unified-extractor-architecture 3.1, 3.2, 3.4, 3.5_
   */
  stepNumber: number;
  /**
   * Pre-computed structure metadata for this node.
   * Enables consumers to build serialized structure at runtime without
   * post-processing getRuntimeRoot().
   * _Requirements: unified-extractor-architecture 3.1, 5.3_
   */
  structureMetadata: RuntimeStructureMetadata;

  // ── Enrichment fields (present when enrichSnapshots: true) ──

  /**
   * Snapshot of the committed scope state at this stage's execution point.
   * This is a shallow clone of GlobalStore.getState() taken after commit().
   *
   * WHY: Eliminates the need for PipelineRuntime.getSnapshot() to walk
   * the StageContext linked list to reconstruct scope at each stage.
   * Consumers can build a complete debug structure during traversal
   * without a redundant post-traversal pass.
   *
   * DESIGN: Shallow clone is sufficient because each stage's commit()
   * produces a new top-level object via structural sharing. Deep values
   * are immutable by convention (WriteBuffer enforces this).
   *
   * _Requirements: single-pass-debug-structure 1.1, 2.3_
   */
  scopeState?: Record<string, unknown>;

  /**
   * The stage's accumulated debug metadata (logs, errors, metrics, evals).
   * Captured from StageMetadata at extraction time.
   *
   * WHY: Eliminates the need to walk StageContext.debug after traversal.
   * All debug metadata is captured incrementally during execution,
   * enabling single-pass debug structure construction.
   *
   * _Requirements: single-pass-debug-structure 1.2_
   */
  debugInfo?: {
    logs: Record<string, unknown>;
    errors: Record<string, unknown>;
    metrics: Record<string, unknown>;
    evals: Record<string, unknown>;
    flowMessages?: FlowMessage[];
  };

  /**
   * The stage function's return value.
   * Captured before dynamic stage detection (isStageNodeReturn check).
   * For stages that return a StageNode for dynamic continuation, this is undefined.
   *
   * WHY: Allows consumers to access the stage output during extraction
   * without needing to walk the StageContext linked list post-traversal.
   *
   * _Requirements: single-pass-debug-structure 1.3_
   */
  stageOutput?: unknown;

  /**
   * Error details when the stage threw during execution.
   * Only present when the stage encountered an error.
   *
   * WHY: Captures error information at the point of failure during traversal,
   * so consumers can build error-aware debug structures without a separate
   * error-collection pass.
   *
   * _Requirements: single-pass-debug-structure 1.4_
   */
  errorInfo?: {
    type: string;
    message: string;
  };

  /**
   * Position in the ExecutionHistory at this stage's commit.
   * Can be used to replay history up to this point via
   * ExecutionHistory.materialise(historyIndex).
   *
   * WHY: Enables scope reconstruction at any execution point without
   * a separate history replay pass. Consumers can use this index to
   * materialise the scope state at any stage on demand.
   *
   * DESIGN: This is the count of commits in ExecutionHistory at extraction
   * time — a monotonically increasing non-negative integer that correlates
   * with stepNumber but may diverge (stepNumber counts extractor calls,
   * historyIndex counts commits).
   *
   * _Requirements: single-pass-debug-structure 3.1, 3.2_
   */
  historyIndex?: number;
}

/**
 * TraversalExtractor
 * ------------------------------------------------------------------
 * A user-provided function that extracts and transforms data from each
 * stage as the pipeline executes.
 *
 * WHY: The extractor receives generic library concepts and returns whatever
 * domain-specific data the application needs, enabling flexible data extraction.
 *
 * @template TResult - The type of data returned by the extractor
 * @param snapshot - The stage snapshot containing node and context
 * @returns The extracted data, or undefined/null to skip this stage
 */
export type TraversalExtractor<TResult = unknown> = (
  snapshot: StageSnapshot
) => TResult | undefined | null;

/**
 * ExtractorError
 * ------------------------------------------------------------------
 * Recorded when an extractor throws an error.
 *
 * WHY: Errors are logged but don't stop pipeline execution, enabling
 * graceful degradation when extraction fails.
 */
export interface ExtractorError {
  /** Stage path where the error occurred */
  stagePath: string;
  /** Error message */
  message: string;
  /** Original error object */
  error: unknown;
}
