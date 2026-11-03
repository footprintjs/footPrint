/**
 * NullControlFlowNarrativeGenerator — explicit no-op narrative strategy.
 *
 * Advanced hosts can inject this strategy to suppress all narrative callbacks.
 * The normal disabled-narrative path still dispatches eligible component observers.
 * Hooks retain no state or prose; getSentences() returns a fresh caller-owned array.
 */

import type { IControlFlowNarrative } from './types.js';

/* eslint-disable @typescript-eslint/no-empty-function */
export class NullControlFlowNarrativeGenerator implements IControlFlowNarrative {
  onStageExecuted(): void {}
  onNext(): void {}
  onDecision(): void {}
  onFork(): void {}
  onSelected(): void {}
  onSubflowEntry(): void {}
  onSubflowExit(): void {}
  onSubflowRegistered(): void {}
  onLoop(): void {}
  onBreak(): void {}
  onError(): void {}
  onAttempt(): void {}
  onStageRetry(): void {}
  onPause(): void {}
  onResume(): void {}
  onRunStart(): void {}
  onRunEnd(): void {}
  onRunFailed(): void {}
  getSentences(): string[] {
    return [];
  }
}
