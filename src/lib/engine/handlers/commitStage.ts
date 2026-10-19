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

import type { StageContext } from '../../memory/StageContext.js';
import type { IControlFlowNarrative, TraversalContext } from '../narrative/types.js';
import { captureStageFailure, recordStageError } from './stageError.js';

/**
 * All native stage commits own their exact escaping commit error, including
 * commits while another error or pause was bubbling. Capture safe ownership
 * only; existing diagnostic/event behavior stays with the caller.
 */
export function commitStageWrites(context: StageContext, traversalContext?: TraversalContext): void {
  try {
    context.commit();
  } catch (error: unknown) {
    captureStageFailure(context, error, traversalContext);
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
    commitStageWrites(context, traversalContext);
  } catch (error: unknown) {
    const served = recordStageError(context, error, traversalContext);
    narrative.onError(stageName, served.message, served.structuredError, traversalContext);
    throw error;
  }
}
