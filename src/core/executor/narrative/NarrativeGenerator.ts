/**
 * NarrativeGenerator — Active implementation of INarrativeGenerator
 *
 * WHY: Converts pipeline execution events into plain-English sentences at
 * traversal time, producing a human-readable story as a first-class output.
 * This enables any consumer — a cheaper LLM, a follow-up agent, a logging
 * system — to understand what happened without parsing technical structures.
 *
 * RESPONSIBILITIES:
 * - Accumulate narrative sentences in execution order
 * - Apply consistent sentence patterns for each event type
 * - Use stage description (build-time) for natural narrative output
 * - Fall back to displayName then stageName for stage identification
 * - Format decider rationale as natural-language clauses
 * - Format loop iterations as ordinal references
 * - Return a defensive copy of sentences to prevent external mutation
 *
 * DESIGN DECISIONS:
 * - Traversal-time generation: Sentences are appended as handlers execute,
 *   not reconstructed after the fact. This guarantees execution-order fidelity
 *   and avoids a post-processing walk.
 * - isFirstStage flag: The opening sentence uses a distinct pattern
 *   ("The process began…") to give the narrative a natural start.
 *   Subsequent stages are covered by transition events (onNext, onDecision, etc.).
 * - Description priority: When a stage provides a description string, the
 *   narrative uses it for context-rich output. Without it, falls back to
 *   "moved on to {name}" pattern.
 * - Defensive copy on getSentences(): Callers cannot mutate the internal array,
 *   preserving the generator's integrity across multiple reads.
 *
 * RELATED:
 * - {@link INarrativeGenerator} - The interface this class implements
 * - {@link NullNarrativeGenerator} - No-op sibling for zero-cost disabled path
 * - {@link PipelineContext} - Holds the generator instance passed to handlers
 *
 * @example
 * ```typescript
 * const narrator = new NarrativeGenerator();
 *
 * narrator.onStageExecuted('Initialize', undefined, 'Set up the agent with LLM and tools');
 * narrator.onNext('Initialize', 'Assemble Prompt', undefined, 'Build the prompt from system instructions');
 * narrator.onNext('Assemble Prompt', 'Call LLM', undefined, 'Send messages to the LLM provider');
 * narrator.onDecision('Route Decider', 'finalize', 'Finalize', 'the LLM provided a final answer', 'Decide whether to use tools or respond');
 *
 * narrator.getSentences();
 * // → [
 * //   "The process began: Set up the agent with LLM and tools.",
 * //   "Next step: Build the prompt from system instructions.",
 * //   "Next step: Send messages to the LLM provider.",
 * //   "It decided whether to use tools or respond: the LLM provided a final answer, so it chose Finalize."
 * // ]
 * ```
 *
 * _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3,
 *  5.1, 5.2, 5.3, 6.1, 6.2, 7.1, 7.2, 7.3, 10.1, 10.2_
 */

import { INarrativeGenerator } from './types';

export class NarrativeGenerator implements INarrativeGenerator {
  private sentences: string[] = [];
  private isFirstStage = true;

  /**
   * WHY: The first stage uses a distinct opening pattern to give the
   * narrative a natural beginning. When description is available,
   * uses it for a more descriptive opener.
   */
  onStageExecuted(stageName: string, displayName?: string, description?: string): void {
    if (this.isFirstStage) {
      if (description) {
        this.sentences.push(`The process began: ${description}.`);
      } else {
        const name = displayName || stageName;
        this.sentences.push(`The process began with ${name}.`);
      }
      this.isFirstStage = false;
    }
  }

  /**
   * WHY: Linear continuations are the backbone of the narrative — they
   * let the reader follow the execution path step by step.
   * When description is available, uses it for context-rich output.
   */
  onNext(fromStage: string, toStage: string, toDisplayName?: string, description?: string): void {
    if (description) {
      this.sentences.push(`Next step: ${description}.`);
    } else {
      const name = toDisplayName || toStage;
      this.sentences.push(`Next, it moved on to ${name}.`);
    }
  }

  /**
   * WHY: Decision points are the most valuable part of the narrative for
   * LLM context engineering. Including the rationale lets even a cheaper
   * model reason about why a branch was taken.
   * When deciderDescription is available, uses it for natural phrasing.
   */
  onDecision(deciderName: string, chosenBranch: string, chosenDisplayName?: string, rationale?: string, deciderDescription?: string): void {
    const branchName = chosenDisplayName || chosenBranch;
    if (deciderDescription && rationale) {
      this.sentences.push(`It ${deciderDescription}: ${rationale}, so it chose ${branchName}.`);
    } else if (deciderDescription) {
      this.sentences.push(`It ${deciderDescription} and chose ${branchName}.`);
    } else if (rationale) {
      this.sentences.push(`A decision was made: ${rationale}, so the path taken was ${branchName}.`);
    } else {
      this.sentences.push(`A decision was made, and the path taken was ${branchName}.`);
    }
  }

  /**
   * WHY: Captures the fan-out so the reader knows which paths ran
   * concurrently and how many there were.
   */
  onFork(parentStage: string, childNames: string[]): void {
    const names = childNames.join(', ');
    this.sentences.push(`${childNames.length} paths were executed in parallel: ${names}.`);
  }

  /**
   * WHY: Captures which children were selected out of the total available,
   * so the reader understands the selection decision.
   */
  onSelected(parentStage: string, selectedNames: string[], totalCount: number): void {
    const names = selectedNames.join(', ');
    this.sentences.push(`${selectedNames.length} of ${totalCount} paths were selected: ${names}.`);
  }

  /**
   * WHY: Marks the boundary where execution dives into a nested context,
   * helping the reader follow the nesting structure.
   */
  onSubflowEntry(subflowName: string): void {
    this.sentences.push(`Entering the ${subflowName} subflow.`);
  }

  /**
   * WHY: Marks the return from a nested context back to the parent flow.
   */
  onSubflowExit(subflowName: string): void {
    this.sentences.push(`Exiting the ${subflowName} subflow.`);
  }

  /**
   * WHY: Captures repeated execution so the reader can track iteration
   * counts and understand retry/loop behavior.
   * When description is available, produces "On pass N: {description} again."
   */
  onLoop(targetStage: string, targetDisplayName: string | undefined, iteration: number, description?: string): void {
    if (description) {
      this.sentences.push(`On pass ${iteration}: ${description} again.`);
    } else {
      const name = targetDisplayName || targetStage;
      this.sentences.push(`On pass ${iteration} through ${name}.`);
    }
  }

  /**
   * WHY: Captures early termination so the reader knows where the
   * pipeline stopped before reaching the natural end.
   */
  onBreak(stageName: string, displayName?: string): void {
    const name = displayName || stageName;
    this.sentences.push(`Execution stopped at ${name}.`);
  }

  /**
   * WHY: Captures failure points so the reader (or a follow-up LLM)
   * can understand what went wrong and where.
   */
  onError(stageName: string, errorMessage: string, displayName?: string): void {
    const name = displayName || stageName;
    this.sentences.push(`An error occurred at ${name}: ${errorMessage}.`);
  }

  /**
   * WHY: Returns a defensive copy so callers cannot mutate the internal
   * sentence array, preserving the generator's integrity across multiple reads.
   *
   * @returns A shallow copy of the accumulated narrative sentences in execution order
   */
  getSentences(): string[] {
    return [...this.sentences];
  }
}
