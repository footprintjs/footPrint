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

import { thrownText } from '../../errors/errorInfo.js';
import type { StageContext } from '../../memory/StageContext.js';
import type { IControlFlowNarrative, TraversalContext } from '../narrative/types.js';

export function commitStage(
  context: StageContext,
  narrative: IControlFlowNarrative,
  stageName: string,
  traversalContext?: TraversalContext,
): void {
  try {
    context.commit();
  } catch (error: unknown) {
    narrative.onError(stageName, thrownText(error), error, traversalContext);
    throw error;
  }
}
