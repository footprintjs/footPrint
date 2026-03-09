/**
 * NarrativeFlowRecorder — Default FlowRecorder that generates plain-English narrative.
 *
 * This is the FlowRecorder equivalent of ControlFlowNarrativeGenerator.
 * Produces the same sentences, same format, same behavior — but as a
 * pluggable FlowRecorder that can be swapped, extended, or composed.
 *
 * Consumers who want different narrative behavior (windowed loops, adaptive
 * summarization, etc.) can replace this with a different FlowRecorder.
 */

import type {
  FlowBreakEvent,
  FlowDecisionEvent,
  FlowErrorEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowNextEvent,
  FlowRecorder,
  FlowSelectedEvent,
  FlowStageEvent,
  FlowSubflowEvent,
} from './types';

export class NarrativeFlowRecorder implements FlowRecorder {
  readonly id: string;
  private sentences: string[] = [];
  private isFirstStage = true;

  constructor(id?: string) {
    this.id = id ?? 'narrative';
  }

  onStageExecuted(event: FlowStageEvent): void {
    if (this.isFirstStage) {
      if (event.description) {
        this.sentences.push(`The process began: ${event.description}.`);
      } else {
        this.sentences.push(`The process began with ${event.stageName}.`);
      }
      this.isFirstStage = false;
    }
  }

  onNext(event: FlowNextEvent): void {
    if (event.description) {
      this.sentences.push(`Next step: ${event.description}.`);
    } else {
      this.sentences.push(`Next, it moved on to ${event.to}.`);
    }
  }

  onDecision(event: FlowDecisionEvent): void {
    const branchName = event.chosen;
    if (event.description && event.rationale) {
      this.sentences.push(`It ${event.description}: ${event.rationale}, so it chose ${branchName}.`);
    } else if (event.description) {
      this.sentences.push(`It ${event.description} and chose ${branchName}.`);
    } else if (event.rationale) {
      this.sentences.push(`A decision was made: ${event.rationale}, so the path taken was ${branchName}.`);
    } else {
      this.sentences.push(`A decision was made, and the path taken was ${branchName}.`);
    }
  }

  onFork(event: FlowForkEvent): void {
    const names = event.children.join(', ');
    this.sentences.push(`${event.children.length} paths were executed in parallel: ${names}.`);
  }

  onSelected(event: FlowSelectedEvent): void {
    const names = event.selected.join(', ');
    this.sentences.push(`${event.selected.length} of ${event.total} paths were selected: ${names}.`);
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    this.sentences.push(`Entering the ${event.name} subflow.`);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    this.sentences.push(`Exiting the ${event.name} subflow.`);
  }

  onLoop(event: FlowLoopEvent): void {
    if (event.description) {
      this.sentences.push(`On pass ${event.iteration}: ${event.description} again.`);
    } else {
      this.sentences.push(`On pass ${event.iteration} through ${event.target}.`);
    }
  }

  onBreak(event: FlowBreakEvent): void {
    this.sentences.push(`Execution stopped at ${event.stageName}.`);
  }

  onError(event: FlowErrorEvent): void {
    this.sentences.push(`An error occurred at ${event.stageName}: ${event.message}.`);
  }

  /** Returns a defensive copy of accumulated sentences. */
  getSentences(): string[] {
    return [...this.sentences];
  }

  /** Clears accumulated sentences. Useful for reuse across runs. */
  clear(): void {
    this.sentences = [];
    this.isFirstStage = true;
  }
}
