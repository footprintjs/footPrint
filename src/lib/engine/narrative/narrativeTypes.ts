/**
 * narrativeTypes — Shared type definitions for the narrative recorder system.
 *
 * Previously: CombinedNarrativeBuilder.ts (file renamed in post-release cleanup).
 * The CombinedNarrativeBuilder class was removed in v1.0.
 * Use CombinedNarrativeRecorder (auto-attached by setEnableNarrative()) instead.
 */

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
    | 'resume';
  text: string;
  depth: number;
  stageName?: string;
  /** Stable stage identifier from the builder (matches spec node id). Use for UI sync. */
  stageId?: string;
  stepNumber?: number;
  /** Subflow ID when this entry was generated inside a subflow. Undefined for root-level. */
  subflowId?: string;
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
// NarrativeRenderer — Pluggable rendering for CombinedNarrativeRecorder
// ---------------------------------------------------------------------------

/** Context passed to renderStage. */
export interface StageRenderContext {
  stageName: string;
  stageNumber: number;
  isFirst: boolean;
  description?: string;
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
 * Pluggable renderer for customizing narrative output.
 *
 * Each method is optional — unimplemented methods fall back to the default
 * English renderer. Return null from renderOp to exclude an entry entirely.
 *
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
export interface NarrativeRenderer {
  renderStage?(ctx: StageRenderContext): string;
  /** Return null to exclude the op from the narrative. */
  renderOp?(ctx: OpRenderContext): string | null;
  renderDecision?(ctx: DecisionRenderContext): string;
  renderFork?(ctx: ForkRenderContext): string;
  renderSelected?(ctx: SelectedRenderContext): string;
  renderSubflow?(ctx: SubflowRenderContext): string;
  renderLoop?(ctx: LoopRenderContext): string;
  renderBreak?(ctx: BreakRenderContext): string;
  renderError?(ctx: ErrorRenderContext): string;
}
