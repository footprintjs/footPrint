import type { FlowchartCheckpoint } from '../pause/types.js';

export type NodeResultType = {
  id: string;
  result: unknown;
  isError?: boolean;
};

export type BranchResult = {
  result: string | Error;
  isError: boolean;
};

export type BranchResults = { [branchId: string]: BranchResult };
export type TraversalResult = BranchResults | string | Error;

/** Returned by run()/resume() when execution pauses. */
export type PausedResult = {
  readonly paused: true;
  readonly checkpoint: FlowchartCheckpoint;
};

/** Full return type of FlowChartExecutor.run() and resume(). */
export type ExecutorResult = TraversalResult | PausedResult;
