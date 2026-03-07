/**
 * builder/types.ts — All types used by the builder library.
 *
 * Zero deps on old code. Only imports from lib/memory (Phase 1).
 * Types that originated in executor/Pipeline.ts and executor/types.ts
 * are defined locally here for the new library.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Logger (copied from utils/logger.ts to avoid old-code dep)
// ─────────────────────────────────────────────────────────────────────────────

export interface ILogger {
  info(message?: any, ...optionalParams: any[]): void;
  log(message?: any, ...optionalParams: any[]): void;
  debug(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
  warn(message?: any, ...optionalParams: any[]): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope Protection (copied from scope/protection/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type ScopeProtectionMode = 'error' | 'warn' | 'off';

// ─────────────────────────────────────────────────────────────────────────────
// Stage Function
// ─────────────────────────────────────────────────────────────────────────────

/** Callback for streaming stages to emit tokens incrementally. */
export type StreamCallback = (token: string) => void;

/**
 * The function signature for stage handlers.
 *
 * TOut   – return type produced by the stage
 * TScope – the scope object passed to the stage
 */
export type PipelineStageFunction<TOut = any, TScope = any> = (
  scope: TScope,
  breakPipeline: () => void,
  streamCallback?: StreamCallback,
) => Promise<TOut> | TOut;

/** Relaxed-generic alias for builder ergonomics. */
export type StageFn = PipelineStageFunction<any, any>;

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

export type StreamTokenHandler = (streamId: string, token: string) => void;
export type StreamLifecycleHandler = (streamId: string, fullText?: string) => void;

export interface StreamHandlers {
  onToken?: StreamTokenHandler;
  onStart?: StreamLifecycleHandler;
  onEnd?: StreamLifecycleHandler;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subflow Mount Options
// ─────────────────────────────────────────────────────────────────────────────

export interface SubflowMountOptions<TParentScope = any, TSubflowInput = any, TSubflowOutput = any> {
  inputMapper?: (parentScope: TParentScope) => TSubflowInput;
  outputMapper?: (subflowOutput: TSubflowOutput, parentScope: TParentScope) => Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// StageNode — the runtime graph node
// ─────────────────────────────────────────────────────────────────────────────

export type StageNode<TOut = any, TScope = any> = {
  /** Human-readable stage name; also used as the stageMap key. */
  name: string;
  /** Optional stable id (required by decider/fork aggregation). */
  id?: string;
  /** Human-readable display name for UI. */
  displayName?: string;
  /** Human-readable description of what this stage does. */
  description?: string;

  // ── Continuations ──
  /** Linear continuation. */
  next?: StageNode<TOut, TScope>;
  /** Parallel children (fork). */
  children?: StageNode<TOut, TScope>[];

  // ── Deciders & Selectors ──
  /** When true, fn IS the decider — returns a branch ID string. */
  deciderFn?: boolean;
  /** When true, fn IS the selector — returns branch ID(s). */
  selectorFn?: boolean;

  // ── Stage function ──
  fn?: PipelineStageFunction<TOut, TScope>;

  // ── Streaming ──
  isStreaming?: boolean;
  streamId?: string;

  // ── Subflow ──
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
  $ref?: string;
  mountId?: string;
  subflowMountOptions?: SubflowMountOptions;

  /** When true, parallel children use fail-fast semantics (reject on first error). */
  failFast?: boolean;

  /** Inline subflow definition for dynamic subflow attachment. */
  subflowDef?: {
    root: StageNode;
    stageMap?: Map<string, PipelineStageFunction<TOut, TScope>>;
    buildTimeStructure?: unknown;
    subflows?: Record<string, { root: StageNode }>;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Serialized Pipeline Structure (JSON-safe, for visualization)
// ─────────────────────────────────────────────────────────────────────────────

export interface SerializedPipelineStructure {
  name: string;
  id?: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  displayName?: string;
  description?: string;
  children?: SerializedPipelineStructure[];
  next?: SerializedPipelineStructure;
  hasDecider?: boolean;
  hasSelector?: boolean;
  branchIds?: string[];
  loopTarget?: string;
  isStreaming?: boolean;
  streamId?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
  subflowStructure?: SerializedPipelineStructure;
  iterationCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowChartSpec (pure JSON, no functions — for FE→BE transport)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowChartSpec {
  name: string;
  id?: string;
  displayName?: string;
  description?: string;
  children?: FlowChartSpec[];
  next?: FlowChartSpec;
  hasDecider?: boolean;
  hasSelector?: boolean;
  branchIds?: string[];
  loopTarget?: string;
  isStreaming?: boolean;
  streamId?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build-Time Extractor
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata provided to the build-time extractor for each node. */
export type BuildTimeNodeMetadata = FlowChartSpec;

export type BuildTimeExtractor<TResult = FlowChartSpec> = (metadata: BuildTimeNodeMetadata) => TResult;

// ─────────────────────────────────────────────────────────────────────────────
// Traversal Extractor (runtime)
// ─────────────────────────────────────────────────────────────────────────────

export type TraversalExtractor<TResult = unknown> = (snapshot: unknown) => TResult | undefined | null;

// ─────────────────────────────────────────────────────────────────────────────
// FlowChart — compiled output of build()
// ─────────────────────────────────────────────────────────────────────────────

export type FlowChart<TOut = any, TScope = any> = {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  extractor?: TraversalExtractor;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  buildTimeStructure: SerializedPipelineStructure;
  enableNarrative?: boolean;
  logger?: ILogger;
  description: string;
  stageDescriptions: Map<string, string>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Simplified Parallel Spec (for addListOfFunction)
// ─────────────────────────────────────────────────────────────────────────────

export type SimplifiedParallelSpec<TOut = any, TScope = any> = {
  id: string;
  name: string;
  displayName?: string;
  fn?: PipelineStageFunction<TOut, TScope>;
};

// ─────────────────────────────────────────────────────────────────────────────
// ExecOptions (for execute() convenience — used by runner layer)
// ─────────────────────────────────────────────────────────────────────────────

export type ExecOptions = {
  defaults?: unknown;
  initial?: unknown;
  readOnly?: unknown;
  throttlingErrorChecker?: (e: unknown) => boolean;
  scopeProtectionMode?: ScopeProtectionMode;
  enableNarrative?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// SubflowRef
// ─────────────────────────────────────────────────────────────────────────────

export interface SubflowRef {
  $ref: string;
  mountId: string;
  displayName?: string;
}
