/**
 * types.ts — Core type definitions for the memory library
 *
 * Zero dependencies on old code or other libraries in this package.
 */

// ── Patch & Trace ──────────────────────────────────────────────────────────

/** A flat key-value bag representing a state patch (overwrite or merge). */
export interface MemoryPatch {
  [key: string]: any;
}

/** A single entry in the chronological operation trace. */
export interface TraceEntry {
  /** Canonical path string (segments joined by DELIM). */
  path: string;
  /** 'set' = hard overwrite, 'merge' = deep union merge. */
  verb: 'set' | 'merge';
}

/** The atomic bundle produced by TransactionBuffer.commit(). */
export interface CommitBundle {
  /** Auto-assigned step index (set by EventLog.record). */
  idx?: number;
  /** Human-readable stage name. */
  stage: string;
  /** Stable stage identifier (matches spec node id). */
  stageId: string;
  /** Unique per-execution-step identifier. Format: [subflowPath/]stageId#executionIndex */
  runtimeStageId: string;
  /** Chronological write log for deterministic replay. */
  trace: TraceEntry[];
  /** Paths that should be redacted in UI (sensitive data). */
  redactedPaths: string[];
  /** Hard overwrite patches. */
  overwrite: MemoryPatch;
  /** Deep merge patches. */
  updates: MemoryPatch;
}

// ── Flow Control Narrative ─────────────────────────────────────────────────

/** Types of control flow decisions captured by the execution engine. */
export type FlowControlType = 'next' | 'branch' | 'children' | 'selected' | 'subflow' | 'loop';

/** A single flow control narrative entry. */
export interface FlowMessage {
  type: FlowControlType;
  description: string;
  targetStage?: string | string[];
  rationale?: string;
  count?: number;
  iteration?: number;
  timestamp?: number;
}

// ── Stage Snapshot ─────────────────────────────────────────────────────────

/** Serialisable representation of a stage's state (for debugging / visualisation). */
export type StageSnapshot = {
  id: string;
  name?: string;
  /** Human-readable description of what this stage does (from builder). */
  description?: string;
  /** Subflow identifier — present when this stage is a subflow entry point. */
  subflowId?: string;
  isDecider?: boolean;
  isFork?: boolean;
  /** User-level writes made by this stage (pre-namespace keys → values). */
  stageWrites?: Record<string, unknown>;
  /** User-level reads made by this stage (pre-namespace keys → values at read time). */
  stageReads?: Record<string, unknown>;
  logs: Record<string, unknown>;
  errors: Record<string, unknown>;
  metrics: Record<string, unknown>;
  evals: Record<string, unknown>;
  flowMessages?: FlowMessage[];
  next?: StageSnapshot;
  children?: StageSnapshot[];
};

// ── Scope Factory ──────────────────────────────────────────────────────────

/** Forward-declared so StageContext can accept it without importing scope/. */
export type ScopeFactory<TScope> = (core: StageContext, stageName: string, readOnlyContext?: unknown) => TScope;

// ── StageContext (forward reference for ScopeFactory) ──────────────────────

// The actual class lives in StageContext.ts; we just need the type here for
// the ScopeFactory generic. TypeScript's import-type handles this:
import type { StageContext } from './StageContext.js';
