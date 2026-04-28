/**
 * Pause/Resume — serializable checkpoint for long-running or human-in-the-loop flows.
 *
 * A stage signals pause by calling `scope.$pause(data)` which throws a PauseSignal.
 * The signal bubbles up through SubflowExecutor → FlowchartTraverser → FlowChartExecutor,
 * each level adding its subflow ID to the path.
 *
 * The checkpoint captures:
 *   - pausedPath: full path to the paused stage (e.g., ['sf-payment', 'approve'])
 *   - sharedState: scope at the pause point
 *   - executionTree: completed stages for BTS/narrative
 *   - pauseData: question, reason, or metadata from $pause()
 *
 * Resume rebuilds the flowchart, restores scope, navigates to the paused stage,
 * injects resumeInput, and continues traversal.
 *
 * Supported topologies: linear, subflow, lazy subflow, loop, nested subflow in loop.
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

  constructor(data: unknown, stageId: string) {
    super('Execution paused');
    this.name = 'PauseSignal';
    this.pauseData = data;
    this.stageId = stageId;
    this._subflowPath = [];
    // PauseSignal is control flow, not a real error — stack trace has no diagnostic value.
    this.stack = '';
  }

  get subflowPath(): readonly string[] {
    return this._subflowPath;
  }

  /** Prepend a subflow ID to the path (called during bubble-up). */
  prependSubflow(subflowId: string): void {
    this._subflowPath.unshift(subflowId);
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
   * from this map (and skips the inputMapper) so resume handlers see
   * pre-pause scope across same-executor AND cross-executor restarts.
   */
  readonly subflowStates: Record<string, Record<string, unknown>>;

  /** Stage that invoked the paused child (decider, selector, fork). Absent for linear pauses. */
  readonly invokerStageId?: string;

  /** Where to continue after resume — the invoker's next node ID. Absent for linear pauses. */
  readonly continuationStageId?: string;

  /** Timestamp of when the pause occurred. */
  readonly pausedAt: number;
}

// ── PausableHandler ─────────────────────────────────────────

/**
 * Handler for a pausable stage — has two phases: execute and resume.
 *
 * `execute` runs the first time. It can return `{ pause: true }` to pause.
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
 *     return { pause: true, data: { question: `Approve $${scope.amount} refund?` } };
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
