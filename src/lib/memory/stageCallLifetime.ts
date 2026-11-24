import { callsEndedReason } from '../errors/callsEnded/index.js';

/**
 * The signal the calls of stage attempt `stageAttempt` run under besides its own (P2): aborted when that attempt is
 * over — however it ended — and when the frame commits, so no call outlives the attempt that made it (no
 * background retry, no wait, no listener left on the run's signal). Already aborted after the commit.
 */
export function callEndSignal(
  ended: Map<number, AbortController>,
  stageAttempt: number,
  committed: boolean,
): AbortSignal {
  let controller = ended.get(stageAttempt);
  if (controller === undefined) {
    controller = new AbortController();
    ended.set(stageAttempt, controller);
    if (committed) controller.abort(callsEndedReason());
  }
  return controller.signal;
}

/** End the calls of `stageAttempt` (every attempt's when `undefined`) — `reason` when the attempt's signal gave one. */
export function endCallsFor(
  ended: Map<number, AbortController>,
  stageAttempt: number | undefined,
  reason?: unknown,
): void {
  for (const [attempt, controller] of ended) {
    if (stageAttempt !== undefined && attempt !== stageAttempt) continue;
    if (!controller.signal.aborted) controller.abort(reason ?? callsEndedReason());
  }
}
