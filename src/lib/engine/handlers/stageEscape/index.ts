import type { StageContext } from '../../../memory/StageContext.js';
import { keepsRunEvidence, noteEvidenceStop } from '../../../memory/storedEvidence/index.js';
import type { PauseSignal } from '../../../pause/types.js';
import { commitStageStopping } from '../commitStage.js';
import { servedPause } from '../servedPause.js';
import { captureStageFailure, recordStageError } from '../stageError.js';

/** Synchronous native failure preparation; caller owns its logger/event order and original rethrow. */
export function finishStageFailure(context: StageContext, error: unknown): ReturnType<typeof recordStageError> {
  captureStageFailure(context, error);
  commitStageStopping(context);
  return recordStageError(context, error);
}

/** Commit first, then serve once for both the native note and the caller's existing pause event. */
export function finishStagePause(context: StageContext, error: PauseSignal): unknown {
  commitStageStopping(context);
  const payload = servedPause(context, error.pauseData);
  if (keepsRunEvidence(context))
    noteEvidenceStop(context, { by: 'pause', pausedBy: error.pausedBy ?? 'pausable', payload });
  return payload;
}
