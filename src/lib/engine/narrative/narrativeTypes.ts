/**
 * narrativeTypes — Shared type definitions for the narrative recorder system.
 *
 * Previously: CombinedNarrativeBuilder.ts (file renamed in post-release cleanup).
 * The CombinedNarrativeBuilder class was removed in v1.0.
 * Use CombinedNarrativeRecorder (auto-attached by setEnableNarrative()) instead.
 */

import type { AttemptRecord } from '../../attempt/types.js';

// ---------------------------------------------------------------------------
// Types (kept — used by CombinedNarrativeRecorder, FlowChartExecutor, etc.)
// ---------------------------------------------------------------------------

export interface CombinedNarrativeEntry {
  type:
    | 'stage'
    | 'step'
    | 'condition'
    | 'fork'
    | 'selector'
    | 'subflow'
    | 'loop'
    | 'break'
    | 'error'
    | 'pause'
    | 'resume'
    | 'emit'
    /** A failed attempt that was retried — rendered by 9.15–10.0 only. Since
     *  10.1 the built-in narrative renders one `'attempt'` line per attempt
     *  instead; the member stays so a narrative stored by an earlier release
     *  still type-checks. */
    | 'retry'
    /** One attempt of a stage with a declared retry policy (10.1): its outcome,
     *  duration, cause and decision. A depth-1 sub-item of its stage, IN ORDER
     *  between the attempts' reads and writes; for a stage that failed, the
     *  lines follow its `'error'` entry. */
    | 'attempt';
  text: string;
  depth: number;
  stageName?: string;
  /** Stable stage identifier from the builder (matches spec node id). Use for UI sync. */
  stageId?: string;
  /** Unique per-execution-step identifier. Format: [subflowPath/]stageId#executionIndex.
   *  Links narrative entries to recorder Map entries for O(1) time-travel lookup.
   *  Undefined only when TraversalContext is absent from the source event. */
  runtimeStageId?: string;
  stepNumber?: number;
  /** Subflow ID when this entry was generated inside a subflow. Undefined for root-level. */
  subflowId?: string;
  /** Direction for subflow entries: 'entry' when entering, 'exit' when leaving.
   *  Only present on entries with type === 'subflow'. Use this instead of text scanning. */
  direction?: 'entry' | 'exit';
  /** Scope key that was read or written. Only present on 'step' entries.
   *  Use this for structured data extraction (e.g., grounding analysis)
   *  instead of matching on rendered text strings. */
  key?: string;
  /** Raw value from the scope event — available for programmatic access and custom formatting.
   *  Only present on 'step' entries (read/write ops). This is a live reference, not a clone.
   *  When using ScopeFacade, redacted keys will have value '[REDACTED]' (sanitized upstream
   *  by ScopeFacade before dispatching events — the recorder does not enforce redaction). */
  rawValue?: unknown;
}

export interface CombinedNarrativeOptions {
  includeStepNumbers?: boolean;
  includeValues?: boolean;
  indent?: string;
}

// ---------------------------------------------------------------------------
// NarrativeFormatter — Pluggable formatting for CombinedNarrativeRecorder
// ---------------------------------------------------------------------------

/** Context passed to renderStage. */
export interface StageRenderContext {
  stageName: string;
  stageNumber: number;
  isFirst: boolean;
  description?: string;
  /** Loop iteration number (1-based). Present when this stage is visited via loopTo(). */
  loopIteration?: number;
  /** True for the stage a resume re-entered: its arrival was already told by the resume entry. */
  resumed?: boolean;
}

/** Context passed to renderOp. Return null to exclude the entry. */
export interface OpRenderContext {
  type: 'read' | 'write';
  key: string;
  rawValue: unknown;
  valueSummary: string;
  operation?: 'set' | 'update' | 'delete';
  stepNumber: number;
}

/** Context passed to renderDecision. */
export interface DecisionRenderContext {
  decider: string;
  chosen: string;
  description?: string;
  rationale?: string;
  /** Raw evidence from decide()/select() — available for custom rendering. */
  evidence?: unknown;
}

/** Context passed to renderFork. */
export interface ForkRenderContext {
  children: string[];
}

/** Context passed to renderSubflow. */
export interface SubflowRenderContext {
  name: string;
  direction: 'entry' | 'exit';
  description?: string;
  /** Mapped input values sent into the subflow. Present on entry. */
  mappedInput?: Record<string, unknown>;
  /** Subflow shared state at exit. Present on exit. */
  outputState?: Record<string, unknown>;
}

/** Context passed to renderLoop. */
export interface LoopRenderContext {
  target: string;
  iteration: number;
  description?: string;
}

/** Context passed to renderBreak. */
export interface BreakRenderContext {
  stageName: string;
}

/** Context passed to renderSelected. */
export interface SelectedRenderContext {
  selected: string[];
  total: number;
  /** Raw evidence from select() — available for custom rendering. */
  evidence?: unknown;
}

/** Context passed to renderError. */
export interface ErrorRenderContext {
  stageName: string;
  message: string;
  validationIssues?: string;
}

/**
 * Context passed to `NarrativeFormatter.renderAttempt` — one attempt of a stage
 * with a declared retry policy (10.1), whatever its outcome.
 */
export interface AttemptRenderContext {
  /** The stage the attempt ran. */
  stageName: string;
  /** The attempt: outcome, duration, category, the served error, and the retry-or-stop decision. */
  record: AttemptRecord;
}

/**
 * Context of `NarrativeFormatter.renderRetry` — one failed attempt at a stage
 * with a declared retry policy, which the engine then retried. Since 10.1 the
 * built-in narrative no longer renders a separate retry line (see
 * {@link AttemptRenderContext}); the type stays for formatters written against
 * 9.15–10.0.
 */
export interface RetryRenderContext {
  stageName: string;
  /** Which attempt just failed, 1-based. */
  attempt: number;
  /** Total attempts the policy allows, including the first. */
  maxAttempts: number;
  /** Milliseconds waited before the next attempt. `0` = immediate. */
  delayMs: number;
  /** The failed attempt's error message. */
  message: string;
}

/**
 * Context passed to `NarrativeFormatter.renderEmit` — fires for every
 * consumer-emitted event (`scope.$emit(name, payload)`). Carries the full
 * `EmitEvent` shape so formatters can render name + payload with full
 * context.
 */
export interface EmitRenderContext {
  name: string;
  payload: unknown;
  stageName: string;
  runtimeStageId: string;
  subflowPath: readonly string[];
  pipelineId: string;
  timestamp: number;
  /** Summary string — the library's default truncated payload preview. */
  payloadSummary: string;
}

/**
 * Pluggable formatter for narrative output. Turns structured event context
 * objects into the text lines that make up the narrative array.
 *
 * ## Why "Formatter", not "Renderer"
 *
 * In web terminology "renderer" usually means "turn data into a visible UI"
 * (pixels, DOM, HTML). This interface does something smaller: it converts
 * event context into a text string. That is more accurately called a
 * *formatter*.
 *
 * ## Behaviour
 *
 * Each method is optional — unimplemented methods fall back to the default
 * English formatter. Return `null` from `renderOp` to exclude that entry
 * from the narrative entirely.
 *
 * @example
 * ```typescript
 * const rec = narrative({
 *   renderer: {
 *     renderOp(ctx) {
 *       if (ctx.key.startsWith('_internal')) return null; // filter out internal keys
 *       return `${ctx.type === 'read' ? 'Read' : 'Wrote'} ${ctx.key}: ${ctx.valueSummary}`;
 *     },
 *   },
 * });
 * ```
 */
export interface NarrativeFormatter {
  renderStage?(ctx: StageRenderContext): string;
  /**
   * Format an op (scope read/write, or subflow-input key) into a narrative line.
   *
   *   - `string`    → use as the narrative line
   *   - `null`      → deliberately exclude this entry from the narrative
   *   - `undefined` → this formatter does not handle this op; fall back to
   *                   the library's default template
   *
   * The `undefined` return lets a domain-aware formatter handle only the
   * keys it knows about and leave the rest to the library default — without
   * having to re-implement the whole default inline.
   */
  renderOp?(ctx: OpRenderContext): string | null | undefined;
  renderDecision?(ctx: DecisionRenderContext): string;
  renderFork?(ctx: ForkRenderContext): string;
  renderSelected?(ctx: SelectedRenderContext): string;
  renderSubflow?(ctx: SubflowRenderContext): string;
  renderLoop?(ctx: LoopRenderContext): string;
  renderBreak?(ctx: BreakRenderContext): string;
  renderError?(ctx: ErrorRenderContext): string;
  /**
   * NOT CALLED since 10.1: the built-in narrative renders one attempt line per
   * attempt (`renderAttempt`), which carries what the retry line said. Kept
   * declared so a formatter written against 9.15–10.0 still compiles.
   */
  renderRetry?(ctx: RetryRenderContext): string;
  /**
   * Format one attempt of a retried stage (10.1) into a narrative line — a
   * depth-1 sub-item of its stage, between the attempts' reads and writes.
   *
   *   - `string`    → use as the narrative line
   *   - `null`      → deliberately exclude this entry
   *   - `undefined` → fall back to the library's default sentence
   *                   (`Attempt 2 of 3 at Fetch failed in 12ms (…), retrying in 1s.`)
   */
  renderAttempt?(ctx: AttemptRenderContext): string | null | undefined;
  /**
   * Format a consumer-emitted event (from `scope.$emit(name, payload)`)
   * into a narrative line.
   *
   *   - `string`    → use as the narrative line
   *   - `null`      → deliberately exclude this entry
   *   - `undefined` → this formatter does not handle this emit; fall back
   *                   to the library's default template
   *
   * Typical pattern: switch on `ctx.name` (or a prefix of it) and return a
   * domain-specific text line for the event types you care about; return
   * `undefined` for everything else so the default template handles it.
   */
  renderEmit?(ctx: EmitRenderContext): string | null | undefined;
}
