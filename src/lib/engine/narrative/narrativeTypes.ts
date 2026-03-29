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
  type: 'stage' | 'step' | 'condition' | 'fork' | 'selector' | 'subflow' | 'loop' | 'break' | 'error';
  text: string;
  depth: number;
  stageName?: string;
  /** Stable stage identifier from the builder (matches spec node id). Use for UI sync. */
  stageId?: string;
  stepNumber?: number;
  /** Subflow ID when this entry was generated inside a subflow. Undefined for root-level. */
  subflowId?: string;
}

export interface CombinedNarrativeOptions {
  includeStepNumbers?: boolean;
  includeValues?: boolean;
  indent?: string;
}
