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

import {
  breakSentence,
  decisionSentence,
  errorSentence,
  forkSentence,
  loopSentence,
  nextStageSentence,
  pauseSentence,
  resumeSentence,
  validationDetails,
  validationSentence,
} from './formatting/sentences.js';
import type {
  FlowBreakEvent,
  FlowDecisionEvent,
  FlowErrorEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowNextEvent,
  FlowPauseEvent,
  FlowRecorder,
  FlowResumeEvent,
  FlowSelectedEvent,
  FlowStageEvent,
  FlowStageRetryEvent,
  FlowSubflowEvent,
} from './types.js';

export class NarrativeFlowRecorder implements FlowRecorder {
  readonly id: string;
  private sentences: string[] = [];
  /** Parallel array: the actual stage name that produced each sentence. */
  private stageNames: (string | undefined)[] = [];
  /**
   * The stage whose arrival `onLoop` / `onResume` just narrated. Its completion
   * line would repeat that arrival ("Next, it moved on to X."), so the next
   * `onStageExecuted` for that stage stays silent — an arrival is told ONCE.
   */
  private announcedArrival: string | undefined;

  constructor(id?: string) {
    this.id = id ?? 'narrative';
  }

  onStageExecuted(event: FlowStageEvent): void {
    const announced = this.announcedArrival;
    this.announcedArrival = undefined;
    // Only LINEAR stages produce a "moved on to X" narrative line.
    // Decider / fork / selector / subflow-mount stages have their
    // own dedicated narrative lines from onDecision / onFork /
    // onSelected / onSubflowEntry — emitting from here too would
    // double up the narrative.
    if (event.stageType !== 'linear') return;
    if (announced === event.stageName) return;
    this.sentences.push(nextStageSentence(event));
    this.stageNames.push(event.stageName);
  }

  onNext(_event: FlowNextEvent): void {
    // An edge announces a destination, not its completion. Linear stage
    // sentences belong to onStageExecuted; other kinds have dedicated hooks.
    // Keep this event silent, as CombinedNarrativeRecorder · onNext does.
  }

  onDecision(event: FlowDecisionEvent): void {
    this.sentences.push(decisionSentence(event));
    this.stageNames.push(event.decider);
  }

  onFork(event: FlowForkEvent): void {
    this.sentences.push(forkSentence(event));
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
    this.sentences.push(loopSentence(event));
    this.stageNames.push(event.target);
    this.announcedArrival = event.target;
  }

  onBreak(event: FlowBreakEvent): void {
    this.sentences.push(breakSentence(event));
    this.stageNames.push(event.stageName);
  }

  onError(event: FlowErrorEvent): void {
    let sentence = errorSentence(event);

    // Enrich with field-level issues when available
    if (event.structuredError.issues && event.structuredError.issues.length > 0) {
      sentence += validationSentence(validationDetails(event.structuredError.issues));
    }

    this.sentences.push(sentence);
    this.stageNames.push(event.stageName);
  }

  onStageRetry(event: FlowStageRetryEvent): void {
    const wait = event.delayMs > 0 ? ` after waiting ${event.delayMs}ms` : '';
    this.sentences.push(
      `Attempt ${event.attempt} of ${event.maxAttempts} at ${event.stageName} failed ` +
        `(${event.message}), so it tried again${wait}.`,
    );
    this.stageNames.push(event.stageName);
  }

  onPause(event: FlowPauseEvent): void {
    this.sentences.push(pauseSentence(event));
    this.stageNames.push(event.stageName);
  }

  onResume(event: FlowResumeEvent): void {
    this.sentences.push(resumeSentence(event));
    this.stageNames.push(event.stageName);
    this.announcedArrival = event.stageName;
  }

  /** Returns a defensive copy of accumulated sentences. */
  getSentences(): string[] {
    return [...this.sentences];
  }

  /** Clears accumulated sentences. Useful for reuse across runs. */
  clear(): void {
    this.sentences = [];
    this.stageNames = [];
    this.announcedArrival = undefined;
  }
}
