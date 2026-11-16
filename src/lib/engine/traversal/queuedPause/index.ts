import type { RunCorrelation } from '../../../attempt/types.js';
import type { StageContext } from '../../../memory/StageContext.js';
import { isPauseSignal } from '../../../pause/types.js';
import type { QueuedPause } from '../../handlers/ResumeEntry.js';
import { queueBehind, raiseQueuedPause } from '../../handlers/ResumeEntry.js';
import { servedPause } from '../../handlers/servedPause.js';
import type { IControlFlowNarrative } from '../../narrative/types.js';
import { rootTraversalContext } from '../../traversalContext.js';

/**
 * A resume's entry chain at a level where parallel siblings' pauses wait
 * (9.28.0): run the chain — the resumed child only, the fan-out's join is
 * NOT attached — then raise the first waiting pause again, the rest behind
 * it. Nothing of the sibling re-runs; its question comes back as it was
 * asked. A pause raised from inside the chain (the resumed child asking
 * again) carries every waiting sibling instead, so none is ever dropped.
 */
export async function walkThenRaise(
  walk: () => Promise<unknown>,
  context: StageContext,
  waiting: readonly QueuedPause[],
  narrative: IControlFlowNarrative,
  runId: string,
  correlation: RunCorrelation | undefined,
): Promise<never> {
  try {
    await walk();
  } catch (error: unknown) {
    if (isPauseSignal(error)) queueBehind(error, waiting);
    throw error;
  }
  const { pause, stageName } = waiting[0];
  narrative.onPause(
    stageName,
    pause.pausedStageId,
    servedPause(context, pause.pauseData),
    pause.subflowPath,
    // This leg re-raised a queued sibling; it did not execute that sibling again. Keep the original
    // pausedExecution on the signal, and stamp this notification with the current leg's root identity.
    rootTraversalContext(runId, correlation),
  );
  throw raiseQueuedPause(waiting);
}
