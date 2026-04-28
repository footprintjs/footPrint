/**
 * types.ts — All type definitions for the engine library.
 *
 * Centralizes type definitions to avoid circular dependencies.
 * Every handler receives HandlerDeps (the DI bag) instead of importing the traverser.
 */

import type { StageContext } from '../memory/StageContext.js';
import type { FlowControlType, FlowMessage } from '../memory/types.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import type { Decider, Selector, StageNode } from './graph/StageNode.js';
import type { IControlFlowNarrative } from './narrative/types.js';

// Re-export StageNode types for convenience
export type { Decider, Selector, StageNode } from './graph/StageNode.js';

// Re-export pause types from pause/ library
export type { FlowchartCheckpoint, PausableHandler, PauseResult } from '../pause/index.js';
export { isPauseResult, isPauseSignal, PauseSignal } from '../pause/index.js';

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
) => Promise<TOut | void> | TOut | void;

/**
 * Stage function for pausable stages — return value is the pause data (any type).
 * Return non-void to pause, return void to continue normally.
 */
export type PausableStageFunction<TScope = any> = (
  scope: TScope,
  breakPipeline: () => void,
) => Promise<unknown> | unknown;

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

/**
 * Controls how array values from outputMapper are merged into parent scope.
 */
export enum ArrayMergeMode {
  /** Append subflow output to existing parent array: [...existing, ...value]. Default. */
  Concat = 'concat',
  /** Overwrite parent array with subflow output. Use for Dynamic loops. */
  Replace = 'replace',
}

export interface SubflowMountOptions<TParentScope = any, TSubflowInput = any, TSubflowOutput = any> {
  inputMapper?: (parentScope: TParentScope) => TSubflowInput;
  /**
   * Maps subflow output back into parent scope.
   *
   * **Array merge behavior** is controlled by `arrayMerge`:
   * - `'concat'` (default): `[...existing, ...value]` — return only **delta** items
   * - `'replace'`: overwrites the parent value — return the full array
   *
   * Scalar values are always replaced regardless of `arrayMerge`.
   *
   * @example
   * ```typescript
   * // Delta mode (default) — return only new items, concat appends
   * outputMapper: (sf) => ({ messages: sf.newMessages })
   *
   * // Replace mode — return full array, parent value is overwritten
   * // Useful in Dynamic loops where the subflow recomputes the full value each iteration
   * outputMapper: (sf) => ({ toolDescriptions: sf.toolDescriptions }),
   * arrayMerge: ArrayMergeMode.Replace,
   *
   * // Scalars are fine in both modes — always replaced
   * outputMapper: (sf) => ({ status: sf.result, count: sf.total })
   * ```
   */
  outputMapper?: (subflowOutput: TSubflowOutput, parentScope: TParentScope) => Record<string, unknown>;
  /**
   * Controls how array values from outputMapper are merged into parent scope.
   * Applies only to top-level array keys. Nested arrays inside objects
   * always use append (appendToArray) regardless of this setting.
   *
   * @default ArrayMergeMode.Concat
   */
  arrayMerge?: ArrayMergeMode;

  /**
   * When `true`, an inner `scope.$break(reason)` call inside this subflow
   * propagates up to the parent — i.e., the parent's `breakFlag` is set
   * after the subflow exits, terminating the parent's outer loop too.
   *
   * **Default: `false`** (current behaviour — inner break stops only the
   * subflow; parent continues).
   *
   * ## When to use
   *
   * Set `propagateBreak: true` on subflow mounts that represent
   * **terminal** branches — "if this subflow fires, the outer loop is
   * done". Examples:
   *
   * - A human-review runner that takes over from an agent's tool-calling
   *   loop and produces the final response.
   * - A safety-gate subflow that halts the outer workflow when a policy
   *   violation is detected.
   * - An error-recovery subflow that restores state and then terminates.
   *
   * ## Semantics
   *
   * 1. Inside the subflow, a stage calls `scope.$break(reason)`.
   * 2. The subflow's own execution stops (normal `$break` behaviour).
   * 3. `SubflowExecutor` inspects the subflow's exit state. If
   *    `propagateBreak === true` AND the inner break fired, it forwards
   *    the break (and its reason) to the parent's `breakFlag`.
   * 4. The parent traverser sees `shouldBreak` on its next step and exits.
   * 5. A `FlowRecorder.onBreak` event fires at the parent-mount level with
   *    `propagatedFromSubflow` = the subflow's id and the inner reason.
   *
   * ## Parallel/fan-out
   *
   * Follows the existing library rule in `ChildrenExecutor`: the parent
   * breaks only when **every** child of a fork broke. A single
   * `propagateBreak: true` subflow contributing its break to the count
   * does not on its own terminate the parent fan-out.
   *
   * ## outputMapper still runs
   *
   * The subflow's `outputMapper` (if supplied) ALWAYS runs before the
   * break propagates, so the subflow's partial state is still written to
   * the parent scope. This is intentional — the typical use case is an
   * "escalation" subflow whose output IS the final answer that needs to
   * land in the parent scope before the outer loop terminates. If you
   * want to suppress output mapping on break, check the break state
   * inside your `outputMapper` and return `{}` early.
   *
   * @default false
   */
  propagateBreak?: boolean;
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
// Subflow Traverser Factory
// ---------------------------------------------------------------------------

/**
 * SubflowTraverserFactory — Creates a FlowchartTraverser for subflow execution.
 *
 * Injected into SubflowExecutor to break the circular dependency:
 * FlowchartTraverser → SubflowExecutor → FlowchartTraverser.
 *
 * The factory captures parent traverser config (stageMap, scopeFactory, narrative, etc.)
 * in a closure. SubflowExecutor calls it with subflow-specific overrides (root, runtime, input).
 * The returned traverser uses the SAME 7-phase algorithm as the top-level traverser,
 * so deciders, selectors, loops, lazy subflows, and abort signals all work inside subflows.
 */
export type SubflowTraverserFactory<TOut = any, TScope = any> = (options: {
  /** Root node of the subflow (with isSubflowRoot stripped). */
  root: StageNode<TOut, TScope>;
  /** Isolated execution runtime for the subflow. */
  executionRuntime: IExecutionRuntime;
  /** Mapped input from parent scope (becomes readOnlyContext for stages). */
  readOnlyContext?: unknown;
  /** Subflow identifier — used as branchPath for narrative context. */
  subflowId?: string;
}) => SubflowTraverserHandle<TOut, TScope>;

/**
 * Handle returned by SubflowTraverserFactory.
 * Provides execute() + access to nested subflow results.
 */
export interface SubflowTraverserHandle<TOut = any, TScope = any> {
  /** Execute the subflow's graph using the full 7-phase traversal algorithm. */
  execute(): Promise<TraversalResult>;
  /** Collect nested subflow results (from subflows mounted inside this subflow). */
  getSubflowResults(): Map<string, SubflowResult>;
  /**
   * Final break state of the subflow after `execute()` returns.
   *
   *   - `shouldBreak: true`  → a stage inside the subflow called
   *     `scope.$break(reason)`, stopping the subflow's own traversal.
   *   - `reason`             → the optional string passed to `$break`.
   *
   * Used by `SubflowExecutor` to implement `SubflowMountOptions.propagateBreak`:
   * if the mount opts in AND the subflow broke, the parent's break flag is
   * forwarded.
   */
  getBreakState(): { shouldBreak: boolean; reason?: string };
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
  getSnapshot(options?: { redact?: boolean }): {
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
  scopeFactory: ScopeFactory<TScope>;
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
  /**
   * On resume, the per-subflow scope captures from the checkpoint.
   * Keyed by path-prefixed `subflowId` (matches `PauseSignal.subflowPath`).
   *
   * `SubflowExecutor` consults this on entry: if a key matches the
   * current subflow id, the nested runtime is seeded from this state
   * and the inputMapper is SKIPPED (the captured state already
   * reflects post-input pre-pause memory). This is what makes
   * cross-executor resume work for pauses INSIDE a subflow.
   *
   * Undefined on normal `run()` paths — only the resume path sets it.
   */
  subflowStatesForResume?: Record<string, Record<string, unknown>>;
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
  input?: unknown;
  /**
   * Execution environment — read-only infrastructure values that propagate
   * through nested executors (like `process.env` for flowcharts).
   * Accessible via `scope.getEnv()`. Inherited by subflows automatically.
   */
  env?: ExecutionEnv;
  /**
   * Override the maximum recursive `executeNode` depth for this run.
   * Defaults to `FlowchartTraverser.MAX_EXECUTE_DEPTH` (500).
   * Useful when deeply nested subflows or long chains need more headroom.
   * Must be >= 1.
   */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Flow Control Narrative — canonical definitions live in memory/types.ts
// ---------------------------------------------------------------------------

export type { FlowControlType, FlowMessage };

// ---------------------------------------------------------------------------
// Traversal Extractor
// ---------------------------------------------------------------------------

export interface RuntimeStructureMetadata {
  type: 'stage' | 'decider' | 'selector' | 'fork' | 'streaming' | 'subflow' | 'loop';
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

/** Returned by run()/resume() when execution pauses. */
export type PausedResult = {
  readonly paused: true;
  readonly checkpoint: import('../pause/types.js').FlowchartCheckpoint;
};

/** Full return type of FlowChartExecutor.run() and resume(). */
export type ExecutorResult = TraversalResult | PausedResult;

// ---------------------------------------------------------------------------
// Serialized Pipeline Structure (for visualization)
// ---------------------------------------------------------------------------

export interface SerializedPipelineNode {
  name: string;
  id: string;
  type?:
    | 'stage'
    | 'decider'
    | 'selector'
    | 'fork'
    | 'streaming'
    | 'subflow'
    | 'loop'
    | 'user'
    | 'tool'
    | 'function'
    | 'sequence';
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
  /** When true, this stage can pause execution (PausableHandler pattern). */
  isPausable?: boolean;
}

// ---------------------------------------------------------------------------
// FlowChart is defined in `../builder/types.ts`. The engine layer consumes it
// via import from there. A duplicate minimal definition previously lived here
// and caused TS confusion at composition boundaries (ComposableRunner vs
// addSubFlowChart parameter). Single source of truth now lives in builder/.
// ---------------------------------------------------------------------------

/** Alias for SerializedPipelineNode used as full structure */
export type SerializedPipelineStructure = SerializedPipelineNode & {
  branchIds?: string[];
  subflowStructure?: SerializedPipelineStructure;
  iterationCount?: number;
};
