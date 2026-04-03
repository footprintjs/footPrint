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
export interface PausableHandler<TScope = any, TInput = unknown> {
  /**
   * First-run phase. Return data to pause, or void/undefined to continue normally.
   *
   * Any non-void return value becomes the `pauseData` in the checkpoint.
   * The library detects the return and pauses automatically — no need to
   * call `pause()` or construct `{ pause: true }`.
   *
   * @example
   * ```typescript
   * execute: async (scope) => {
   *   scope.orderId = '123';
   *   return { question: `Approve order ${scope.orderId}?` }; // ← pauses
   * }
   *
   * // Conditional pause
   * execute: async (scope) => {
   *   if (scope.amount > 500) {
   *     return { reason: 'High-value order needs approval' }; // ← pauses
   *   }
   *   // void return → no pause, continues normally
   * }
   * ```
   */
  execute: (scope: TScope) => Promise<unknown> | unknown;
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
