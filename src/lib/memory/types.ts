/**
 * types.ts — Core type definitions for the memory library
 *
 * Zero dependencies on old code or other libraries in this package, with one
 * deliberate exception: `capture/` — the standalone leaf module holding the
 * shared retention-policy family and summary-marker builders (extracted from
 * here in #13c-A so the read and write dials, and later RFC-001, share one
 * implementation).
 */

import type { RetentionPolicy } from '../capture/policies.js';

// ── Patch & Trace ──────────────────────────────────────────────────────────

/** A flat key-value bag representing a state patch (overwrite or merge). */
export interface MemoryPatch {
  [key: string]: any;
}

/** A single entry in the chronological operation trace. */
export interface TraceEntry {
  /** Canonical path string (segments joined by DELIM). */
  path: string;
  /**
   * Per-write read provenance (#P1) — the keys this stage had TRACKED-READ at
   * the moment this path was (last) written: the temporal-prefix attribution
   * that lets slices link a specific write to only the reads that could have
   * fed it (a stage reading `a,b` and writing `x,y` no longer implies x←b).
   * ABSENT unless the `writeProvenance: 'reads-prefix'` dial is on — charts
   * that never enable it keep byte-identical commit logs. Read prefixes only
   * grow during a stage, so under delta mode's one-entry-per-path dedup the
   * LAST write's prefix == the union across all of that path's writes.
   * Honest ceiling: a write with NO tracked reads before it records `[]` —
   * "depended on no tracked reads" is information, not absence.
   */
  readKeys?: string[];
  /**
   * - `'set'`    — hard overwrite; `overwrite[path]` holds the full final value.
   * - `'merge'`  — deep union merge; `updates[path]` holds the accumulated delta.
   * - `'append'` — (#13c-B, produced only under {@link CommitValuesMode}
   *   `'delta'`) the path's final value is its base value plus a tail of new
   *   trailing elements; `overwrite[path]` holds ONLY the tail. Replay
   *   reconstructs by concatenation. NOT idempotent — delta-mode bundles
   *   carry exactly one trace entry per surviving path.
   * - `'delete'` — (#13c-B, produced only under `'delta'`; absorbs backlog
   *   B8) the key was explicitly removed via `deleteValue()`. Replay removes
   *   the key. `overwrite[path]` still ENUMERATES the path (value
   *   `undefined`) so key-set consumers keep seeing the changed key.
   *
   * `overwrite` values are therefore VERB-QUALIFIED: consumers that read
   * `bundle.overwrite[key]` as "the full value written" must use
   * `commitValueAt(commitLog, idx, key)` (from `footprintjs/trace`) when the
   * log may contain delta-mode bundles.
   */
  verb: 'set' | 'merge' | 'append' | 'delete';
}

/**
 * RFC-003 D2 — read paths that BYPASS read tracking:
 * - `'args'`   — the stage called `getArgs()` / `$getArgs()` with non-empty
 *   run input (frozen, untracked by design)
 * - `'env'`    — the stage called `getEnv()` / `$getEnv()` with a non-empty
 *   execution environment (frozen, untracked by design)
 * - `'silent'` — the stage performed a silent read (`getValueSilent` /
 *   `getValueDirect`) of a key it never tracked-read in the same stage.
 *   Silent reads SHADOWED by a tracked read of the same key in the same
 *   stage (TypedScope array-proxy internals, `$batchArray`) are NOT
 *   flagged — their read→write edge is already captured.
 */
export type UntrackedSource = 'args' | 'env' | 'silent';

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
  /**
   * RFC-003 D2 honesty markers — untracked read paths this stage consumed
   * (see {@link UntrackedSource}). ABSENT when the stage used none, so
   * charts that never touch those paths keep byte-identical commit logs.
   * Causal-slice consumers (`causalChain`/`formatCausalChain`) surface this
   * as "slice may be incomplete here". Residual limitation (by design):
   * values smuggled through JS closures are undetectable.
   */
  untrackedSources?: ReadonlyArray<UntrackedSource>;
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

// ── Read / Write Tracking (#14, #13c-A) ────────────────────────────────────
//
// The policy family and marker shapes are owned by `capture/` (shared with
// the write dial and, later, RFC-001's deferred-observer capture tier).
// Re-exported here so every pre-extraction import path keeps working.

export type { RetentionPolicy } from '../capture/policies.js';
export type { ReadSummaryMarker, WriteSummaryMarker } from '../capture/summarize.js';
export { READ_PREVIEW_LENGTH, SUMMARY_PREVIEW_LENGTH } from '../capture/summarize.js';

/**
 * Per-write read-provenance policy (#P1) — the fourth dial of the
 * readTracking/writeTracking/commitValues family, same 6-site propagation
 * pattern (executor option → ExecutionRuntime.use* → root StageContext →
 * createNext/createChild inheritance → SubflowExecutor duck-push).
 *
 * - `'off'` (default) — zero cost, byte-identical commit logs.
 * - `'reads-prefix'` — every committed {@link TraceEntry} carries
 *   `readKeys`: the keys tracked-read BEFORE that write (temporal-prefix
 *   attribution). Cost: one Set-to-array copy per write. Consumed by
 *   `causalChain`'s `edgeAttribution: 'per-write'` and the slice layer.
 */
export type WriteProvenanceMode = 'off' | 'reads-prefix';

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

/**
 * Policy for how commit-bundle VALUES are encoded into the commit log
 * (#13c-B) — completes the `readTracking`/`writeTracking` dial family.
 * Unlike those two (which gate lossy snapshot bookkeeping), this dial is
 * **lossless in both modes** — it changes the commit log's *encoding*,
 * never its *information*; any step's full state stays exactly
 * reconstructable by replay.
 *
 * - `'full'` (default) — every surviving `set` path stores the full final
 *   value, one trace entry per operation. Byte-identical to the historical
 *   behavior.
 * - `'delta'` — two changes, both replay-covered by `applySmartMerge`:
 *   1. **`append` detection**: when a path's net change is "the base array
 *      plus new trailing elements" (strict prefix), the bundle records ONLY
 *      the tail under a `verb: 'append'` trace entry — the growing-history
 *      commit log becomes linear in tail size instead of O(N²) retained.
 *      A real `verb: 'delete'` entry replaces the `set: undefined` flattening
 *      for `deleteValue()` (closes the documented MemoryPatch limitation).
 *   2. **One trace entry per surviving path** (append is not idempotent on
 *      replay): the verb is resolved from the path's base→final relationship
 *      and op mix; entries are ordered by each path's LAST touch.
 *
 * Honest cost note: append detection is NEW wall work — an O(|base|)
 * structural prefix compare per array-set path per commit (today's
 * `deepEqual` fast-fails on length in O(1) for a grown array). On a hit the
 * commit gets cheaper in both wall and heap (the O(|final|) clone shrinks to
 * O(|tail|)); on a miss it pays compare + full clone. `'full'` pays zero —
 * the detection branch is mode-gated.
 *
 * Set via `new FlowChartExecutor(chart, { commitValues })` or
 * `executor.setCommitValues(mode)` (before `run()`). The active mode is
 * surfaced as the snapshot discriminant `RuntimeSnapshot.commitValues`.
 */
export type CommitValuesMode = 'full' | 'delta';

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
