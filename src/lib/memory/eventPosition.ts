/** Coordinates of an existing log within a recording/session, not a second event timeline. */
export interface LogAddress {
  /** Engine leg that first owned this log; unchanged by a same-executor root resume. */
  readonly logRunId: string;
  /** Actual mount runtime IDs, outermost first. Root log: []. Never static subflow IDs. */
  readonly drillPath: readonly string[];
}

/**
 * The committed prefix present when an event was emitted. Does NOT describe
 * the emitter's staged writes, first-touch read view, or eventual own commit.
 * Several events can share a position; this is not a total event order.
 */
export interface EmitSourcePosition extends LogAddress {
  /** Engine leg that created the emitting frame (not the scope's memory namespace). */
  readonly runId: string;
  /** Inclusive index in the addressed log; -1 means only its fold base existed. */
  readonly committedThroughIdx: number;
}
