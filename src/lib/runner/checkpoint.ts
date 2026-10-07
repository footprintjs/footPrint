/**
 * checkpoint — the pause checkpoint, built ONCE at the pause (F9).
 *
 * `buildPauseCheckpoint` assembles the checkpoint from a caught `PauseSignal`
 * and the paused run, stamped with the format the ONE codec reads back
 * (`pause/record.ts` · `CHECKPOINT_VERSION` / `decodeCheckpoint`), and
 * detaches it with one `structuredClone`.
 *
 * LEAN (format 2). The checkpoint holds what `resume()` reads and the pause's
 * own record, nothing else:
 *
 *   read by resume  the cursor (`pausedStageId`, `subflowPath`, `pausedBy`),
 *                   the state (`sharedState`, and `subflowStates` — one capture
 *                   per subflow ON the pause path), the counters
 *                   (`executionCount`, `visitCounts` — one entry per stage id),
 *                   the waiting siblings (`pendingPauses`), the redaction names
 *                   (`redactionMarks`), the link (`pausedExecution`);
 *   the record      `pauseData` (the question), `invokerStageId`, `pausedAt`.
 *
 * So its size is the state's and the chart's, never the run's length. Format 1
 * also carried the whole execution tree and the finished subflows' results —
 * the run's served record, which no resume read and which grew with every
 * finished iteration (`bench/checkpoint-size.ts`: 19.3 MB after 60 agent
 * turns whose resumable state — root plus captures — is 0.13 MB; the tree
 * alone was 97%). That record is `getSnapshot()`'s. Pinned:
 * test/lib/pause/checkpoint-size.test.ts.
 *
 * THE LAW holds: the checkpoint keeps REAL values — no redaction policy ever
 * touches it (it is what the resumed run computes on); the marks travel as
 * NAMES only.
 *
 * The JSON-safe contract governs what CONSUMERS put into a checkpoint
 * (`pauseData`, shared state). A value `structuredClone` refuses can only come
 * from them — shared state is cloned at every commit, so a function never
 * reaches it, and no diagnostic bag is carried — so a failed clone becomes a
 * DESCRIPTIVE contract error naming the field (`describeCheckpointCloneFailure`)
 * instead of a naked `DataCloneError`.
 */

import type { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import { CHECKPOINT_VERSION } from '../pause/record.js';
import type { FlowchartCheckpoint, PauseSignal, RedactionMarks } from '../pause/types.js';

/** The paused run's counters, as the executor holds them at the pause. */
export interface PausedRun {
  readonly runId: string;
  readonly executionCount: number;
  readonly visitCounts: ReadonlyMap<string, number>;
  /** The run's redaction marks — names only (`RedactionRule · marksForCheckpoint`); absent when none. */
  readonly redactionMarks?: RedactionMarks;
}

/**
 * Build a fully DETACHED, lean checkpoint from a caught PauseSignal.
 *
 * Every field is deep-copied via one `structuredClone` of the assembled
 * checkpoint, because the raw pieces alias live engine state:
 *
 *   - `sharedState` IS `SharedMemory`'s current generation — never edited,
 *     but (copy-on-write, 9.29.0) every later generation shares its
 *     unchanged subtrees, so a checkpoint that aliased it would alias the
 *     resumed run's state too.
 *   - `subflowStates` values are shallow copies whose NESTED objects alias
 *     subflow memory, and they get seeded back into live runtimes on resume.
 *
 * The checkpoint is persisted by contract ("store in Redis/Postgres") — it
 * must never share structure with the engine.
 *
 * The state is read straight off the root runtime's store — no snapshot is
 * built (a snapshot would build the execution tree and copy the commit log,
 * work proportional to the run's length, only to throw both away).
 *
 * Subflow scope capture (`subflowStates`) survives ONLY on the signal — the
 * nested runtimes are GC'd as the stack unwinds. Promoting it onto the
 * checkpoint here lets cross-executor resume restore pre-pause subflow
 * scope (e.g. an Agent's `scope.history`). The signal captures a subflow only
 * as it bubbles through that subflow's boundary, so the keys are exactly the
 * pause path's. Empty `{}` for root-level pauses.
 */
export function buildPauseCheckpoint(
  signal: PauseSignal,
  traverser: FlowchartTraverser<any, any>,
  run: PausedRun,
): FlowchartCheckpoint {
  // Every pause that paused in THIS run is named by it; a sibling raised again
  // on resume keeps the run it originally paused in.
  signal.completeExecution(run.runId);
  const checkpoint = {
    // The format — read back by `pause/record.ts · decodeCheckpoint`.
    checkpointVersion: CHECKPOINT_VERSION,
    sharedState: traverser.getRuntime().globalStore.getState(),
    pausedStageId: signal.stageId,
    // The paused EXECUTION (9.37.0) — a queued sibling raised on resume
    // carries the run it ORIGINALLY paused in.
    ...(signal.pausedExecution && { pausedExecution: signal.pausedExecution }),
    subflowPath: signal.subflowPath,
    pauseData: signal.pauseData,
    subflowStates: signal.subflowStates,
    // Counter continuity — seeded back in resume() so runtimeStageIds stay
    // unique and loopIteration stays monotonic across a CROSS-executor resume
    // (both are plain number/record, so they ride the single structuredClone
    // below untouched). See test/lib/pause/resume-execution-counter-continuity.test.ts.
    executionCount: run.executionCount,
    visitCounts: Object.fromEntries(run.visitCounts),
    // Invoker context — collected during traversal bubble-up (not tree-walked).
    // (`continuationStageId` is legacy-only since 9.39.0: no longer written.)
    ...(signal.invokerStageId && { invokerStageId: signal.invokerStageId }),
    // Parallel siblings' pauses from the same fan-out, waiting their turn
    // (9.28.0). Absent when only one child paused — the shape every
    // earlier checkpoint has.
    ...(signal.pendingPauses.length > 0 && { pendingPauses: signal.pendingPauses }),
    // HOW the pause was raised. One checkpoint shape, one extra optional
    // field — an interrupt() pause is not a second kind of checkpoint, it is
    // the same checkpoint that resume() re-enters differently (stage top vs
    // resumeFn). Absent for every pre-9.14.0 checkpoint, which is correct.
    ...(signal.pausedBy && { pausedBy: signal.pausedBy }),
    // The redaction the paused run had made — NAMES only (marks, a mapper's taints, inherited
    // fields). Resume seeds the resumed run's rule with them. Absent when nothing was marked.
    ...(run.redactionMarks && { redactionMarks: run.redactionMarks }),
    pausedAt: Date.now(),
  };
  try {
    return structuredClone(checkpoint);
  } catch (error) {
    // Genuine JSON-safe contract violation in consumer-owned data.
    throw describeCheckpointCloneFailure(checkpoint, error);
  }
}

/** `true` when `structuredClone` accepts the value as-is. */
function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the DESCRIPTIVE error for a checkpoint that cannot be cloned — the
 * non-cloneable value lives in consumer-owned data (a genuine JSON-safe
 * contract violation). Probes each top-level checkpoint field individually so
 * the message names the offending field family. Never lets a naked
 * `DataCloneError` escape.
 */
function describeCheckpointCloneFailure(checkpoint: Record<string, unknown>, cause: unknown): Error {
  const failing = Object.entries(checkpoint)
    .filter(([, value]) => !isCloneable(value))
    .map(([field]) => field);
  const fields = failing.length > 0 ? failing.join(', ') : 'unknown';
  return new Error(
    'FlowChartExecutor: cannot build the pause checkpoint — non-serializable value(s) in ' +
      `checkpoint field(s): ${fields}. The checkpoint contract is JSON-safe (no functions, no ` +
      "class instances). Check the pauseData returned by the pausable stage's execute(), and any " +
      'subflow state captured at the pause. Diagnostic values from $debug/$metric/$error/$eval ' +
      'are never part of a checkpoint and never cause this error. ' +
      'See docs/guides/execution-model.md ("Pause / resume — what a checkpoint captures").',
    { cause },
  );
}
