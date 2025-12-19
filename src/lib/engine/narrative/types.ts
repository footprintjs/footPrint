/**
 * IControlFlowNarrative — Interface for control flow narrative generation.
 *
 * Captures FLOW events during traversal: decisions, forks, loops, subflows.
 * Complementary to scope/recorders/NarrativeRecorder which captures DATA events.
 *
 * Uses Null Object pattern: NullControlFlowNarrativeGenerator satisfies this
 * interface with empty methods for zero-cost disabled path.
 */

export interface IControlFlowNarrative {
  /** Called when a stage executes. First stage uses distinct opening pattern. */
  onStageExecuted(stageName: string, displayName?: string, description?: string): void;

  /** Called on linear continuation from one stage to the next. */
  onNext(fromStage: string, toStage: string, toDisplayName?: string, description?: string): void;

  /** Called when a decider selects a branch. Most valuable for LLM context. */
  onDecision(deciderName: string, chosenBranch: string, chosenDisplayName?: string, rationale?: string, deciderDescription?: string): void;

  /** Called when a fork executes all children in parallel. */
  onFork(parentStage: string, childNames: string[]): void;

  /** Called when a selector picks a subset of children. */
  onSelected(parentStage: string, selectedNames: string[], totalCount: number): void;

  /** Called when entering a subflow (nested context boundary). */
  onSubflowEntry(subflowName: string): void;

  /** Called when exiting a subflow. */
  onSubflowExit(subflowName: string): void;

  /** Called on loop iteration (back-edge traversal). */
  onLoop(targetStage: string, targetDisplayName: string | undefined, iteration: number, description?: string): void;

  /** Called when a stage triggers break (early termination). */
  onBreak(stageName: string, displayName?: string): void;

  /** Called when a stage throws an error. */
  onError(stageName: string, errorMessage: string, displayName?: string): void;

  /** Returns accumulated narrative sentences in execution order. */
  getSentences(): string[];
}
