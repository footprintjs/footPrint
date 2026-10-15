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
  attemptSentence,
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
  FlowAttemptEvent,
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
  /**
   * A retried stage's attempt sentences, by `runtimeStageId`, held until the stage's own outcome is known. A
   * stage that FAILED tells its attempts beneath its error sentence — where the combined narrative puts them
   * (`CombinedNarrativeRecorder · flushAttempts`), so the two built-in narratives tell a failure in one order,
   * the stop reason last. A stage that completed (or paused) tells them where they always stood: before the
   * sentence its completion adds.
   */
  private readonly heldAttempts = new Map<string, Array<{ sentence: string; stageName: string }>>();

  constructor(id?: string) {
    this.id = id ?? 'narrative';
  }

  onStageExecuted(event: FlowStageEvent): void {
    this.releaseAttempts(event.traversalContext?.runtimeStageId);
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
    this.releaseAttempts(event.traversalContext?.runtimeStageId);
    this.sentences.push(decisionSentence(event));
    this.stageNames.push(event.decider);
  }

  onFork(event: FlowForkEvent): void {
    this.releaseAttempts(event.traversalContext?.runtimeStageId);
    this.sentences.push(forkSentence(event));
    this.stageNames.push(undefined);
  }

  onSelected(event: FlowSelectedEvent): void {
    this.releaseAttempts(event.traversalContext?.runtimeStageId);
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
    // A failed stage's attempts go beneath its error sentence, the stop reason last.
    this.releaseAttempts(event.traversalContext?.runtimeStageId);
  }

  /**
   * One sentence per attempt of a retried stage (10.1) — its outcome, duration, cause and decision. It replaces
   * the 9.15 retry sentence (`onStageRetry` is no longer narrated here): the attempt line already says
   * "retrying", and says it for the attempt that stopped the series too. Held until the stage's outcome is
   * known ({@link heldAttempts}); an event with no `runtimeStageId` has nothing to hold it by, so it is told now.
   */
  onAttempt(event: FlowAttemptEvent): void {
    const sentence = attemptSentence(event.stageName, event.record);
    const runtimeStageId = event.traversalContext?.runtimeStageId;
    if (runtimeStageId === undefined) {
      this.sentences.push(sentence);
      this.stageNames.push(event.stageName);
      return;
    }
    const held = this.heldAttempts.get(runtimeStageId);
    if (held) held.push({ sentence, stageName: event.stageName });
    else this.heldAttempts.set(runtimeStageId, [{ sentence, stageName: event.stageName }]);
  }

  onPause(event: FlowPauseEvent): void {
    this.releaseAttempts(event.traversalContext?.runtimeStageId);
    this.sentences.push(pauseSentence(event));
    this.stageNames.push(event.stageName);
  }

  onResume(event: FlowResumeEvent): void {
    this.sentences.push(resumeSentence(event));
    this.stageNames.push(event.stageName);
    this.announcedArrival = event.stageName;
  }

  /**
   * Returns a defensive copy of accumulated sentences. Attempt sentences still held — read mid-stage, before the
   * stage's outcome — come last, so nothing the run did is ever missing from the copy.
   */
  getSentences(): string[] {
    const held: string[] = [];
    for (const series of this.heldAttempts.values()) for (const { sentence } of series) held.push(sentence);
    return [...this.sentences, ...held];
  }

  /** Clears accumulated sentences. Useful for reuse across runs. */
  clear(): void {
    this.sentences = [];
    this.stageNames = [];
    this.announcedArrival = undefined;
    this.heldAttempts.clear();
  }

  /** Tell the held attempt sentences of `runtimeStageId`, in order, and stop holding them. */
  private releaseAttempts(runtimeStageId: string | undefined): void {
    if (runtimeStageId === undefined) return;
    const held = this.heldAttempts.get(runtimeStageId);
    if (!held) return;
    this.heldAttempts.delete(runtimeStageId);
    for (const { sentence, stageName } of held) {
      this.sentences.push(sentence);
      this.stageNames.push(stageName);
    }
  }
}
