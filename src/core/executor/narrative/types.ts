/**
 * types.ts — Narrative Generation Interface
 *
 * WHY: Defines the contract that handlers call during pipeline traversal to
 * build a human-readable execution story. By coding to an interface, the
 * Pipeline can swap between a real NarrativeGenerator (when enabled) and a
 * NullNarrativeGenerator (when disabled) — the Null Object pattern gives
 * zero-cost narrative when consumers don't opt in.
 *
 * DESIGN: Each method maps 1-to-1 with a pipeline execution event. Handlers
 * call the method at traversal time (the richest context point) rather than
 * reconstructing narrative after the fact from FlowMessages. This keeps
 * sentence generation simple and execution-order guaranteed.
 *
 * RELATED:
 * - {@link NarrativeGenerator} - Active implementation that accumulates sentences
 * - {@link NullNarrativeGenerator} - No-op implementation for zero-cost disabled path
 * - {@link PipelineContext} - Holds the generator instance passed to handlers
 *
 * _Requirements: 9.2, 9.4_
 */

// ─────────────────────────────────────────────────────────────────────────────
// Narrative Generator Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contract for narrative generation during pipeline traversal.
 *
 * WHY: Provides a clear interface that handlers call to append human-readable
 * sentences to the narrative. Decouples sentence generation from execution
 * logic so the narrative module can be maintained and tested independently.
 *
 * DESIGN: Methods accept raw stage/branch names plus optional displayNames.
 * The implementation decides formatting — callers never construct sentences.
 * When narrative is disabled, the NullNarrativeGenerator satisfies this
 * interface with empty method bodies (zero allocation, zero string work).
 *
 * @example
 * ```typescript
 * // During handler execution:
 * narrativeGenerator.onStageExecuted('validateInput', 'validate user input');
 * narrativeGenerator.onNext('validateInput', 'checkPerms', 'check permissions');
 * narrativeGenerator.onDecision('roleCheck', 'admin', 'grant full access', 'user role equals admin');
 *
 * // After execution:
 * const story = narrativeGenerator.getSentences();
 * // → [
 * //   "The process began with validate user input.",
 * //   "Next, it moved on to check permissions.",
 * //   "A decision was made: user role equals admin, so the path taken was grant full access."
 * // ]
 * ```
 *
 * _Requirements: 9.2, 9.4_
 */
export interface INarrativeGenerator {
  /**
   * Called when a stage begins execution.
   *
   * WHY: Captures the "what happened" for each stage in the traversal path.
   * The first stage uses a distinct opening sentence pattern.
   *
   * @param stageName - Internal stage identifier (fallback when no displayName)
   * @param displayName - Human-readable name preferred for narrative output
   *
   * _Requirements: 3.1, 8.2_
   */
  onStageExecuted(stageName: string, displayName?: string): void;

  /**
   * Called when the pipeline transitions from one stage to the next.
   *
   * WHY: Captures linear continuations so the reader can follow the
   * execution path step by step.
   *
   * @param fromStage - The stage being left
   * @param toStage - The stage being entered (fallback when no displayName)
   * @param toDisplayName - Human-readable name of the target stage
   *
   * _Requirements: 3.2, 8.2_
   */
  onNext(fromStage: string, toStage: string, toDisplayName?: string): void;

  /**
   * Called when a decider selects a branch.
   *
   * WHY: Decision points are the most valuable part of the narrative for
   * LLM context engineering — knowing *why* a branch was taken lets even
   * a cheaper model reason about the execution.
   *
   * @param deciderName - Name of the decider stage
   * @param chosenBranch - Internal name of the selected branch
   * @param chosenDisplayName - Human-readable name of the selected branch
   * @param rationale - Why this branch was chosen (natural-language clause)
   *
   * _Requirements: 4.1, 4.2, 4.3, 8.3_
   */
  onDecision(deciderName: string, chosenBranch: string, chosenDisplayName?: string, rationale?: string): void;

  /**
   * Called when a fork executes all children in parallel.
   *
   * WHY: Captures the fan-out so the reader knows which paths ran
   * concurrently.
   *
   * @param parentStage - The fork stage that spawned the children
   * @param childNames - Names of all children being executed
   *
   * _Requirements: 5.1_
   */
  onFork(parentStage: string, childNames: string[]): void;

  /**
   * Called when a selector picks a subset of children to execute.
   *
   * WHY: Captures which children were selected and how many were available,
   * so the reader understands the selection decision.
   *
   * @param parentStage - The selector stage
   * @param selectedNames - Names of the selected children
   * @param totalCount - Total number of children available
   *
   * _Requirements: 5.2_
   */
  onSelected(parentStage: string, selectedNames: string[], totalCount: number): void;

  /**
   * Called when entering a subflow.
   *
   * WHY: Marks the boundary where execution dives into a nested context,
   * helping the reader follow the nesting structure.
   *
   * @param subflowName - Display name of the subflow being entered
   *
   * _Requirements: 7.1_
   */
  onSubflowEntry(subflowName: string): void;

  /**
   * Called when exiting a subflow.
   *
   * WHY: Marks the return from a nested context back to the parent flow.
   *
   * @param subflowName - Display name of the subflow being exited
   *
   * _Requirements: 7.2_
   */
  onSubflowExit(subflowName: string): void;

  /**
   * Called when a loop iteration occurs (dynamic next loops back).
   *
   * WHY: Captures repeated execution so the reader can track iteration
   * counts and understand retry/loop behavior.
   *
   * @param targetStage - The stage being looped back to
   * @param targetDisplayName - Human-readable name of the target stage
   * @param iteration - 1-based iteration number
   *
   * _Requirements: 6.1, 6.2, 8.4_
   */
  onLoop(targetStage: string, targetDisplayName: string | undefined, iteration: number): void;

  /**
   * Called when a stage calls the break function to stop execution.
   *
   * WHY: Captures early termination so the reader knows where and why
   * the pipeline stopped before reaching the natural end.
   *
   * @param stageName - The stage that triggered the break
   * @param displayName - Human-readable name of the stage
   *
   * _Requirements: 3.3_
   */
  onBreak(stageName: string, displayName?: string): void;

  /**
   * Called when a stage throws an error during execution.
   *
   * WHY: Captures failure points so the reader (or a follow-up LLM)
   * can understand what went wrong and where.
   *
   * @param stageName - The stage where the error occurred
   * @param errorMessage - Human-readable error description
   * @param displayName - Human-readable name of the stage
   *
   * _Requirements: 10.1, 10.2_
   */
  onError(stageName: string, errorMessage: string, displayName?: string): void;

  /**
   * Returns the accumulated narrative sentences in execution order.
   *
   * WHY: This is the final output — an ordered array of plain-English
   * sentences that any consumer (LLM, logger, UI) can use directly.
   *
   * @returns Ordered array of narrative sentences
   *
   * _Requirements: 2.1, 2.2_
   */
  getSentences(): string[];
}
