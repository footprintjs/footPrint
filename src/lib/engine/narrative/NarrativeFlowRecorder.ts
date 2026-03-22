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
} from './types.js';

export class NarrativeFlowRecorder implements FlowRecorder {
  readonly id: string;
  private sentences: string[] = [];
  /** Parallel array: the actual stage name that produced each sentence. */
  private stageNames: (string | undefined)[] = [];
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
      this.stageNames.push(event.stageName);
      this.isFirstStage = false;
    }
  }

  onNext(event: FlowNextEvent): void {
    if (event.description) {
      this.sentences.push(`Next step: ${event.description}.`);
    } else {
      this.sentences.push(`Next, it moved on to ${event.to}.`);
    }
    this.stageNames.push(event.to);
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
    this.stageNames.push(event.decider);
  }

  onFork(event: FlowForkEvent): void {
    const names = event.children.join(', ');
    this.sentences.push(`Forking into ${event.children.length} parallel paths: ${names}.`);
    this.stageNames.push(undefined);
  }

  onSelected(event: FlowSelectedEvent): void {
    const names = event.selected.join(', ');
    this.sentences.push(`${event.selected.length} of ${event.total} paths were selected: ${names}.`);
    this.stageNames.push(undefined);
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    if (event.description) {
      this.sentences.push(`Entering the ${event.name} subflow: ${event.description}.`);
    } else {
      this.sentences.push(`Entering the ${event.name} subflow.`);
    }
    this.stageNames.push(event.name);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    this.sentences.push(`Exiting the ${event.name} subflow.`);
    this.stageNames.push(event.name);
  }

  onLoop(event: FlowLoopEvent): void {
    if (event.description) {
      this.sentences.push(`On pass ${event.iteration}: ${event.description} again.`);
    } else {
      this.sentences.push(`On pass ${event.iteration} through ${event.target}.`);
    }
    this.stageNames.push(event.target);
  }

  onBreak(event: FlowBreakEvent): void {
    this.sentences.push(`Execution stopped at ${event.stageName}.`);
    this.stageNames.push(event.stageName);
  }

  onError(event: FlowErrorEvent): void {
    let sentence = `An error occurred at ${event.stageName}: ${event.message}.`;

    // Enrich with field-level issues when available
    if (event.structuredError.issues && event.structuredError.issues.length > 0) {
      const issueDetails = event.structuredError.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          return `${path}: ${issue.message}`;
        })
        .join('; ');
      sentence += ` Validation issues: ${issueDetails}.`;
    }

    this.sentences.push(sentence);
    this.stageNames.push(event.stageName);
  }

  /** Returns a defensive copy of accumulated sentences. */
  getSentences(): string[] {
    return [...this.sentences];
  }

  /** Clears accumulated sentences. Useful for reuse across runs. */
  clear(): void {
    this.sentences = [];
    this.stageNames = [];
    this.isFirstStage = true;
  }
}
