/**
 * checkpoint — the pause checkpoint, built ONCE at the pause (F9).
 *
 * `buildPauseCheckpoint` assembles the checkpoint from a caught `PauseSignal`
 * and the paused run, stamped with the format the ONE codec reads back
 * (`pause/record.ts` · `CHECKPOINT_VERSION` / `decodeCheckpoint`), and
 * detaches it with one `structuredClone`.
 *
 * Clone resilience lives beside it. The JSON-safe contract governs what
 * CONSUMERS put into a checkpoint (pauseData, shared state) — but the
 * execution tree's diagnostic bags (`logs`/`errors`/`metrics`/`evals`) accept
 * ANY value at write time without cloning (`$debug`/`$error`/`$metric`/`$eval`
 * route through `DiagnosticCollector`, which stores raw references). A
 * `$debug`'d function in any stage of a pausing run would make the
 * whole-checkpoint clone throw `DataCloneError` — swallowing the pause. That
 * violates the library's error-isolation grain (observability side-bags never
 * abort traversal anywhere else), so:
 *
 *   - `sanitizeDiagnosticBags` — replace non-cloneable diagnostic values with
 *     marker strings (`'[non-serializable: function]'`) so the pause survives.
 *   - `describeCheckpointCloneFailure` — when the clone STILL fails after
 *     sanitization (the non-cloneable lives in consumer-owned data, e.g.
 *     `pauseData`), name the offending checkpoint field(s) and point at the
 *     JSON-safe contract instead of letting a naked `DataCloneError` escape.
 *
 * Both run ONLY on the clone-failure path of a pause — never on the hot path.
 */

import type { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import type { SubflowResult } from '../engine/types.js';
import { isExecutionKey } from '../ids/runtimeStageId.js';
import type { StageSnapshot } from '../memory/types.js';
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
 * Build a fully DETACHED checkpoint from a caught PauseSignal.
 *
 * Every field is deep-copied via one `structuredClone` of the assembled
 * checkpoint, because the raw pieces alias live engine state:
 *
 *   - `sharedState` IS `SharedMemory`'s current generation — never edited,
 *     but (copy-on-write, 9.29.0) every later generation shares its
 *     unchanged subtrees, so a checkpoint that aliased it would alias the
 *     resumed run's state too.
 *   - `executionTree` nodes are fresh, but their `logs`/`errors`/`metrics`/
 *     `evals`/`stageReads`/`flowMessages` fields reference live
 *     `DiagnosticCollector` bags that keep accumulating on same-executor
 *     resume.
 *   - `subflowStates` values are shallow copies whose NESTED objects alias
 *     subflow memory, and they get seeded back into live runtimes on resume.
 *   - `subflowResults` values stay referenced by the traverser's results map.
 *
 * The checkpoint is persisted by contract ("store in Redis/Postgres") — it
 * must never share structure with the engine. Pause is not a hot path; the
 * clone cost is irrelevant.
 *
 * On clone failure the diagnostic bags are sanitized (the live engine bags
 * are never touched) and the clone retried; if the retry STILL fails, the
 * violation is in consumer-owned data (realistically `pauseData` — a function
 * can never reach shared state: the record's clone at commit refuses it) and a
 * DESCRIPTIVE contract error names the offending checkpoint field(s).
 *
 * Subflow scope capture (`subflowStates`) survives ONLY on the signal — the
 * nested runtimes are GC'd as the stack unwinds. Promoting it onto the
 * checkpoint here lets cross-executor resume restore pre-pause subflow
 * scope (e.g. an Agent's `scope.history`). Empty `{}` for root-level pauses.
 */
export function buildPauseCheckpoint(
  signal: PauseSignal,
  traverser: FlowchartTraverser<any, any>,
  run: PausedRun,
): FlowchartCheckpoint {
  // Every pause that paused in THIS run is named by it; a sibling raised again
  // on resume keeps the run it originally paused in.
  signal.completeExecution(run.runId);
  const snapshot = traverser.getSnapshot();
  const leanSubflowResults = leanSubflowResultsOf(traverser.getSubflowResults());
  const checkpoint = {
    // The format (9.39.0) — read back by `pause/record.ts · decodeCheckpoint`.
    checkpointVersion: CHECKPOINT_VERSION,
    sharedState: snapshot.sharedState,
    executionTree: snapshot.executionTree,
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
    ...(Object.keys(leanSubflowResults).length > 0 && { subflowResults: leanSubflowResults }),
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
  } catch {
    // Non-cloneable diagnostics must not swallow the pause — sanitize the
    // executionTree's bags (markers replace the offenders) and retry.
    try {
      checkpoint.executionTree = sanitizeDiagnosticBags(checkpoint.executionTree as StageSnapshot);
      return structuredClone(checkpoint);
    } catch (retryError) {
      // Genuine JSON-safe contract violation in consumer-owned data.
      throw describeCheckpointCloneFailure(checkpoint, retryError);
    }
  }
}

/**
 * Lean subflowResults for the checkpoint (design: docs/design/subflow-commit-visibility.md):
 *   - DROP the per-iteration mount-runtimeStageId keys ('#') that the snapshot dual-keys —
 *     they would DOUBLE the checkpoint, and resume restores scope from `subflowStates`, not these.
 *   - STRIP each subflow's `treeContext.history` — resume NEVER reads `subflowResults` (it
 *     restores from `subflowStates` + `sharedState`), so the per-subflow commit log is pure
 *     checkpoint bloat. The flat agent's checkpoint carries no commit history either → symmetric.
 */
function leanSubflowResultsOf(sfResults: Map<string, SubflowResult>): Record<string, unknown> {
  const leanSubflowResults: Record<string, unknown> = {};
  for (const [key, value] of sfResults) {
    if (isExecutionKey(key)) continue; // per-iteration keys are snapshot-only
    const v = value as unknown as { treeContext?: Record<string, unknown> };
    if (v?.treeContext) {
      const treeCtxRest: Record<string, unknown> = {};
      for (const ck of Object.keys(v.treeContext)) {
        if (ck !== 'history') treeCtxRest[ck] = v.treeContext[ck]; // strip the per-subflow commit log
      }
      leanSubflowResults[key] = { ...(value as unknown as Record<string, unknown>), treeContext: treeCtxRest };
    } else {
      leanSubflowResults[key] = value;
    }
  }
  return leanSubflowResults;
}

/** The StageSnapshot fields written by `$debug`/`$error`/`$metric`/`$eval`. */
const DIAGNOSTIC_BAGS = ['logs', 'errors', 'metrics', 'evals'] as const;

/** `true` when `structuredClone` accepts the value as-is. */
function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable kind for the `[non-serializable: …]` marker. */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return value.constructor?.name ?? 'object';
}

/** Plain data container we can rebuild entry-by-entry without lying about the type. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-replace non-cloneable values with `'[non-serializable: <kind>]'`
 * marker strings, preserving everything `structuredClone` accepts.
 *
 * Fast path: a cloneable value is returned AS-IS (no copy — the caller
 * clones the whole checkpoint right after). Only containers that actually
 * hold a non-cloneable leaf are rebuilt, and only KNOWN container shapes
 * (array / Map / Set / plain object) are rebuilt entry-by-entry — exotic
 * non-cloneables (Promise, WeakMap, class instances holding a function, …)
 * become a typed marker rather than a misleading empty shell. Pure cycles
 * pass the fast path untouched (`structuredClone` supports them); a cycle
 * is only broken — with a marker — when it shares a container with a
 * non-cloneable value.
 */
function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (isCloneable(value)) return value;
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[non-serializable: circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeValue(v, seen));
    }
    if (value instanceof Map) {
      return new Map([...value].map(([k, v]) => [sanitizeValue(k, seen), sanitizeValue(v, seen)]));
    }
    if (value instanceof Set) {
      return new Set([...value].map((v) => sanitizeValue(v, seen)));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, seen)]));
    }
  }
  return `[non-serializable: ${describeKind(value)}]`;
}

/**
 * Walk a `StageSnapshot` tree (via `next` + `children`) and sanitize the four
 * diagnostic bags on every node IN PLACE.
 *
 * In-place is safe and intentional: `StageContext.getSnapshot()` builds fresh
 * node objects on every call, but the bag fields on those fresh nodes ALIAS
 * the live `DiagnosticCollector` bags. We replace the node's bag REFERENCE
 * with a sanitized copy — the live engine bags are never mutated, so a
 * same-executor resume keeps the original diagnostic values.
 */
function sanitizeDiagnosticBags(tree: StageSnapshot): StageSnapshot {
  const seen = new WeakSet<object>();
  const visit = (node: StageSnapshot): void => {
    for (const bag of DIAGNOSTIC_BAGS) {
      const bagValue = node[bag];
      if (bagValue !== undefined && !isCloneable(bagValue)) {
        node[bag] = sanitizeValue(bagValue, seen) as Record<string, unknown>;
      }
    }
    if (node.next) visit(node.next);
    if (node.children) for (const child of node.children) visit(child);
  };
  visit(tree);
  return tree;
}

/**
 * Build the DESCRIPTIVE error for a checkpoint that still cannot be cloned
 * after diagnostic-bag sanitization — i.e. the non-cloneable value lives in
 * consumer-owned data (a genuine JSON-safe contract violation). Probes each
 * top-level checkpoint field individually so the message names the offending
 * field family. Never lets a naked `DataCloneError` escape.
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
      'are sanitized automatically and never cause this error. ' +
      'See docs/guides/execution-model.md ("Pause / resume — what a checkpoint captures").',
    { cause },
  );
}
