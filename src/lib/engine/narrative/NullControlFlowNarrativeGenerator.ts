/**
 * NullControlFlowNarrativeGenerator — Zero-cost no-op (Null Object pattern).
 *
 * When narrative is disabled, handlers call this unconditionally.
 * All methods are empty bodies — zero allocation, zero string formatting.
 * getSentences() returns a bare [] literal to avoid even a single array allocation.
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
  getSentences(): string[] {
    return [];
  }
}
