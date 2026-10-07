/**
 * Pause/Resume — serializable checkpoint for long-running or human-in-the-loop flows.
 *
 * A stage signals pause by calling `scope.$pause(data)` which throws a PauseSignal.
 * The signal bubbles up through SubflowExecutor → FlowchartTraverser → FlowChartExecutor,
 * each level adding its subflow ID to the path.
 *
 * The checkpoint captures:
 *   - pausedStageId + subflowPath: the paused stage's id and its subflow path
 *   - sharedState: scope at the pause point
 *   - executionTree: completed stages for BTS/narrative
 *   - pauseData: question, reason, or metadata from $pause()
 *
 * Resume rebuilds the flowchart, restores scope, navigates to the paused stage,
 * injects resumeInput, and continues traversal.
 *
 * Supported topologies: linear, subflow (at any depth — mounted linearly, as a
 * decider or selector branch, or as a fork child), loop, nested subflow in
 * loop, and several parallel siblings pausing in one fan-out (each asks in
 * turn — `FlowchartCheckpoint.pendingPauses`).
 *
 * NOT resumable yet: a pause inside a LAZY subflow (`addLazySubFlowChart*`) or
 * inside an `addParallelForEach` branch. Their graphs are resolved at run time
 * and are not in the chart a resume walks, so `resume()` refuses the
 * checkpoint ("not found") instead of guessing. Pinned in
 * test/lib/pause/resume-known-limitations.test.ts.
 */

// ── PauseSignal ─────────────────────────────────────────────

/**
 * The paused EXECUTION (9.37.0): the run that paused and the paused stage's
 * runtimeStageId in it. Recorded on the checkpoint (and on each queued
 * sibling's pending record) so a resume can LINK to it.
 */
export interface PausedExecution {
  readonly runId: string;
  readonly runtimeStageId: string;
}

/**
 * The redaction a pause carries to the resumed run — NAMES only, never a value
 * (the checkpoint stays real): the keys marked secret for the rest of the run
 * (a per-call `setValue(key, value, true)`, a key the policy redacted whole, a
 * subflow mapper's taint) and the fields a mapper handed to a new key. Resume
 * seeds the resumed run's rule with them, so a copy made before the pause is
 * still masked after it.
 */
export interface RedactionMarks {
  readonly keys: readonly string[];
  /** Key → the field paths a mapper handed it. Absent when none. */
  readonly fields?: Readonly<Record<string, readonly string[]>>;
}

/** True for a well-formed {@link PausedExecution} (two non-empty strings). */
export function isPausedExecution(value: unknown): value is PausedExecution {
  const v = value as { runId?: unknown; runtimeStageId?: unknown } | null | undefined;
  return (
    typeof v?.runId === 'string' && v.runId !== '' && typeof v.runtimeStageId === 'string' && v.runtimeStageId !== ''
  );
}

/**
 * Thrown by `scope.$pause()` to signal that execution should stop
 * and create a serializable checkpoint.
 *
 * Bubbles up through SubflowExecutor (which prepends subflow ID to path)
 * and is caught by FlowchartTraverser/FlowChartExecutor.
 */
export class PauseSignal extends Error {
  /** Data from $pause() — question, reason, metadata. */
  readonly pauseData: unknown;
  /** ID of the stage that called $pause(). */
  readonly stageId: string;
  /**
   * HOW the pause was raised — `'interrupt'` when a stage body called
   * `interrupt(scope, payload)`, absent for the `addPausableFunction`
   * execute/resume path. Set at the stage boundary (`StageRunner`), carried
   * onto the checkpoint, and read by `resume()` to pick the re-entry: an
   * interrupted stage re-runs its OWN function from the top (stages are
   * atomic), a pausable stage runs its `resumeFn`.
   */
  readonly pausedBy?: 'interrupt';
  /** Path through subflows to the paused stage. Built during bubble-up. */
  private _subflowPath: string[];

  /**
   * Invoker context — enriched during bubble-up when a PauseSignal passes
   * through a decider, selector, or fork handler.
   *
   * The invoker is the stage that called executeNode() on the paused child.
   * Captured during traversal (not reconstructed from the tree). (The
   * invoker's `.next` id rode beside it until 9.39.0 as
   * `continuationStageId`; what runs after a resume comes from the chart
   * since 9.28.0, so it is no longer carried.)
   */
  private _invokerStageId?: string;

  /**
   * Subflow scope capture — populated during bubble-up by
   * `SubflowExecutor` right before re-throw. Each entry is one
   * subflow's pre-pause shared state, keyed by the path-prefixed
   * subflow id (matches `subflowPath`).
   *
   * Without this, the nested `SharedMemory` is garbage-collected
   * before the checkpoint is built. On resume, the inner runtime is
   * re-created empty and resume handlers reading pre-pause scope
   * (e.g., an Agent's `scope.history`, `scope.pausedToolCallId`)
   * crash with "X is not iterable" / undefined.
   */
  private _subflowStates: Record<string, Record<string, unknown>> = {};

  /**
   * Pauses that PARALLEL SIBLINGS raised in the same fan-out as this one,
   * waiting their turn (9.28.0). Recorded by `ChildrenExecutor` when more
   * than one child of a fork (or more than one selected branch) pauses: the
   * first pause is the one that is asked, the others ride here instead of
   * being dropped. Each path is relative to where the signal currently is
   * and grows with it — `prependSubflow` prepends to every entry too.
   */
  private _pendingPauses: MutablePendingPause[] = [];

  /**
   * WHICH execution paused — its runtimeStageId stamped once at the stage
   * boundary (`StageRunner`), its run added when the checkpoint is built
   * (`completeExecution`), or both carried over for a queued sibling.
   */
  private _pausedExecution?: { runtimeStageId: string; runId?: string };

  constructor(data: unknown, stageId: string, pausedBy?: 'interrupt') {
    super('Execution paused');
    this.name = 'PauseSignal';
    this.pauseData = data;
    this.stageId = stageId;
    if (pausedBy) this.pausedBy = pausedBy;
    this._subflowPath = [];
    // PauseSignal is control flow, not a real error — stack trace has no diagnostic value.
    this.stack = '';
  }

  get subflowPath(): readonly string[] {
    return this._subflowPath;
  }

  /** The paused execution (its run and `[path/]stageId#N`), once both are known. */
  get pausedExecution(): PausedExecution | undefined {
    const e = this._pausedExecution;
    return e?.runId !== undefined ? { runId: e.runId, runtimeStageId: e.runtimeStageId } : undefined;
  }

  /**
   * Record which EXECUTION paused. First stamp wins: the signal bubbles
   * through outer boundaries that must not overwrite it. The stage boundary
   * knows only the runtimeStageId; a queued sibling raised again on resume
   * carries both (it paused in an EARLIER run).
   */
  stampExecution(runtimeStageId: string, runId?: string): void {
    if (this._pausedExecution !== undefined || !runtimeStageId) return;
    this._pausedExecution = { runtimeStageId, ...(runId !== undefined && { runId }) };
  }

  /**
   * Name the run for every pause on this signal that paused in it — this one
   * and its queued siblings that do not already carry a run (a sibling raised
   * again on resume keeps the run it paused in). Called once, when the
   * checkpoint is built.
   */
  completeExecution(runId: string): void {
    if (this._pausedExecution && this._pausedExecution.runId === undefined) this._pausedExecution.runId = runId;
    for (const pending of this._pendingPauses) {
      if (pending.pausedExecution && pending.pausedExecution.runId === undefined) {
        pending.pausedExecution = { runtimeStageId: pending.pausedExecution.runtimeStageId, runId };
      }
    }
  }

  /**
   * Prepend a subflow ID to the path (called during bubble-up). The pending
   * sibling pauses ride the same boundary, so their paths grow with it.
   */
  prependSubflow(subflowId: string): void {
    this._subflowPath.unshift(subflowId);
    for (const pending of this._pendingPauses) pending.subflowPath.unshift(subflowId);
  }

  /**
   * Queue a parallel sibling's pause behind this one (its path relative to
   * this signal's current level). Copied in: the entry is owned by the
   * signal from here on.
   */
  addPendingPause(pause: PendingPause): void {
    this._pendingPauses.push({
      pausedStageId: pause.pausedStageId,
      subflowPath: [...pause.subflowPath],
      subflowStates: { ...pause.subflowStates },
      ...(pause.pauseData !== undefined && { pauseData: pause.pauseData }),
      ...(pause.pausedBy && { pausedBy: pause.pausedBy }),
      ...(pause.pausedExecution &&
        typeof pause.pausedExecution.runtimeStageId === 'string' && { pausedExecution: { ...pause.pausedExecution } }),
    });
  }

  /**
   * Parallel siblings' pauses waiting behind this one, in the order they will
   * be asked. In flight, a sibling that paused in THIS run carries only its
   * runtimeStageId; `completeExecution` (at checkpoint build) adds the run.
   */
  get pendingPauses(): readonly PendingPause[] {
    return this._pendingPauses as readonly PendingPause[];
  }

  /**
   * This pause as a {@link PendingPause} — what `ChildrenExecutor` queues
   * behind a sibling's pause when both paused in one fan-out.
   */
  toPendingPause(): PendingPause {
    // In flight (see `pendingPauses`): the run is added at checkpoint build.
    return <PendingPause>{
      pausedStageId: this.stageId,
      subflowPath: [...this._subflowPath],
      subflowStates: { ...this._subflowStates },
      ...(this.pauseData !== undefined && { pauseData: this.pauseData }),
      ...(this.pausedBy && { pausedBy: this.pausedBy }),
      ...(this._pausedExecution && { pausedExecution: { ...this._pausedExecution } }),
    };
  }

  /** The stage that invoked the paused child (decider, selector, fork). */
  get invokerStageId(): string | undefined {
    return this._invokerStageId;
  }

  /**
   * Stamp the invoker context during bubble-up.
   * Called by decider/selector/fork handlers when catching a child's PauseSignal.
   * First invoker wins (innermost) — subsequent calls are no-ops.
   */
  setInvoker(invokerStageId: string): void {
    if (!this._invokerStageId) this._invokerStageId = invokerStageId;
  }

  /**
   * Capture a subflow's isolated SharedMemory at the moment its
   * traversal threw. Called by `SubflowExecutor` once per subflow
   * boundary on the bubble-up path. Each capture is keyed by the
   * path-prefixed subflow id (the same id used in `subflowPath`).
   *
   * Innermost-first: a deep `Sequence(Agent(...))` pause captures the
   * agent's subflow first, then its parent's, all the way to the root
   * mount. The full nest survives into `checkpoint.subflowStates`.
   */
  captureSubflowScope(subflowId: string, state: Record<string, unknown>): void {
    // Defensive shallow clone so later mutations on the source don't
    // bleed into the captured snapshot. Deep cloning is the consumer's
    // responsibility (the resume target may not even be on this
    // process); SharedMemory values are conventionally JSON-friendly.
    this._subflowStates[subflowId] = { ...state };
  }

  /** Captured subflow scopes (read-only view). */
  get subflowStates(): Readonly<Record<string, Record<string, unknown>>> {
    return this._subflowStates;
  }
}

// ── PendingPause ────────────────────────────────────────────

/**
 * A pause a PARALLEL SIBLING of the paused stage raised in the same fan-out —
 * two children of one fork (or two selected branches of one selector) that
 * both paused (9.28.0). Only one pause is asked at a time: the checkpoint's
 * own (`pausedStageId`), then each of these in turn, with the fan-out's join
 * running only once every child is done.
 *
 * Everything needed to raise the sibling's pause again later WITHOUT re-running
 * the sibling: its stage, its path, its captured subflow state, its question.
 *
 * @example
 * ```typescript
 * // A fork whose two children both ask: the first checkpoint asks c1 and
 * // carries c2's pause; resuming it finishes c1, then pauses with c2's
 * // question; resuming THAT finishes c2 and runs the join.
 * const cp = executor.getCheckpoint()!;
 * cp.pausedStageId;                  // 'c1/ask'
 * cp.pendingPauses?.[0].pausedStageId; // 'c2/ask'
 * ```
 */
export interface PendingPause {
  /** The sibling's paused stage (path-prefixed id, as `pausedStageId`). */
  readonly pausedStageId: string;
  /** Path through subflows to the sibling's paused stage (as `subflowPath`). */
  readonly subflowPath: readonly string[];
  /**
   * The sibling's own subflow captures — the subflows on ITS path below the
   * fan-out. The subflows above the fan-out are shared with the checkpoint's
   * own pause and are captured again when this pause is raised.
   */
  readonly subflowStates: Record<string, Record<string, unknown>>;
  /** The sibling's question (as `pauseData`). */
  readonly pauseData?: unknown;
  /** How the sibling paused (as `pausedBy`). */
  readonly pausedBy?: 'interrupt';
  /** Which execution the sibling paused in (as `pausedExecution`, 9.37.0) — kept so its own resume links to it. */
  readonly pausedExecution?: PausedExecution;
}

/** A pending pause whose path still grows as its signal bubbles up (internal). */
/**
 * The signal's own copy of a pending pause. Its `pausedExecution` may still
 * lack the run (a sibling that paused in THIS run) until `completeExecution`.
 */
type MutablePendingPause = Omit<PendingPause, 'subflowPath' | 'pausedExecution'> & {
  subflowPath: string[];
  pausedExecution?: { runtimeStageId: string; runId?: string };
};

// ── PauseResult ─────────────────────────────────────────────

/**
 * Returned by a pausable stage's execute/resume function to signal pause.
 *
 * @example
 * ```typescript
 * execute: async (scope) => {
 *   scope.orderId = '123';
 *   return { pause: true, data: { question: 'Approve order 123?' } };
 * }
 * ```
 */
export interface PauseResult {
  readonly pause: true;
  /** Data to include in the checkpoint — question, reason, metadata. */
  readonly data?: unknown;
}

// ── FlowchartCheckpoint ─────────────────────────────────────

/**
 * Serializable checkpoint — everything needed to resume a paused flowchart.
 *
 * JSON-safe: no functions, no class instances, no SDK clients.
 * Store anywhere: Redis, Postgres, localStorage, a file.
 *
 * @example
 * ```typescript
 * // Save
 * const checkpoint = executor.getCheckpoint(); // after pause
 * await redis.set(`session:${id}`, JSON.stringify(checkpoint));
 *
 * // Resume (hours later, possibly different server)
 * const checkpoint = JSON.parse(await redis.get(`session:${id}`));
 * const executor = new FlowChartExecutor(chart);
 * await executor.resume(checkpoint, { approved: true });
 * ```
 */
/**
 * Serializable checkpoint — everything needed to resume a paused flowchart.
 *
 * The execution tree IS the traversed path. The leaf node with status 'paused'
 * IS the cursor. No separate path array needed — the tree structure captures
 * the full nesting (including subflows).
 *
 * JSON-safe: no functions, no class instances, no SDK clients.
 * Store anywhere: Redis, Postgres, localStorage, a file.
 *
 * @example
 * ```typescript
 * const checkpoint = executor.getCheckpoint(); // after pause
 * await redis.set(`session:${id}`, JSON.stringify(checkpoint));
 *
 * // Resume (hours later, possibly different server)
 * const checkpoint = JSON.parse(await redis.get(`session:${id}`));
 * const executor = new FlowChartExecutor(chart);
 * await executor.resume(checkpoint, { approved: true });
 * ```
 */
export interface FlowchartCheckpoint {
  /**
   * The checkpoint FORMAT (9.39.0): `1`. Absent on a checkpoint written
   * before 9.39.0, which `resume()` reads through the one upcaster
   * (`pause/record.ts · upcastCheckpoint`) — it drops the legacy
   * `continuationStageId` (a record no resume has read since 9.28.0). A
   * version this release does not know is refused.
   */
  readonly checkpointVersion?: 1;

  /** Scope state at the pause point — all shared memory key/values. */
  readonly sharedState: Record<string, unknown>;

  /** Execution tree — the traversed path. The leaf with status 'paused' is the cursor.
   *  Contains subflow nesting. Used for BTS visualization and to find the resume point. */
  readonly executionTree: unknown;

  /** ID of the stage that paused. Used by resume() to find the node in the graph. */
  readonly pausedStageId: string;

  /**
   * The paused EXECUTION (9.37.0): the run that paused and the paused stage's
   * runtimeStageId in it (the id its `onPause` event and its commit carry).
   * Read by `resume()` into the `onResume` event's `traversalContext.resumedFrom`
   * link — never used to plan the re-entry. Absent on an older checkpoint,
   * which then resumes without a link.
   */
  readonly pausedExecution?: PausedExecution;

  /** Path through subflows to the paused stage (e.g., ['sf-payment', 'sf-validation']).
   *  Empty array when paused at the top level. */
  readonly subflowPath: readonly string[];

  /** Data from $pause() — question, reason, metadata. */
  readonly pauseData?: unknown;

  /**
   * HOW the pause was raised. `'interrupt'` means a stage body called
   * `interrupt(scope, { reason, expects? })` and `pauseData` IS that payload;
   * absent means the `addPausableFunction` execute/resume path (every
   * checkpoint written before 9.14.0 omits it, which is exactly right).
   *
   * `resume()` reads this to pick the re-entry, and the two differ by law:
   * an interrupted stage RE-RUNS ITS OWN FUNCTION FROM THE TOP (stages are
   * atomic — the answer comes back out of the `interrupt()` call), while a
   * pausable stage runs its separate `resumeFn`.
   */
  readonly pausedBy?: 'interrupt';

  /** Subflow results collected before the pause. */
  readonly subflowResults?: Record<string, unknown>;

  /**
   * Subflow scope capture — one entry per subflow boundary on the path
   * to the paused stage. Keyed by path-prefixed subflow id (matches
   * `subflowPath` entries). Each value is the subflow's pre-pause
   * shared state.
   *
   * Always present (empty `{}` for root-level pauses where no subflows
   * were entered). On resume, `SubflowExecutor` seeds each nested runtime
   * on the path from this map — ONCE, on its first entry, in place of the
   * inputMapper's values (the mapper still runs, for the stages' read-only
   * args) — so resume handlers see pre-pause scope across same-executor AND
   * cross-executor restarts. Only the subflows ON `subflowPath` read it.
   */
  readonly subflowStates: Record<string, Record<string, unknown>>;

  /**
   * The shared execution counter at the moment of pause — the number of stages
   * executed so far this run. Resume seeds it so post-resume `runtimeStageId`s
   * (`stageId#executionIndex`) keep climbing and never collide with pre-pause
   * ones, which is what the whole event-correlation model rests on.
   *
   * Optional for backward compatibility: a checkpoint persisted before this
   * field existed (older Redis/Postgres rows) still validates and resumes with
   * the previous (counter-restarting) behavior.
   */
  readonly executionCount?: number;

  /**
   * Per-`stageId` loop visit counts at the moment of pause. Resume seeds them
   * so `TraversalContext.loopIteration` stays continuous across the pause (a
   * mid-loop resume keeps counting up, not restarting at 0) and the
   * ContinuationResolver iteration budget is not silently refilled.
   *
   * Optional for the same backward-compatibility reason as `executionCount`.
   */
  readonly visitCounts?: Readonly<Record<string, number>>;

  /** Stage that invoked the paused child (decider, selector, fork). Absent for linear pauses. */
  readonly invokerStageId?: string;

  /**
   * Pauses raised by PARALLEL SIBLINGS of the paused stage in the same
   * fan-out, waiting their turn (9.28.0) — see {@link PendingPause}. Absent
   * when only one child paused (every checkpoint before 9.28.0 omits it, and
   * resumes exactly as before). Resuming this checkpoint finishes the paused
   * stage's child, then pauses again with the first of these; the fan-out's
   * join runs once every child is done.
   */
  readonly pendingPauses?: readonly PendingPause[];

  /**
   * The redaction marks of the paused run — NAMES only (see
   * {@link RedactionMarks}). Absent when the run marked nothing (no policy
   * and no per-call mark, or an older checkpoint): the resumed run then starts
   * from its policy alone.
   */
  readonly redactionMarks?: RedactionMarks;

  /** Timestamp of when the pause occurred. */
  readonly pausedAt: number;
}

// ── PausableHandler ─────────────────────────────────────────

/**
 * Handler for a pausable stage — has two phases: execute and resume.
 *
 * `execute` runs the first time. Return any non-void value to pause (that value
 * becomes the checkpoint's `pauseData`); return void/undefined to continue normally.
 * `resume` runs when the flowchart is resumed. It receives the resume input.
 *
 * Both phases receive the same scope. After execute pauses, the scope state
 * is preserved in the checkpoint. On resume, the scope is restored before
 * calling resume.
 *
 * @example
 * ```typescript
 * .addPausableFunction('ApproveOrder', {
 *   execute: async (scope) => {
 *     scope.orderId = '123';
 *     scope.amount = 299;
 *     return { question: `Approve $${scope.amount} refund?` };
 *   },
 *   resume: async (scope, input) => {
 *     scope.approved = input.approved;
 *     scope.approver = input.approver;
 *   },
 * }, 'approve-order', 'Manager approval gate')
 *
 * // Later — resume with human's answer
 * await executor.resume(checkpoint, { approved: true, approver: 'Jane' });
 * ```
 */
export interface PausableHandler<TScope = any, TInput = unknown, TPauseData = unknown> {
  /**
   * First-run phase. Return data to pause, or void/undefined to continue normally.
   *
   * Any non-void return value becomes the `pauseData` in the checkpoint.
   * The consumer defines the `TPauseData` type — the FE uses it to render
   * the right UI (form fields, approval buttons, etc.).
   *
   * @example
   * ```typescript
   * // TPauseData = { question: string; riskLevel: string }
   * const handler: PausableHandler<MyState, { approved: boolean }, { question: string; riskLevel: string }> = {
   *   execute: async (scope) => {
   *     return { question: `Approve order ${scope.orderId}?`, riskLevel: 'high' };
   *   },
   *   resume: async (scope, input) => {
   *     scope.approved = input.approved;
   *   },
   * };
   * ```
   */
  execute: (scope: TScope) => Promise<TPauseData | void> | TPauseData | void;
  /**
   * Resume phase. Called with the resume input when execution continues.
   *
   * The scope is restored from the checkpoint's `sharedState`. Writes during
   * `resume` are committed and visible to subsequent stages.
   */
  resume: (scope: TScope, input: TInput) => Promise<void> | void;
}

// ── Type guard ──────────────────────────────────────────────

/** Check if a value is a PauseResult (stage wants to pause). */
export function isPauseResult(value: unknown): value is PauseResult {
  return typeof value === 'object' && value !== null && (value as PauseResult).pause === true;
}

/** Check if an error is a PauseSignal. Uses instanceof + name brand fallback for cross-realm safety. */
export function isPauseSignal(error: unknown): error is PauseSignal {
  // Total: a Proxy whose `getPrototypeOf` trap throws (or a revoked Proxy)
  // is not a signal — the engine's catch blocks ask this first, and must
  // not trade the stage's thrown value for the trap's error.
  try {
    return (
      error instanceof PauseSignal ||
      (error instanceof Error &&
        error.name === 'PauseSignal' &&
        Object.prototype.hasOwnProperty.call(error, 'pauseData') &&
        Object.prototype.hasOwnProperty.call(error, 'stageId'))
    );
  } catch {
    return false;
  }
}
