/**
 * builder/types.ts — All types used by the builder library.
 *
 * Shared types (StageNode, StageFunction, etc.) are imported from the engine.
 * Builder-specific types (FlowChartSpec, FlowChart, SerializedPipelineStructure)
 * are defined locally — they carry builder-only fields (description, outputMapper, etc.).
 *
 * NOTE: All engine imports are `import type` — zero runtime dependency.
 * The builder remains standalone at runtime.
 */

import type { StageNode } from '../engine/graph/StageNode.js';
import type { ILogger, ScopeFactory, StageFunction } from '../engine/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports from engine (canonical definitions)
// ─────────────────────────────────────────────────────────────────────────────

export type { StageNode } from '../engine/graph/StageNode.js';
export type {
  ILogger,
  StageFunction,
  StreamCallback,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
} from '../engine/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Relaxed-generic alias for builder ergonomics. */
export type StageFn = StageFunction<any, any>;

// ─────────────────────────────────────────────────────────────────────────────
// Scope Protection
// ─────────────────────────────────────────────────────────────────────────────

export type ScopeProtectionMode = 'error' | 'warn' | 'off';

// ─────────────────────────────────────────────────────────────────────────────
// Serialized Pipeline Structure (JSON-safe, for visualization)
// ─────────────────────────────────────────────────────────────────────────────

export interface SerializedPipelineStructure {
  name: string;
  id?: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  /** Semantic icon hint for visualization (e.g., "llm", "tool", "rag", "agent", "start") */
  icon?: string;
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
  /** True when this subflow uses lazy resolution (deferred until execution). */
  isLazy?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowChartSpec (pure JSON, no functions — for FE→BE transport)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowChartSpec {
  name: string;
  id?: string;
  /** Semantic icon hint for visualization (e.g., "llm", "tool", "rag", "agent", "start") */
  icon?: string;
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
  stageMap: Map<string, StageFunction<TOut, TScope>>;
  extractor?: TraversalExtractor;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  buildTimeStructure: SerializedPipelineStructure;
  enableNarrative?: boolean;
  logger?: ILogger;
  description: string;
  stageDescriptions: Map<string, string>;
  /** Input schema (Zod or JSON Schema) — declared via setInputSchema() or .contract(). */
  inputSchema?: unknown;
  /** Output schema (Zod or JSON Schema) — declared via setOutputSchema() or .contract(). */
  outputSchema?: unknown;
  /** Output mapper — extracts response from final scope. */
  outputMapper?: (finalScope: Record<string, unknown>) => unknown;
  /** Scope factory — auto-embedded by flowChart<T>(). Executor reads this if no factory param. */
  scopeFactory?: ScopeFactory<TScope>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Simplified Parallel Spec (for addListOfFunction)
// ─────────────────────────────────────────────────────────────────────────────

export type SimplifiedParallelSpec<TOut = any, TScope = any> = {
  id: string;
  name: string;
  fn?: StageFunction<TOut, TScope>;
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
}
