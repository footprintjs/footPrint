/**
 * commitStage — a stage's SUCCESS commit, failing loudly.
 *
 * The commit is where a stage's writes are detached (`structuredClone`), so a
 * value nothing can clone — a function, a foreign Proxy — fails HERE, after
 * the stage function returned and outside its catch. Through 9.39.0 such a
 * failure rejected `run()` with no `onError` (and a fork child's was dropped
 * outright); it is a stage failure like any other, so `onError` fires for the
 * stage before the error propagates.
 */

import type { CommitPhase } from 'foottrace';

import type { StageContext } from '../../memory/StageContext.js';
import type { IControlFlowNarrative, TraversalContext } from '../narrative/types.js';
import { captureStageFailure, noteUnreportedFailure, recordStageError } from './stageError.js';

/**
 * All native stage commits own their exact escaping commit error, including
 * commits while another error or pause was bubbling. Capture safe ownership
 * only; existing diagnostic/event behavior stays with the caller.
 */
export function commitStageWrites(context: StageContext, phase?: CommitPhase): void {
  try {
    if (phase === undefined) context.commit();
    else context.commit(phase);
  } catch (error: unknown) {
    captureStageFailure(context, error, true);
    throw error;
  }
}

export function commitStage(
  context: StageContext,
  narrative: IControlFlowNarrative,
  stageName: string,
  traversalContext?: TraversalContext,
): void {
  try {
    commitStageWrites(context);
  } catch (error: unknown) {
    const served = recordStageError(context, error);
    narrative.onError(stageName, served.message, served.structuredError, traversalContext);
    throw error;
  }
}

/**
 * A commit while an error or pause is already unwinding has no later stage-error report if it throws.
 * Keep the exact escaping commit failure and existing event/rejection order; only its native sink note is new.
 */
export function commitStageStopping(context: StageContext, phase?: CommitPhase): void {
  try {
    commitStageWrites(context, phase);
  } catch (error: unknown) {
    noteUnreportedFailure(context, error);
    throw error;
  }
}
