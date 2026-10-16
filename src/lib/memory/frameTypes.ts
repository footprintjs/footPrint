/**
 * frameTypes.ts — the types of the engine's frame (L4): what one stage inside a run reports.
 *
 * Its snapshot (`StageSnapshot`, one node of the execution tree), its flow messages
 * (`FlowMessage`, `FlowControlType`) and the two retention dials that shape what the snapshot
 * keeps (`ReadTrackingMode`, `WriteTrackingMode`, over `capture/`'s `RetentionPolicy`). They lived
 * in the record's `types.ts` until C6; the record names nothing outside itself now
 * (`RECORD_FILES`, scripts/layering.config.cjs), so they sit beside the frame that writes them.
 *
 * A retried stage's node also carries its attempts (`attempts`, `attemptSummary` — the attempt leaf's types, L0).
 *
 * A `StageSnapshot` is an `ExecutionTree` (`types.ts`), the shape the record's readers walk:
 * `commitStops`, `tagStops` and `keysReadFromExecutionTree` take one.
 */

import type { AttemptRecord, AttemptSummary, LateWrite } from '../attempt/types.js';
import type { RetentionPolicy } from '../capture/policies.js';

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

// ── Read / Write Tracking (#14, #13c-A) ────────────────────────────────────
//
// The policy family and marker shapes are owned by `capture/` (shared with
// the deferred-observer capture tier).

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
 *
 * Alias of the shared {@link RetentionPolicy} family (#13c-A) — kept as the
 * shipped public name for the read dial.
 */
export type ReadTrackingMode = RetentionPolicy;

/**
 * Policy for how tracked writes are recorded into `StageSnapshot.stageWrites`
 * (#13c-A) — the sibling of {@link ReadTrackingMode}.
 *
 * - `'full'` (default) — every tracked write `structuredClone`s the value into
 *   the stage's write view. Byte-identical to the historical behavior.
 * - `'summary'` — writes record a cheap {@link WriteSummaryMarker} instead of
 *   the cloned value.
 * - `'off'` — writes are not recorded at all; `stageWrites` is absent from the
 *   snapshot. The writes themselves still commit to shared state and still
 *   appear in the commit log — only the per-stage snapshot bookkeeping (and
 *   therefore the commit observer's mutations payload) is affected. (The
 *   commit log's own value encoding has its own lossless dial —
 *   {@link CommitValuesMode}, #13c-B.)
 *
 * Set via `new FlowChartExecutor(chart, { writeTracking })` or
 * `executor.setWriteTracking(mode)` (before `run()`). See
 * `FlowChartExecutorOptions.writeTracking` for the full observable-consequence
 * contract (onCommit payload, redaction precedence, what is OUT of scope).
 */
export type WriteTrackingMode = RetentionPolicy;

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
  /** User-level writes made by this stage (pre-namespace keys → values).
   *  Shape depends on {@link WriteTrackingMode}: cloned values under `'full'`
   *  (default), {@link WriteSummaryMarker}s under `'summary'`, absent under
   *  `'off'`. Redacted writes show `'[REDACTED]'` regardless of mode. */
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
  /**
   * Every attempt of this execution under a declared retry policy (10.1), in order — when it started, how long
   * it took, how it ended, and the retry-or-stop decision that followed (`AttemptRecord`). Absent without a
   * policy (and for `attempts: 1`). The commit log never carries attempts: a retried stage is still ONE bundle.
   */
  attempts?: readonly AttemptRecord[];
  /**
   * The series at a glance — counts per outcome, and how it ended. Stamped when the series ends: absent while it
   * is still running (a snapshot taken mid-stage) and without a policy.
   */
  attemptSummary?: AttemptSummary;
  /**
   * Writes (and emits) an attempt tried AFTER it had ended — timed out, aborted or failed — in the order they came
   * (P1b). Each was dropped at the scope, so none reached the stage's buffer, its commit or a recorder; this is
   * the record that they were tried. Names only, never values. Absent when there were none.
   */
  lateWrites?: readonly LateWrite[];
  next?: StageSnapshot;
  children?: StageSnapshot[];
};
