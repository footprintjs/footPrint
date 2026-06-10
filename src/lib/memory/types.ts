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

// ── Read Tracking (#14) ────────────────────────────────────────────────────

/**
 * Policy for how tracked reads are recorded into `StageSnapshot.stageReads`.
 *
 * - `'full'` (default) — every tracked read `structuredClone`s the value into
 *   the stage's read view. Byte-identical to the historical behavior; this is
 *   what snapshot consumers (lens, agentfootprint) see today.
 * - `'summary'` — reads record a cheap {@link ReadSummaryMarker} (type + size
 *   proxy + short preview) instead of the cloned value. O(1)-ish per read —
 *   no value clone, no serialization of large objects.
 * - `'off'` — reads are not recorded at all; `stageReads` is absent from the
 *   snapshot. Zero per-read cost. Values are still readable, and the
 *   `ScopeRecorder.onRead` event still fires (it passes the live reference and
 *   never cloned) — so narrative output is identical in every mode. The policy
 *   scopes ONLY the snapshot's `stageReads` payload.
 *
 * Set via `new FlowChartExecutor(chart, { readTracking })` or
 * `executor.setReadTracking(mode)` (before `run()`).
 */
export type ReadTrackingMode = 'full' | 'summary' | 'off';

/**
 * Marker recorded in `StageSnapshot.stageReads` under `readTracking: 'summary'`.
 *
 * Honest cost note: `size` is a cheap proxy (string length / array length /
 * object key count), NOT a serialized byte count — computing real byte size
 * would require an O(value) serialization, which is exactly the cost the
 * summary mode removes. `preview` is only produced for primitives and strings
 * (first {@link READ_PREVIEW_LENGTH} characters); objects and arrays carry no
 * preview for the same reason.
 */
export interface ReadSummaryMarker {
  /** Discriminant — lets snapshot consumers detect marker entries. */
  __readSummary: true;
  /** `typeof` result, refined to 'array' / 'null' for objects. */
  type: 'string' | 'number' | 'boolean' | 'bigint' | 'symbol' | 'function' | 'object' | 'array' | 'null';
  /** Size proxy: string length, array length, or object key count. */
  size?: number;
  /** First {@link READ_PREVIEW_LENGTH} chars — primitives and strings only. */
  preview?: string;
}

/** Max characters captured in {@link ReadSummaryMarker.preview}. */
export const READ_PREVIEW_LENGTH = 80;

// ── Stage Snapshot ─────────────────────────────────────────────────────────

/** Serialisable representation of a stage's state (for debugging / visualisation). */
export type StageSnapshot = {
  id: string;
  /** Unique per-execution-step identifier. Format: [subflowPath/]stageId#executionIndex */
  runtimeStageId?: string;
  name?: string;
  /** Human-readable description of what this stage does (from builder). */
  description?: string;
  /** Subflow identifier — present when this stage is a subflow entry point. */
  subflowId?: string;
  isDecider?: boolean;
  isFork?: boolean;
  /** User-level writes made by this stage (pre-namespace keys → values). */
  stageWrites?: Record<string, unknown>;
  /** User-level reads made by this stage (pre-namespace keys → values at read
   *  time). Shape depends on {@link ReadTrackingMode}: cloned values under
   *  `'full'` (default), {@link ReadSummaryMarker}s under `'summary'`, absent
   *  under `'off'`. */
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
