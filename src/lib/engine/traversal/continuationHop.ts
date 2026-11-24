import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../types.js';

/**
 * Trampoline brand — marks a continuation hop returned by `executeNodeStep`
 * to the driver loop in `executeNode`. Internal engine symbol so a stage's own
 * return value (which can be any object) can never be mistaken for a hop.
 */
export const CONTINUE_HOP: unique symbol = Symbol('footprintjs.executeNode.continue');

/**
 * A flat continuation — "execute this node next, in this context" — returned
 * by `executeNodeStep` for every TAIL continuation (linear `next`, loop
 * edges, dynamic next, dynamic-subflow re-entry, no-continuation decider
 * dispatch). The driver loop in `executeNode` consumes hops iteratively:
 * `current = hop; continue;` — so neither the call stack nor the retained
 * promise chain grows with chain length or loop iterations.
 */
export interface ContinuationHop<TOut = any, TScope = any> {
  readonly [CONTINUE_HOP]: true;
  readonly node: StageNode<TOut, TScope>;
  readonly context: StageContext;
  readonly branchPath: string | undefined;
  /**
   * Present when the hop is a decider's branch dispatch (decider without its
   * own `next`). The driver records it so a PauseSignal thrown anywhere in
   * the continued chain still gets the decider stamped as its invoker —
   * exactly what the recursive dispatch's catch used to do.
   */
  readonly invokerStamp?: InvokerStamp;
  /**
   * Present when the hop follows a LOOP edge (a back-reference resolved by
   * `ContinuationResolver`). A decider's branch frame hands such a hop back
   * to its decider when the target is not a node the frame ran, so the loop
   * re-enters at the target's own level — flat, never one frame per pass.
   */
  readonly loop?: true;
}

/** Pause-invoker context recorded by the driver for flat decider dispatches. */
export interface InvokerStamp {
  readonly invokerStageId: string;
}

export function isContinuationHop<TOut, TScope>(value: unknown): value is ContinuationHop<TOut, TScope> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[CONTINUE_HOP] === true;
}
