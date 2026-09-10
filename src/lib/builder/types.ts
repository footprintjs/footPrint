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
import type { ILogger, RetryPolicy, ScopeFactory, StageFunction } from '../engine/types.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import type { StructureRecorder } from './structure/StructureRecorder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports from engine (canonical definitions)
// ─────────────────────────────────────────────────────────────────────────────

export type { ResumeFn, StageNode } from '../engine/graph/StageNode.js';
export type {
  BranchChart,
  ILogger,
  ParallelForEachConfig,
  RetryPolicy,
  StageFunction,
  StreamCallback,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
} from '../engine/types.js';
export { ArrayMergeMode } from '../engine/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Relaxed-generic alias for builder ergonomics. */
export type StageFn = StageFunction<any, any>;

// ─────────────────────────────────────────────────────────────────────────────
// Scope Protection — canonical definition in scope/protection/types.ts
// ─────────────────────────────────────────────────────────────────────────────

export type { ScopeProtectionMode };

// ─────────────────────────────────────────────────────────────────────────────
// Serialized Pipeline Structure (JSON-safe, for visualization)
// ─────────────────────────────────────────────────────────────────────────────

export interface SerializedPipelineStructure {
  name: string;
  id: string;
  type: 'stage' | 'decider' | 'selector' | 'fork' | 'streaming' | 'subflow' | 'loop';
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
  /**
   * Nested pipeline structure for a subflow node.
   * WARNING: Any future walker that traverses this field recursively must apply its own
   * depth guard (see MAX_WALK_DEPTH in contract/openapi.ts). The current `buildDescription`
   * walk in openapi.ts does NOT traverse subflowStructure — if it ever does, the depth
   * guard must cover both the `next` chain and this nested structure.
   */
  subflowStructure?: SerializedPipelineStructure;
  iterationCount?: number;
  /** True when this subflow uses lazy resolution (deferred until execution). */
  isLazy?: boolean;
  /** True when this node is a back-edge reference created by loopTo() — not an executable stage. */
  isLoopReference?: boolean;
  /** When true, this stage can pause execution (PausableHandler pattern). */
  isPausable?: boolean;
  /**
   * True for an `addParallelForEach` fan-out — one branch per item, count
   * decided at runtime. A flag, not a type: `type` stays `'fork'` so existing
   * consumers keep rendering it as the fan-out it is.
   */
  isDynamicParallel?: boolean;
  /**
   * Total attempts this stage's function may run, from its declared
   * {@link RetryPolicy}. Present only when a policy was declared — the COUNT
   * only, because `backoffMs` and `retryOn` can be functions and a JSON-safe
   * spec cannot carry those.
   *
   * Read it from the BUILT spec (`chart.buildTimeStructure` / `toSpec()`), not
   * from a `StructureRecorder.onStageAdded` event: the `.retry()` modifier is
   * chained AFTER the stage is added, so the event fires first. That is why
   * there is no `retryAttempts` discriminator on the event payload — it would
   * be `undefined` at fire time for exactly the stages that have a policy.
   */
  retryAttempts?: number;
  /**
   * Declared tags (9.21.0) — the NAMES the author put on this stage at build
   * time, copied as-is (JSON-safe, free strings; footprintjs owns no
   * vocabulary). The Map advertises what a chart CAN produce; the commit
   * bundle (`CommitBundle.tags`) records which a run DID hit. Absent when the
   * stage declares none. Same read-it-from-the-built-spec caveat as
   * `retryAttempts`: `.tag()` is chained AFTER `onStageAdded` fires.
   */
  tags?: readonly string[];
  /**
   * STRUCTURE-ONLY: for a fork/selector/decider branch, the downstream stage
   * id its convergence `next` edge points to, instead of the shared next-stage
   * its siblings converge at. Set from `SubflowMountOptions.convergeAt`; read by
   * `_fireNextEdgeFromParent` to express an unequal-depth merge (e.g. tools →
   * call-llm, bypassing message-api). Visualization-only — runtime convergence
   * is unchanged.
   */
  convergeAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowChartSpec (pure JSON, no functions — for FE→BE transport)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowChartSpec {
  name: string;
  id: string;
  /** Node type — matches `SerializedPipelineStructure.type` for visualization alignment. */
  type?: 'stage' | 'decider' | 'selector' | 'fork' | 'streaming' | 'subflow' | 'loop';
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
  /** True when this node is a back-edge reference created by loopTo() — not an executable stage. */
  isLoopReference?: boolean;
  /** True for an `addParallelForEach` fan-out (`type` stays `'fork'`). */
  isDynamicParallel?: boolean;
  /** Total attempts allowed by this stage's declared retry policy — the count
   *  only (see `SerializedPipelineStructure.retryAttempts`). */
  retryAttempts?: number;
  /** Declared tags on this stage, as-is (see `SerializedPipelineStructure.tags`). */
  tags?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// flowChart() options bag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options-bag argument shape for the `flowChart()` factory.
 */
export interface FlowChartOptions {
  /**
   * Build-time recorders to attach BEFORE `start()` fires. Equivalent
   * to chaining `.attachStructureRecorder(rec)` immediately after the
   * factory returns — but registered EARLIER, so even the seed event
   * fires through the dispatcher without needing the seed-replay path.
   *
   * Multiple recorders attach in array order (same as
   * `.attachStructureRecorder` repeated). See `StructureRecorder` JSDoc
   * for event semantics, ordering invariants, and the trust model.
   */
  structureRecorders?: StructureRecorder[];
  /** Free-form description shown on the root spec node. */
  description?: string;
  /**
   * Only meaningful for `flowChartSelector` (a root selector). When the
   * selector picks ≥2 branches they fan out in parallel: `failFast: true`
   * uses `Promise.all` (first branch error rejects + aborts), the default
   * uses `Promise.allSettled` (best-effort — all branches run even if some
   * fail). Use fail-fast when all selected branches are REQUIRED. Ignored for
   * non-selector charts. Same flag `addSelectorFunction` / `addListOfFunction`
   * expose.
   */
  failFast?: boolean;
  /**
   * Declarative retry policy for the chart's FIRST stage (the one this factory
   * declares). Later stages use the `.retry()` modifier, or the `retry` option
   * at their own declaration site. See {@link RetryPolicy}.
   */
  retry?: RetryPolicy;
  /**
   * Declared tags for the chart's FIRST stage. Later stages use the `.tag()`
   * modifier, or the `tags` option at their own declaration site. A tag is a
   * NAME declared at build time — never a value — and is stamped on every
   * commit bundle the stage records (`CommitBundle.tags`), so a stored
   * recording carries its own milestones. See `FlowChartBuilder.tag`.
   */
  tags?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowChart — compiled output of build()
// ─────────────────────────────────────────────────────────────────────────────

export type FlowChart<TOut = any, TScope = any> = {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, StageFunction<TOut, TScope>>;
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
  /** Declarative retry policy for this fork child. Fork branches are where
   *  flaky I/O usually lives, so each child declares its own. */
  retry?: RetryPolicy;
  /** Declared tags for this fork child — each child's bundle carries its own. */
  tags?: readonly string[];
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
