/**
 * ControlFlowNarrativeGenerator — Active implementation of IControlFlowNarrative.
 *
 * Converts traversal events into plain-English sentences at traversal time.
 * Produces a human-readable story as a first-class output, enabling any consumer
 * (cheaper LLM, follow-up agent, logging system) to understand what happened
 * without parsing technical structures.
 *
 * This is the FLOW narrative — it captures control flow decisions.
 * The DATA narrative comes from scope/recorders/NarrativeRecorder.
 * CombinedNarrativeBuilder merges both into one story.
 */

import type { IControlFlowNarrative } from './types.js';

export class ControlFlowNarrativeGenerator implements IControlFlowNarrative {
  private sentences: string[] = [];
  private isFirstStage = true;

  onStageExecuted(stageName: string, description?: string): void {
    if (this.isFirstStage) {
      if (description) {
        this.sentences.push(`The process began: ${description}.`);
      } else {
        this.sentences.push(`The process began with ${stageName}.`);
      }
      this.isFirstStage = false;
    }
  }

  onNext(fromStage: string, toStage: string, description?: string): void {
    if (description) {
      this.sentences.push(`Next step: ${description}.`);
    } else {
      this.sentences.push(`Next, it moved on to ${toStage}.`);
    }
  }

  onDecision(
    deciderName: string,
    chosenBranch: string,
    rationale?: string,
    deciderDescription?: string,
    _traversalContext?: unknown,
    evidence?: import('../../decide/types').DecisionEvidence,
  ): void {
    const branchName = chosenBranch;
    if (evidence) {
      const matchedRule = evidence.rules.find((r) => r.matched);
      if (matchedRule) {
        const label = matchedRule.label ? ` "${matchedRule.label}"` : '';
        if (matchedRule.type === 'filter') {
          const parts = matchedRule.conditions.map(
            (c) => `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)}`,
          );
          this.sentences.push(`It evaluated${label}: ${parts.join(', ')}, and chose ${branchName}.`);
        } else {
          const parts = matchedRule.inputs.map((i) => `${i.key}=${i.valueSummary}`);
          this.sentences.push(`It examined${label}: ${parts.join(', ')}, and chose ${branchName}.`);
        }
      } else {
        this.sentences.push(`No rules matched, fell back to default: ${branchName}.`);
      }
    } else if (deciderDescription && rationale) {
      this.sentences.push(`It ${deciderDescription}: ${rationale}, so it chose ${branchName}.`);
    } else if (deciderDescription) {
      this.sentences.push(`It ${deciderDescription} and chose ${branchName}.`);
    } else if (rationale) {
      this.sentences.push(`A decision was made: ${rationale}, so the path taken was ${branchName}.`);
    } else {
      this.sentences.push(`A decision was made, and the path taken was ${branchName}.`);
    }
  }

  onFork(parentStage: string, childNames: string[]): void {
    const names = childNames.join(', ');
    this.sentences.push(`Forking into ${childNames.length} parallel paths: ${names}.`);
  }

  onSelected(parentStage: string, selectedNames: string[], totalCount: number): void {
    const names = selectedNames.join(', ');
    this.sentences.push(`${selectedNames.length} of ${totalCount} paths were selected: ${names}.`);
  }

  onSubflowEntry(subflowName: string, _subflowId?: string, description?: string): void {
    if (description) {
      this.sentences.push(`Entering the ${subflowName} subflow: ${description}.`);
    } else {
      this.sentences.push(`Entering the ${subflowName} subflow.`);
    }
  }

  onSubflowExit(subflowName: string, _subflowId?: string): void {
    this.sentences.push(`Exiting the ${subflowName} subflow.`);
  }

  onSubflowRegistered(_subflowId: string, _name: string, _description?: string, _specStructure?: unknown): void {
    // No narrative output for registration events
  }

  onLoop(targetStage: string, iteration: number, description?: string): void {
    if (description) {
      this.sentences.push(`On pass ${iteration}: ${description} again.`);
    } else {
      this.sentences.push(`On pass ${iteration} through ${targetStage}.`);
    }
  }

  onBreak(stageName: string): void {
    this.sentences.push(`Execution stopped at ${stageName}.`);
  }

  onError(stageName: string, errorMessage: string, _error: unknown): void {
    this.sentences.push(`An error occurred at ${stageName}: ${errorMessage}.`);
  }

  /** Returns a defensive copy of accumulated sentences. */
  getSentences(): string[] {
    return [...this.sentences];
  }
}
