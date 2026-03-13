/**
 * CombinedNarrativeRecorder — Inline narrative builder that merges flow + data during traversal.
 *
 * Replaces the post-processing CombinedNarrativeBuilder by implementing BOTH
 * FlowRecorder (control-flow events) and Recorder (scope data events).
 *
 * Event ordering guarantees this works:
 *   1. Scope events (onRead, onWrite) fire DURING stage execution
 *   2. Flow events (onStageExecuted, onDecision) fire AFTER stage execution
 *   3. Both carry the same `stageName` — no matching ambiguity
 *
 * So we buffer scope ops per-stage, then when the flow event arrives,
 * emit the stage entry + flush the buffered ops in one pass.
 */

import type { ReadEvent, Recorder, WriteEvent } from '../../scope/types';
import type { CombinedNarrativeEntry } from './CombinedNarrativeBuilder';
import type {
  FlowBreakEvent,
  FlowDecisionEvent,
  FlowErrorEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowRecorder,
  FlowSelectedEvent,
  FlowStageEvent,
  FlowSubflowEvent,
} from './types';

// ── Types ──────────────────────────────────────────────────────────────────

interface BufferedOp {
  type: 'read' | 'write';
  key: string;
  valueSummary: string;
  operation?: 'set' | 'update' | 'delete';
  stepNumber: number;
}

export interface CombinedNarrativeRecorderOptions {
  includeStepNumbers?: boolean;
  includeValues?: boolean;
  maxValueLength?: number;
}

// ── Recorder ───────────────────────────────────────────────────────────────

export class CombinedNarrativeRecorder implements FlowRecorder, Recorder {
  readonly id: string;

  private entries: CombinedNarrativeEntry[] = [];
  private pendingOps = new Map<string, BufferedOp[]>();
  private stageCounter = 0;
  private isFirstStage = true;

  private includeStepNumbers: boolean;
  private includeValues: boolean;
  private maxValueLength: number;

  constructor(options?: CombinedNarrativeRecorderOptions & { id?: string }) {
    this.id = options?.id ?? 'combined-narrative';
    this.includeStepNumbers = options?.includeStepNumbers ?? true;
    this.includeValues = options?.includeValues ?? true;
    this.maxValueLength = options?.maxValueLength ?? 80;
  }

  // ── Scope channel (fires first, during stage execution) ───────────────

  onRead(event: ReadEvent): void {
    if (!event.key) return;
    this.bufferOp(event.stageName, {
      type: 'read',
      key: event.key,
      valueSummary: summarizeValue(event.value, this.maxValueLength),
    });
  }

  onWrite(event: WriteEvent): void {
    this.bufferOp(event.stageName, {
      type: 'write',
      key: event.key,
      valueSummary: summarizeValue(event.value, this.maxValueLength),
      operation: event.operation,
    });
  }

  // ── Flow channel (fires after stage execution) ────────────────────────

  onStageExecuted(event: FlowStageEvent): void {
    this.stageCounter++;
    const text = this.isFirstStage
      ? event.description
        ? `The process began: ${event.description}.`
        : `The process began with ${event.stageName}.`
      : event.description
      ? `Next step: ${event.description}.`
      : `Next, it moved on to ${event.stageName}.`;
    this.isFirstStage = false;

    this.entries.push({
      type: 'stage',
      text: `Stage ${this.stageCounter}: ${text}`,
      depth: 0,
      stageName: event.stageName,
    });
    this.flushOps(event.stageName);
  }

  onDecision(event: FlowDecisionEvent): void {
    // Emit the decider stage entry (deciders don't fire onStageExecuted)
    this.stageCounter++;
    const stageText = this.isFirstStage
      ? event.description
        ? `The process began: ${event.description}.`
        : `The process began with ${event.decider}.`
      : event.description
      ? `Next step: ${event.description}.`
      : `Next, it moved on to ${event.decider}.`;
    this.isFirstStage = false;

    this.entries.push({
      type: 'stage',
      text: `Stage ${this.stageCounter}: ${stageText}`,
      depth: 0,
      stageName: event.decider,
    });
    this.flushOps(event.decider);

    // Emit the condition entry
    const branchName = event.chosen;
    let conditionText: string;
    if (event.description && event.rationale) {
      conditionText = `It ${event.description}: ${event.rationale}, so it chose ${branchName}.`;
    } else if (event.description) {
      conditionText = `It ${event.description} and chose ${branchName}.`;
    } else if (event.rationale) {
      conditionText = `A decision was made: ${event.rationale}, so the path taken was ${branchName}.`;
    } else {
      conditionText = `A decision was made, and the path taken was ${branchName}.`;
    }
    this.entries.push({
      type: 'condition',
      text: `[Condition]: ${conditionText}`,
      depth: 0,
      stageName: event.decider,
    });
  }

  onNext(): void {
    // No-op. onStageExecuted already has the description for the next stage.
    // For deciders (no onStageExecuted), onDecision handles the announcement.
  }

  onFork(event: FlowForkEvent): void {
    const names = event.children.join(', ');
    this.entries.push({
      type: 'fork',
      text: `[Parallel]: ${event.children.length} paths were executed in parallel: ${names}.`,
      depth: 0,
    });
  }

  onSelected(event: FlowSelectedEvent): void {
    const names = event.selected.join(', ');
    this.entries.push({
      type: 'fork',
      text: `[Selected]: ${event.selected.length} of ${event.total} paths were selected: ${names}.`,
      depth: 0,
    });
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const text = event.description
      ? `Entering the ${event.name} subflow: ${event.description}.`
      : `Entering the ${event.name} subflow.`;
    this.entries.push({ type: 'subflow', text, depth: 0 });
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    this.entries.push({
      type: 'subflow',
      text: `Exiting the ${event.name} subflow.`,
      depth: 0,
    });
  }

  onLoop(event: FlowLoopEvent): void {
    const text = event.description
      ? `On pass ${event.iteration}: ${event.description} again.`
      : `On pass ${event.iteration} through ${event.target}.`;
    this.entries.push({ type: 'loop', text, depth: 0 });
  }

  onBreak(event: FlowBreakEvent): void {
    this.entries.push({
      type: 'break',
      text: `Execution stopped at ${event.stageName}.`,
      depth: 0,
      stageName: event.stageName,
    });
  }

  /**
   * Handles errors from both channels:
   * - FlowRecorder.onError (FlowErrorEvent with message + structuredError)
   * - Recorder.onError (ErrorEvent from scope system — ignored for narrative)
   */
  onError(event: FlowErrorEvent | { stageName?: string; message?: string }): void {
    // Only handle flow errors (which have `message` and `structuredError`)
    if (typeof (event as FlowErrorEvent).message !== 'string') return;
    const flowEvent = event as FlowErrorEvent;

    let text = `An error occurred at ${flowEvent.stageName}: ${flowEvent.message}.`;
    if (flowEvent.structuredError?.issues?.length) {
      const details = flowEvent.structuredError.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          return `${path}: ${issue.message}`;
        })
        .join('; ');
      text += ` Validation issues: ${details}.`;
    }
    this.entries.push({
      type: 'error',
      text: `[Error]: ${text}`,
      depth: 0,
      stageName: flowEvent.stageName,
    });
  }

  // ── Output ────────────────────────────────────────────────────────────

  /** Returns structured entries for programmatic consumption. */
  getEntries(): CombinedNarrativeEntry[] {
    return [...this.entries];
  }

  /** Returns formatted narrative lines (same output as CombinedNarrativeBuilder.build). */
  getNarrative(indent = '  '): string[] {
    return this.entries.map((entry) => `${indent.repeat(entry.depth)}${entry.text}`);
  }

  /** Clears all state. Called automatically before each run. */
  clear(): void {
    this.entries = [];
    this.pendingOps.clear();
    this.stageCounter = 0;
    this.isFirstStage = true;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private bufferOp(stageName: string, op: Omit<BufferedOp, 'stepNumber'>): void {
    let ops = this.pendingOps.get(stageName);
    if (!ops) {
      ops = [];
      this.pendingOps.set(stageName, ops);
    }
    ops.push({ ...op, stepNumber: ops.length + 1 });
  }

  private flushOps(stageName: string): void {
    const ops = this.pendingOps.get(stageName);
    if (!ops || ops.length === 0) return;

    for (const op of ops) {
      const stepPrefix = this.includeStepNumbers ? `Step ${op.stepNumber}: ` : '';

      let text: string;
      if (op.type === 'read') {
        text =
          this.includeValues && op.valueSummary
            ? `${stepPrefix}Read ${op.key} = ${op.valueSummary}`
            : `${stepPrefix}Read ${op.key}`;
      } else if (op.operation === 'delete') {
        text = `${stepPrefix}Delete ${op.key}`;
      } else if (op.operation === 'update') {
        text = this.includeValues
          ? `${stepPrefix}Update ${op.key} = ${op.valueSummary}`
          : `${stepPrefix}Update ${op.key}`;
      } else {
        text = this.includeValues
          ? `${stepPrefix}Write ${op.key} = ${op.valueSummary}`
          : `${stepPrefix}Write ${op.key}`;
      }

      this.entries.push({
        type: 'step',
        text,
        depth: 1,
        stageName,
        stepNumber: op.stepNumber,
      });
    }

    this.pendingOps.delete(stageName);
  }
}

// ── Value summarizer (same logic as NarrativeRecorder) ─────────────────────

function summarizeValue(value: unknown, maxLen: number): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length <= maxLen ? `"${value}"` : `"${value.slice(0, maxLen - 3)}..."`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `(${value.length} item${value.length > 1 ? 's' : ''})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const preview = keys.slice(0, 4).join(', ');
    const suffix = keys.length > 4 ? `, ... (${keys.length} keys)` : '';
    const result = `{${preview}${suffix}}`;
    return result.length <= maxLen ? result : `{${keys.length} keys}`;
  }
  return String(value);
}
