/**
 * TraversalDepthError — the traversal depth cap was reached.
 *
 * Thrown by `FlowchartTraverser · executeNode` when a node would be driven
 * one NESTING level past `maxDepth` (fork/selector children, a decider's
 * branch when the decider has a `next` of its own, recursive composition —
 * never linear chains, loop passes or parallel siblings).
 *
 * It is a run failure, never a contained child result: `ChildrenExecutor`
 * rethrows it whatever the fan-out's error mode, so `run()` rejects with it
 * instead of resolving with dropped work. It lives with the handlers so
 * `ChildrenExecutor` can recognise it without importing the traverser.
 */
export class TraversalDepthError extends Error {
  /** The cap that was reached (`RunOptions.maxDepth`, default 500). */
  readonly maxDepth: number;
  /** The stage that would have run past the cap. */
  readonly stageName: string;

  constructor(maxDepth: number, stageName: string) {
    super(
      `FlowchartTraverser: maximum traversal depth exceeded (${maxDepth}). ` +
        'Depth counts NESTED dispatch (fork children, decider/selector branches, recursive composition) — ' +
        'linear chains, loop iterations and parallel siblings do not consume it. ' +
        `Last stage: '${stageName}'. ` +
        'Check for unbounded recursive chart composition, or raise the limit via RunOptions.maxDepth.',
    );
    this.name = 'TraversalDepthError';
    this.maxDepth = maxDepth;
    this.stageName = stageName;
  }
}

/** Brand check (instanceof + name) — survives a second copy of the library. */
export function isTraversalDepthError(error: unknown): error is TraversalDepthError {
  try {
    return error instanceof TraversalDepthError || (error instanceof Error && error.name === 'TraversalDepthError');
  } catch {
    return false; // a hostile Proxy (throwing getPrototypeOf) is not a depth error
  }
}
