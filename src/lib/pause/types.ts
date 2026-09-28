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
   * Captured during traversal (not reconstructed from the tree).
   *
   * `continuationStageId` is the invoker's `.next` node — where execution
   * should continue after resume. Without this, branch children have no
   * `.next` pointer and resume would terminate early.
   */
  private _invokerStageId?: string;
  private _continuationStageId?: string;

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
    });
  }

  /** Parallel siblings' pauses waiting behind this one, in the order they will be asked. */
  get pendingPauses(): readonly PendingPause[] {
    return this._pendingPauses;
  }

  /**
   * This pause as a {@link PendingPause} — what `ChildrenExecutor` queues
   * behind a sibling's pause when both paused in one fan-out.
   */
  toPendingPause(): PendingPause {
    return {
      pausedStageId: this.stageId,
      subflowPath: [...this._subflowPath],
      subflowStates: { ...this._subflowStates },
      ...(this.pauseData !== undefined && { pauseData: this.pauseData }),
      ...(this.pausedBy && { pausedBy: this.pausedBy }),
    };
  }

  /** The stage that invoked the paused child (decider, selector, fork). */
  get invokerStageId(): string | undefined {
    return this._invokerStageId;
  }

  /** Where execution should continue after resume (invoker's next node). */
  get continuationStageId(): string | undefined {
    return this._continuationStageId;
  }

  /**
   * Stamp the invoker context during bubble-up.
   * Called by decider/selector/fork handlers when catching a child's PauseSignal.
   * First invoker wins (innermost) — subsequent calls are no-ops.
   */
  setInvoker(invokerStageId: string, continuationStageId?: string): void {
    if (!this._invokerStageId) {
      this._invokerStageId = invokerStageId;
      this._continuationStageId = continuationStageId;
    }
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
}

/** A pending pause whose path still grows as its signal bubbles up (internal). */
type MutablePendingPause = Omit<PendingPause, 'subflowPath'> & { subflowPath: string[] };

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
  /** Scope state at the pause point — all shared memory key/values. */
  readonly sharedState: Record<string, unknown>;

  /** Execution tree — the traversed path. The leaf with status 'paused' is the cursor.
   *  Contains subflow nesting. Used for BTS visualization and to find the resume point. */
  readonly executionTree: unknown;

  /** ID of the stage that paused. Used by resume() to find the node in the graph. */
  readonly pausedStageId: string;

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
   * The invoker's next node ID. Absent for linear pauses.
   *
   * A RECORD, not an instruction: since 9.28.0 `resume()` derives what runs
   * after the paused stage from the chart itself (the stage's own `next`, else
   * the continuation of the dispatcher that ran it — at every level of the
   * pause path), so an edited value cannot redirect a resumed run.
   */
  readonly continuationStageId?: string;

  /**
   * Pauses raised by PARALLEL SIBLINGS of the paused stage in the same
   * fan-out, waiting their turn (9.28.0) — see {@link PendingPause}. Absent
   * when only one child paused (every checkpoint before 9.28.0 omits it, and
   * resumes exactly as before). Resuming this checkpoint finishes the paused
   * stage's child, then pauses again with the first of these; the fan-out's
   * join runs once every child is done.
   */
  readonly pendingPauses?: readonly PendingPause[];

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
  return (
    error instanceof PauseSignal ||
    (error instanceof Error &&
      error.name === 'PauseSignal' &&
      Object.prototype.hasOwnProperty.call(error, 'pauseData') &&
      Object.prototype.hasOwnProperty.call(error, 'stageId'))
  );
}
