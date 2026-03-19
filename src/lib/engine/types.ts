/**
 * types.ts — All type definitions for the engine library.
 *
 * Centralizes type definitions to avoid circular dependencies.
 * Every handler receives HandlerDeps (the DI bag) instead of importing the traverser.
 */

import type { StageContext } from '../memory/StageContext.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import type { Decider, Selector, StageNode } from './graph/StageNode.js';
import type { IControlFlowNarrative } from './narrative/types.js';

// Re-export StageNode types for convenience
export type { Decider, Selector, StageNode } from './graph/StageNode.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Minimal logging contract. Mirrors Console API subset. */
export interface ILogger {
  info(message?: any, ...optionalParams: any[]): void;
  log(message?: any, ...optionalParams: any[]): void;
  debug(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
  warn(message?: any, ...optionalParams: any[]): void;
}

/** Default console-based logger. */
/* istanbul ignore next -- trivial console delegation */
export const defaultLogger: ILogger = {
  info: (message?: any, ...args: any[]) => console.info(message, ...args),
  log: (message?: any, ...args: any[]) => console.log(message, ...args),
  debug: (message?: any, ...args: any[]) => console.debug(message, ...args),
  error: (message?: any, ...args: any[]) => console.error(message, ...args),
  warn: (message?: any, ...args: any[]) => console.warn(message, ...args),
};

// ---------------------------------------------------------------------------
// Stage Function
// ---------------------------------------------------------------------------

/** Callback that receives tokens during streaming. */
export type StreamCallback = (token: string) => void;

/**
 * The function signature for stage handlers.
 * - TOut: return type produced by the stage
 * - TScope: the scope object passed to the stage
 * - Optional 3rd parameter `streamCallback` injected for streaming stages.
 */
export type StageFunction<TOut = any, TScope = any> = (
  scope: TScope,
  breakPipeline: () => void,
  streamCallback?: StreamCallback,
) => Promise<TOut> | TOut;

/** Factory that creates a scope instance for each stage. */
export type ScopeFactory<TScope = any> = (
  context: StageContext,
  stageName: string,
  readOnlyContext?: unknown,
  executionEnv?: ExecutionEnv,
) => TScope;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamTokenHandler = (streamId: string, token: string) => void;
export type StreamLifecycleHandler = (streamId: string, fullText?: string) => void;

export interface StreamHandlers {
  onToken?: StreamTokenHandler;
  onStart?: StreamLifecycleHandler;
  onEnd?: StreamLifecycleHandler;
}

// ---------------------------------------------------------------------------
// Subflow
// ---------------------------------------------------------------------------

export interface SubflowMountOptions<TParentScope = any, TSubflowInput = any, TSubflowOutput = any> {
  inputMapper?: (parentScope: TParentScope) => TSubflowInput;
  outputMapper?: (subflowOutput: TSubflowOutput, parentScope: TParentScope) => Record<string, unknown>;
}

export interface SubflowResult {
  subflowId: string;
  subflowName: string;
  treeContext: {
    globalContext: Record<string, unknown>;
    stageContexts: Record<string, unknown>;
    history: unknown[];
  };
  parentStageId: string;
  pipelineStructure?: unknown;
}

// ---------------------------------------------------------------------------
// Execution Runtime Interface
// ---------------------------------------------------------------------------

/**
 * IExecutionRuntime — Interface for the runtime environment.
 *
 * Defines the contract that engine handlers need from the runner layer,
 * avoiding circular imports between engine/ and runner/.
 */
export interface IExecutionRuntime {
  globalStore: { getState(): Record<string, unknown> };
  rootStageContext: StageContext;
  executionHistory: { list(): unknown[] };
  getSnapshot(): {
    sharedState: Record<string, unknown>;
    executionTree: unknown;
    commitLog: unknown[];
    subflowResults?: Record<string, unknown>;
    recorders?: Array<{ id: string; name: string; data: unknown }>;
  };
  setRootObject(path: string[], key: string, value: unknown): void;
  getPipelines(): string[];
}

// ---------------------------------------------------------------------------
// Execution Environment — read-only, propagates through nested executors
// ---------------------------------------------------------------------------

/**
 * ExecutionEnv — infrastructure values that propagate through nested executors.
 *
 * Like `process.env` for flowcharts: read-only, inherited by child executors,
 * infrastructure-only (not business logic).
 *
 * Litmus test: Created external to the flowchart + passed in for execution = env.
 * Business config for a specific flowchart = args (getArgs()).
 *
 * Intentionally a closed type — not extensible to prevent coupling between
 * parent and child flowcharts.
 */
export interface ExecutionEnv {
  /** AbortSignal for cooperative cancellation across nested executors. */
  readonly signal?: AbortSignal;
  /** Timeout budget in milliseconds. */
  readonly timeoutMs?: number;
  /** Trace identifier for distributed tracing / observability. */
  readonly traceId?: string;
}

// ---------------------------------------------------------------------------
// Handler Dependencies (DI bag) — was PipelineContext
// ---------------------------------------------------------------------------

/**
 * HandlerDeps — Dependency injection bag passed to all handler modules.
 *
 * Provides shared state (stageMap, runtime, scopeFactory, etc.) without
 * handlers needing to import the traverser directly. Avoids circular deps.
 */
export interface HandlerDeps<TOut = any, TScope = any> {
  stageMap: Map<string, StageFunction<TOut, TScope>>;
  root: StageNode<TOut, TScope>;
  executionRuntime: IExecutionRuntime;
  ScopeFactory: ScopeFactory<TScope>;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  throttlingErrorChecker?: (error: unknown) => boolean;
  streamHandlers?: StreamHandlers;
  scopeProtectionMode: ScopeProtectionMode;
  readOnlyContext?: unknown;
  /** Execution environment — propagates to subflows automatically. */
  executionEnv?: ExecutionEnv;
  narrativeGenerator: IControlFlowNarrative;
  logger: ILogger;
  signal?: AbortSignal;
}

/** Options for FlowChartExecutor.run(). */
export interface RunOptions {
  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. Creates an internal AbortController. */
  timeoutMs?: number;
  /**
   * Runtime input data for the pipeline.
   * Becomes the readOnlyContext accessible via `scope.getArgs()`.
   * Stages cannot overwrite these keys with `setValue()`.
   */
  input?: Record<string, unknown>;
  /**
   * Execution environment — read-only infrastructure values that propagate
   * through nested executors (like `process.env` for flowcharts).
   * Accessible via `scope.getEnv()`. Inherited by subflows automatically.
   */
  env?: ExecutionEnv;
}

// ---------------------------------------------------------------------------
// Flow Control Narrative
// ---------------------------------------------------------------------------

export type FlowControlType = 'next' | 'branch' | 'children' | 'selected' | 'subflow' | 'loop';

export interface FlowMessage {
  type: FlowControlType;
  description: string;
  targetStage?: string | string[];
  rationale?: string;
  count?: number;
  iteration?: number;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Traversal Extractor
// ---------------------------------------------------------------------------

export interface RuntimeStructureMetadata {
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  subflowId?: string;
  isSubflowRoot?: boolean;
  subflowName?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  loopTarget?: string;
  isDynamic?: boolean;
  isLoopReference?: boolean;
  streamId?: string;
}

export interface StageSnapshot<TOut = any, TScope = any> {
  node: StageNode<TOut, TScope>;
  context: StageContext;
  stepNumber: number;
  structureMetadata: RuntimeStructureMetadata;
  scopeState?: Record<string, unknown>;
  debugInfo?: {
    logs: Record<string, unknown>;
    errors: Record<string, unknown>;
    metrics: Record<string, unknown>;
    evals: Record<string, unknown>;
    flowMessages?: FlowMessage[];
  };
  stageOutput?: unknown;
  errorInfo?: { type: string; message: string };
  historyIndex?: number;
}

export type TraversalExtractor<TResult = unknown> = (snapshot: StageSnapshot) => TResult | undefined | null;

export interface ExtractorError {
  stagePath: string;
  message: string;
  error: unknown;
}

// ---------------------------------------------------------------------------
// Node Result
// ---------------------------------------------------------------------------

export type NodeResultType = {
  id: string;
  result: unknown;
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// Execution Response
// ---------------------------------------------------------------------------

export type BranchResult = {
  result: string | Error;
  isError: boolean;
};

export type BranchResults = { [branchId: string]: BranchResult };
export type TraversalResult = BranchResults | string | Error;

// ---------------------------------------------------------------------------
// Serialized Pipeline Structure (for visualization)
// ---------------------------------------------------------------------------

export interface SerializedPipelineNode {
  name: string;
  id?: string;
  type?: 'stage' | 'decider' | 'fork' | 'streaming' | 'loop' | 'user' | 'tool' | 'function' | 'sequence';
  description?: string;
  children?: SerializedPipelineNode[];
  next?: SerializedPipelineNode;
  branches?: Record<string, SerializedPipelineNode>;
  hasDecider?: boolean;
  hasSelector?: boolean;
  hasSubtree?: boolean;
  isStreaming?: boolean;
  streamId?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
  loopTarget?: string;
  isLoopReference?: boolean;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  isDynamic?: boolean;
}

// ---------------------------------------------------------------------------
// FlowChart (compiled output of FlowChartBuilder)
// ---------------------------------------------------------------------------

export type FlowChart<TOut = any, TScope = any> = {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, StageFunction<TOut, TScope>>;
  extractor?: TraversalExtractor;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  enrichSnapshots?: boolean;
  enableNarrative?: boolean;
  logger?: ILogger;
  buildTimeStructure?: SerializedPipelineStructure;
  /** Input schema (Zod or JSON Schema) — used for runtime input validation. */
  inputSchema?: unknown;
};

/** Alias for SerializedPipelineNode used as full structure */
export type SerializedPipelineStructure = SerializedPipelineNode & {
  branchIds?: string[];
  subflowStructure?: SerializedPipelineStructure;
  iterationCount?: number;
};
