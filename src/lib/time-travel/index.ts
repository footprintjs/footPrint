/**
 * time-travel/ — the reader's cursor over a finished trace.
 *
 * Time travel here is READ-TIME: a cursor over a Trace that has already
 * happened, with a Fold at each stop. It is not the Walker and never becomes a
 * second live cursor — nothing in this folder can move, re-run or mutate an
 * execution.
 *
 * See README.md for the five laws, the strategy seam, and a worked example of
 * every export.
 *
 * DAG position: memory ← time-travel (plus `engine/runtimeStageId`, the
 * zero-dependency id grammar).
 */

export { commitStops, commitStopsStrategy } from './commitStops.js';
export { stateAt } from './stateAt.js';
export { timeTravel } from './timeTravel.js';
export type {
  FoldBasis,
  FoldedState,
  FoldSource,
  Mark,
  Move,
  MoveRefusal,
  Stop,
  StopKind,
  TimeTravel,
  TimeTravelOptions,
  TimeTravelSource,
  TimeTravelStrategy,
} from './types.js';
