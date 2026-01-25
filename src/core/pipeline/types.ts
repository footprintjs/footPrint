import { StageContext } from '../context/StageContext';
import { PipelineRuntime } from '../context/PipelineRuntime';
import { ScopeFactory } from '../context/types';
import type { StageNode } from './GraphTraverser';
import { ScopeProtectionMode } from '../../scope/protection/types';

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Context Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PipelineContext
 * ------------------------------------------------------------------
 * Shared context passed to all pipeline modules (NodeResolver, ChildrenExecutor, etc.).
 * Avoids circular dependencies by providing access to Pipeline internals.
 *
 * This interface enables the modular architecture where each module
 * receives the context it needs without direct Pipeline coupling.
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control Narrative Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FlowControlType
 * ------------------------------------------------------------------
 * Types of control flow decisions captured by the execution engine.
 * These represent the "headings" in the narrative story.
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
 * Captures what the execution engine decided and why.
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
 * Used by streaming stages to emit tokens incrementally to clients.
 */
export type StreamCallback = (token: string) => void;

/**
 * StreamTokenHandler
 * ------------------------------------------------------------------
 * A handler function that receives tokens along with their stream identifier.
 * Used by consumers to route tokens from multiple concurrent streams.
 *
 * @param streamId - Unique identifier for the stream (typically the stage name)
 * @param token - The token string emitted by the streaming stage
 */
export type StreamTokenHandler = (streamId: string, token: string) => void;

/**
 * StreamLifecycleHandler
 * ------------------------------------------------------------------
 * A handler function for stream lifecycle events (start/end).
 * Called when a streaming stage begins or completes execution.
 *
 * @param streamId - Unique identifier for the stream
 * @param fullText - (Optional) The accumulated text, provided on stream end
 */
export type StreamLifecycleHandler = (streamId: string, fullText?: string) => void;

/**
 * StreamHandlers
 * ------------------------------------------------------------------
 * Configuration object for stream event handlers.
 * Consumers register these handlers via FlowChartBuilder's fluent API.
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
 * TOut   – return type produced by the stage
 * TScope – the *scope* object passed to the stage
 *
 * The optional third parameter `streamCallback` is automatically injected
 * by Pipeline for stages marked as streaming. Existing stages with
 * the 2-parameter signature `(scope, breakFn)` remain fully compatible.
 *
 * Dynamic behavior: Any stage can return a StageNode (detected via isStageNodeReturn()
 * duck-typing) to define runtime continuations like parallel children or loops.
 * No special flag or builder injection is needed - just return a StageNode from
 * your stage function.
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
 * Used to represent the structure of pipelines and subflows for visualization.
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
 * When a subflow executes, it runs with its own isolated TreePipelineContext.
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
  // REMOVED: pipelineStructure - structure comes from build-time `subflows` dictionary
  // The TraversalExtractor generates stepNumber for each stage (same as main pipeline)
  /** 
   * Tree context with execution data for the subflow's stages.
   * Contains globalContext, stageContexts, and history.
   * The TraversalExtractor generates stepNumber and metadata for each stage.
   */
  treeContext: {
    globalContext: Record<string, unknown>;
    stageContexts: Record<string, unknown>;
    history: unknown[];
  };
  /** Parent stage ID that triggered this subflow */
  parentStageId: string;
}

/**
 * StageSnapshot
 * ------------------------------------------------------------------
 * Data passed to the traversal extractor for each stage.
 * Contains only generic library concepts - no domain-specific data.
 * 
 * _Requirements: unified-extractor-architecture 3.2, 4.1, 4.2_
 */
export interface StageSnapshot<TOut = any, TScope = any> {
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
}

/**
 * TraversalExtractor
 * ------------------------------------------------------------------
 * A user-provided function that extracts and transforms data from each
 * stage as the pipeline executes. The extractor receives generic library
 * concepts and returns whatever domain-specific data the application needs.
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
 * Errors are logged but don't stop pipeline execution.
 */
export interface ExtractorError {
  /** Stage path where the error occurred */
  stagePath: string;
  /** Error message */
  message: string;
  /** Original error object */
  error: unknown;
}
