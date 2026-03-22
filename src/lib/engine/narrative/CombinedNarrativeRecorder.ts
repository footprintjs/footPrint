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

import { summarizeValue } from '../../scope/recorders/summarizeValue.js';
import type { ReadEvent, Recorder, WriteEvent } from '../../scope/types.js';
import type { CombinedNarrativeEntry } from './CombinedNarrativeBuilder.js';
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
} from './types.js';

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
  /** Per-subflow stage counters. Key '' = root flow. */
  private stageCounters = new Map<string, number>();
  /** Per-subflow first-stage flags. Key '' = root flow. */
  private firstStageFlags = new Map<string, boolean>();

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
    const sfKey = event.traversalContext?.subflowId ?? '';
    const stageNum = this.incrementStageCounter(sfKey);
    const isFirst = this.consumeFirstStageFlag(sfKey);
    const text = isFirst
      ? event.description
        ? `The process began: ${event.description}.`
        : `The process began with ${event.stageName}.`
      : event.description
      ? `Next step: ${event.description}.`
      : `Next, it moved on to ${event.stageName}.`;

    const sfId = event.traversalContext?.subflowId;
    const stageId = event.traversalContext?.stageId;
    this.entries.push({
      type: 'stage',
      text: `Stage ${stageNum}: ${text}`,
      depth: 0,
      stageName: event.stageName,
      stageId,
      subflowId: sfId,
    });
    this.flushOps(event.stageName, sfId, stageId);
  }

  onDecision(event: FlowDecisionEvent): void {
    // Emit the decider stage entry (deciders don't fire onStageExecuted)
    const sfKey = event.traversalContext?.subflowId ?? '';
    const stageNum = this.incrementStageCounter(sfKey);
    const isFirst = this.consumeFirstStageFlag(sfKey);
    const stageText = isFirst
      ? event.description
        ? `The process began: ${event.description}.`
        : `The process began with ${event.decider}.`
      : event.description
      ? `Next step: ${event.description}.`
      : `Next, it moved on to ${event.decider}.`;

    const deciderStageId = event.traversalContext?.stageId;
    this.entries.push({
      type: 'stage',
      text: `Stage ${stageNum}: ${stageText}`,
      depth: 0,
      stageName: event.decider,
      stageId: deciderStageId,
      subflowId: event.traversalContext?.subflowId,
    });
    this.flushOps(event.decider, event.traversalContext?.subflowId, deciderStageId);

    // Emit the condition entry — with evidence-aware rendering when available
    const branchName = event.chosen;
    let conditionText: string;
    if (event.evidence) {
      // Rich evidence from decide() helper
      const matchedRule = event.evidence.rules.find((r) => r.matched);
      if (matchedRule) {
        const label = matchedRule.label ? ` "${matchedRule.label}"` : '';
        if (matchedRule.type === 'filter') {
          const parts = matchedRule.conditions.map(
            (c) =>
              `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`,
          );
          conditionText = `It evaluated Rule ${matchedRule.ruleIndex}${label}: ${parts.join(
            ', ',
          )}, and chose ${branchName}.`;
        } else {
          const parts = matchedRule.inputs.map((i) => `${i.key}=${i.valueSummary}`);
          conditionText = `It examined${label}: ${parts.join(', ')}, and chose ${branchName}.`;
        }
      } else {
        conditionText = `No rules matched, fell back to default: ${branchName}.`;
      }
    } else if (event.description && event.rationale) {
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
      stageId: deciderStageId,
      subflowId: event.traversalContext?.subflowId,
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
      text: `[Parallel]: Forking into ${event.children.length} parallel paths: ${names}.`,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onSelected(event: FlowSelectedEvent): void {
    const names = event.selected.join(', ');
    this.entries.push({
      type: 'fork',
      text: `[Selected]: ${event.selected.length} of ${event.total} paths selected for execution: ${names}.`,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    // Reset stage counter for this subflow so stages start at "Stage 1" on re-entry
    const sfKey = event.subflowId ?? '';
    this.stageCounters.delete(sfKey);
    this.firstStageFlags.delete(sfKey);

    const text = event.description
      ? `Entering the ${event.name} subflow: ${event.description}.`
      : `Entering the ${event.name} subflow.`;
    this.entries.push({
      type: 'subflow',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    this.entries.push({
      type: 'subflow',
      text: `Exiting the ${event.name} subflow.`,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onLoop(event: FlowLoopEvent): void {
    const text = event.description
      ? `On pass ${event.iteration}: ${event.description} again.`
      : `On pass ${event.iteration} through ${event.target}.`;
    this.entries.push({
      type: 'loop',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onBreak(event: FlowBreakEvent): void {
    this.entries.push({
      type: 'break',
      text: `Execution stopped at ${event.stageName}.`,
      depth: 0,
      stageName: event.stageName,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
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
      stageId: flowEvent.traversalContext?.stageId,
      subflowId: flowEvent.traversalContext?.subflowId,
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

  /**
   * Returns entries grouped by subflowId for structured access.
   * Root-level entries have subflowId = undefined.
   */
  getEntriesBySubflow(): Record<string, CombinedNarrativeEntry[]> {
    const result: Record<string, CombinedNarrativeEntry[]> = { '': [] };
    for (const entry of this.entries) {
      const key = entry.subflowId ?? '';
      if (!result[key]) result[key] = [];
      result[key].push(entry);
    }
    return result;
  }

  /** Clears all state. Called automatically before each run. */
  clear(): void {
    this.entries = [];
    this.pendingOps.clear();
    this.stageCounters.clear();
    this.firstStageFlags.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /** Increment and return the stage counter for a given subflow ('' = root). */
  private incrementStageCounter(subflowKey: string): number {
    const current = this.stageCounters.get(subflowKey) ?? 0;
    const next = current + 1;
    this.stageCounters.set(subflowKey, next);
    return next;
  }

  /** Returns true if this is the first stage for the given subflow, consuming the flag. */
  private consumeFirstStageFlag(subflowKey: string): boolean {
    if (!this.firstStageFlags.has(subflowKey)) {
      this.firstStageFlags.set(subflowKey, false);
      return true;
    }
    return false;
  }

  private bufferOp(stageName: string, op: Omit<BufferedOp, 'stepNumber'>): void {
    let ops = this.pendingOps.get(stageName);
    if (!ops) {
      ops = [];
      this.pendingOps.set(stageName, ops);
    }
    ops.push({ ...op, stepNumber: ops.length + 1 });
  }

  private flushOps(stageName: string, subflowId?: string, stageId?: string): void {
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
        stageId,
        stepNumber: op.stepNumber,
        subflowId,
      });
    }

    this.pendingOps.delete(stageName);
  }
}
