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
import type {
  BreakRenderContext,
  CombinedNarrativeEntry,
  DecisionRenderContext,
  ErrorRenderContext,
  ForkRenderContext,
  LoopRenderContext,
  NarrativeRenderer,
  OpRenderContext,
  SelectedRenderContext,
  StageRenderContext,
  SubflowRenderContext,
} from './narrativeTypes.js';
import type {
  FlowBreakEvent,
  FlowDecisionEvent,
  FlowErrorEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowPauseEvent,
  FlowRecorder,
  FlowResumeEvent,
  FlowSelectedEvent,
  FlowStageEvent,
  FlowSubflowEvent,
} from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface BufferedOp {
  type: 'read' | 'write';
  key: string;
  rawValue: unknown;
  operation?: 'set' | 'update' | 'delete';
  stepNumber: number;
}

export interface CombinedNarrativeRecorderOptions {
  includeStepNumbers?: boolean;
  includeValues?: boolean;
  maxValueLength?: number;
  /** Custom value formatter. Called at render time (flushOps), not capture time.
   *  Receives the raw value and maxValueLength. Defaults to summarizeValue(). */
  formatValue?: (value: unknown, maxLen: number) => string;
  /** Pluggable renderer for customizing narrative output. Unimplemented methods
   *  fall back to the default English renderer. See NarrativeRenderer docs. */
  renderer?: NarrativeRenderer;
}

// ── Recorder ───────────────────────────────────────────────────────────────

export class CombinedNarrativeRecorder implements FlowRecorder, Recorder {
  readonly id: string;

  private entries: CombinedNarrativeEntry[] = [];
  /**
   * Pending scope ops keyed by stageName. Flushed in onStageExecuted/onDecision.
   *
   * Name collisions (two stages with the same name, different IDs) are prevented by
   * the event ordering contract: scope events (onRead/onWrite) for stage N are always
   * flushed by onStageExecuted for stage N before stage N+1's scope events begin.
   * So the key is always uniquely bound to the currently-executing stage.
   */
  private pendingOps = new Map<string, BufferedOp[]>();
  /** Per-subflow stage counters. Key '' = root flow. */
  private stageCounters = new Map<string, number>();
  /** Per-subflow first-stage flags. Key '' = root flow. */
  private firstStageFlags = new Map<string, boolean>();

  private includeStepNumbers: boolean;
  private includeValues: boolean;
  private maxValueLength: number;
  private formatValue: (value: unknown, maxLen: number) => string;
  private renderer?: NarrativeRenderer;

  constructor(options?: CombinedNarrativeRecorderOptions & { id?: string }) {
    this.id = options?.id ?? 'combined-narrative';
    this.includeStepNumbers = options?.includeStepNumbers ?? true;
    this.includeValues = options?.includeValues ?? true;
    this.maxValueLength = options?.maxValueLength ?? 80;
    this.formatValue = options?.formatValue ?? summarizeValue;
    this.renderer = options?.renderer;
  }

  // ── Scope channel (fires first, during stage execution) ───────────────

  onRead(event: ReadEvent): void {
    if (!event.key) return;
    this.bufferOp(event.stageName, {
      type: 'read',
      key: event.key,
      rawValue: event.value,
    });
  }

  onWrite(event: WriteEvent): void {
    this.bufferOp(event.stageName, {
      type: 'write',
      key: event.key,
      rawValue: event.value,
      operation: event.operation,
    });
  }

  // ── Flow channel (fires after stage execution) ────────────────────────

  onStageExecuted(event: FlowStageEvent): void {
    const stageId = event.traversalContext?.stageId;
    const sfKey = event.traversalContext?.subflowId ?? '';
    const stageNum = this.incrementStageCounter(sfKey);
    const isFirst = this.consumeFirstStageFlag(sfKey);

    const ctx: StageRenderContext = {
      stageName: event.stageName,
      stageNumber: stageNum,
      isFirst,
      description: event.description,
    };
    const text = this.renderer?.renderStage?.(ctx) ?? this.defaultRenderStage(ctx);

    const sfId = event.traversalContext?.subflowId;
    this.entries.push({
      type: 'stage',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId,
      subflowId: sfId,
    });
    this.flushOps(event.stageName, sfId, stageId);
  }

  onDecision(event: FlowDecisionEvent): void {
    const deciderStageIdEarly = event.traversalContext?.stageId;

    // Emit the decider stage entry (deciders don't fire onStageExecuted)
    const sfKey = event.traversalContext?.subflowId ?? '';
    const stageNum = this.incrementStageCounter(sfKey);
    const isFirst = this.consumeFirstStageFlag(sfKey);

    const stageCtx: StageRenderContext = {
      stageName: event.decider,
      stageNumber: stageNum,
      isFirst,
      description: event.description,
    };
    const stageText = this.renderer?.renderStage?.(stageCtx) ?? this.defaultRenderStage(stageCtx);

    this.entries.push({
      type: 'stage',
      text: stageText,
      depth: 0,
      stageName: event.decider,
      stageId: deciderStageIdEarly,
      subflowId: event.traversalContext?.subflowId,
    });
    this.flushOps(event.decider, event.traversalContext?.subflowId, deciderStageIdEarly);

    // Emit the condition entry as a nested sub-item (depth 1) of the stage above.
    // Decision outcome is a detail of the decider stage, not a separate top-level entry.
    const decisionCtx: DecisionRenderContext = {
      decider: event.decider,
      chosen: event.chosen,
      description: event.description,
      rationale: event.rationale,
      evidence: event.evidence,
    };
    const conditionText = this.renderer?.renderDecision?.(decisionCtx) ?? this.defaultRenderDecision(decisionCtx);
    this.entries.push({
      type: 'condition',
      text: conditionText,
      depth: 1,
      stageName: event.decider,
      stageId: deciderStageIdEarly,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onNext(): void {
    // No-op. onStageExecuted already has the description for the next stage.
    // For deciders (no onStageExecuted), onDecision handles the announcement.
  }

  onFork(event: FlowForkEvent): void {
    const ctx: ForkRenderContext = { children: event.children };
    const text = this.renderer?.renderFork?.(ctx) ?? this.defaultRenderFork(ctx);
    this.entries.push({
      type: 'fork',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onSelected(event: FlowSelectedEvent): void {
    const ctx: SelectedRenderContext = {
      selected: event.selected,
      total: event.total,
      evidence: event.evidence,
    };
    const text = this.renderer?.renderSelected?.(ctx) ?? this.defaultRenderSelected(ctx);
    this.entries.push({
      type: 'selector',
      text,
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

    const ctx: SubflowRenderContext = {
      name: event.name,
      direction: 'entry',
      description: event.description,
    };
    const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
    this.entries.push({
      type: 'subflow',
      text,
      depth: 0,
      stageName: event.name,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const ctx: SubflowRenderContext = {
      name: event.name,
      direction: 'exit',
    };
    const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
    this.entries.push({
      type: 'subflow',
      text,
      depth: 0,
      stageName: event.name,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onLoop(event: FlowLoopEvent): void {
    const ctx: LoopRenderContext = {
      target: event.target,
      iteration: event.iteration,
      description: event.description,
    };
    const text = this.renderer?.renderLoop?.(ctx) ?? this.defaultRenderLoop(ctx);
    this.entries.push({
      type: 'loop',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onBreak(event: FlowBreakEvent): void {
    const ctx: BreakRenderContext = { stageName: event.stageName };
    const text = this.renderer?.renderBreak?.(ctx) ?? this.defaultRenderBreak(ctx);
    this.entries.push({
      type: 'break',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onPause(event: FlowPauseEvent | { stageName?: string; stageId?: string }): void {
    // Only handle FlowPauseEvent (from FlowRecorder channel); ignore scope PauseEvent.
    // FlowPauseEvent has 'subflowPath', scope PauseEvent has 'pipelineId'.
    if (Object.prototype.hasOwnProperty.call(event, 'pipelineId')) return;
    const flowEvent = event as FlowPauseEvent;
    if (!flowEvent.stageName || !flowEvent.stageId) return;
    const text = `Execution paused at ${flowEvent.stageName}.`;
    this.entries.push({
      type: 'pause',
      text,
      depth: 0,
      stageName: flowEvent.stageName,
      stageId: flowEvent.traversalContext?.stageId ?? flowEvent.stageId,
      subflowId: flowEvent.traversalContext?.subflowId,
    });
  }

  onResume(event: FlowResumeEvent | { stageName?: string; stageId?: string }): void {
    // Only handle FlowResumeEvent (from FlowRecorder channel); ignore scope ResumeEvent.
    if (Object.prototype.hasOwnProperty.call(event, 'pipelineId')) return;
    const flowEvent = event as FlowResumeEvent;
    if (!flowEvent.stageName || !flowEvent.stageId) return;
    const suffix = flowEvent.hasInput ? ' with input.' : '.';
    const text = `Execution resumed at ${flowEvent.stageName}${suffix}`;
    this.entries.push({
      type: 'resume',
      text,
      depth: 0,
      stageName: flowEvent.stageName,
      stageId: flowEvent.traversalContext?.stageId ?? flowEvent.stageId,
      subflowId: flowEvent.traversalContext?.subflowId,
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

    let validationIssues: string | undefined;
    if (flowEvent.structuredError?.issues?.length) {
      validationIssues = flowEvent.structuredError.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          return `${path}: ${issue.message}`;
        })
        .join('; ');
    }

    const ctx: ErrorRenderContext = {
      stageName: flowEvent.stageName,
      message: flowEvent.message,
      validationIssues,
    };
    const text = this.renderer?.renderError?.(ctx) ?? this.defaultRenderError(ctx);
    this.entries.push({
      type: 'error',
      text,
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
      const valueSummary = this.formatValue(op.rawValue, this.maxValueLength);
      const opCtx: OpRenderContext = {
        type: op.type,
        key: op.key,
        rawValue: op.rawValue,
        valueSummary,
        operation: op.operation,
        stepNumber: op.stepNumber,
      };

      const text = this.renderer?.renderOp ? this.renderer.renderOp(opCtx) : this.defaultRenderOp(opCtx);

      if (text == null) continue; // renderer excluded this op (null or undefined)

      this.entries.push({
        type: 'step',
        text,
        depth: 1,
        stageName,
        stageId,
        stepNumber: op.stepNumber,
        subflowId,
        key: op.key,
        rawValue: op.rawValue,
      });
    }

    this.pendingOps.delete(stageName);
  }

  // ── Default renderers (used when no custom renderer is provided) ────

  private defaultRenderStage(ctx: StageRenderContext): string {
    const inner = ctx.isFirst
      ? ctx.description
        ? `The process began: ${ctx.description}.`
        : `The process began with ${ctx.stageName}.`
      : ctx.description
      ? `Next step: ${ctx.description}.`
      : `Next, it moved on to ${ctx.stageName}.`;
    return `Stage ${ctx.stageNumber}: ${inner}`;
  }

  private defaultRenderOp(ctx: OpRenderContext): string {
    const stepPrefix = this.includeStepNumbers ? `Step ${ctx.stepNumber}: ` : '';
    if (ctx.type === 'read') {
      return this.includeValues && ctx.valueSummary
        ? `${stepPrefix}Read ${ctx.key} = ${ctx.valueSummary}`
        : `${stepPrefix}Read ${ctx.key}`;
    }
    if (ctx.operation === 'delete') {
      return `${stepPrefix}Delete ${ctx.key}`;
    }
    if (ctx.operation === 'update') {
      return this.includeValues
        ? `${stepPrefix}Update ${ctx.key} = ${ctx.valueSummary}`
        : `${stepPrefix}Update ${ctx.key}`;
    }
    return this.includeValues ? `${stepPrefix}Write ${ctx.key} = ${ctx.valueSummary}` : `${stepPrefix}Write ${ctx.key}`;
  }

  private defaultRenderDecision(ctx: DecisionRenderContext): string {
    const branchName = ctx.chosen;
    let conditionText: string;
    if (ctx.evidence) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evidence = ctx.evidence as any;
      const matchedRule = evidence.rules?.find((r: any) => r.matched);
      if (matchedRule) {
        const label = matchedRule.label ? ` "${matchedRule.label}"` : '';
        if (matchedRule.type === 'filter') {
          const parts = matchedRule.conditions.map(
            (c: any) =>
              `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`,
          );
          conditionText = `It evaluated Rule ${matchedRule.ruleIndex}${label}: ${parts.join(
            ', ',
          )}, and chose ${branchName}.`;
        } else {
          const parts = matchedRule.inputs.map((i: any) => `${i.key}=${i.valueSummary}`);
          conditionText = `It examined${label}: ${parts.join(', ')}, and chose ${branchName}.`;
        }
      } else {
        const erroredCount = evidence.rules?.filter((r: any) => r.matchError !== undefined).length ?? 0;
        const errorNote = erroredCount > 0 ? ` (${erroredCount} rule${erroredCount > 1 ? 's' : ''} threw errors)` : '';
        conditionText = `No rules matched${errorNote}, fell back to default: ${branchName}.`;
      }
    } else if (ctx.description && ctx.rationale) {
      conditionText = `It ${ctx.description}: ${ctx.rationale}, so it chose ${branchName}.`;
    } else if (ctx.description) {
      conditionText = `It ${ctx.description} and chose ${branchName}.`;
    } else if (ctx.rationale) {
      conditionText = `A decision was made: ${ctx.rationale}, so the path taken was ${branchName}.`;
    } else {
      conditionText = `A decision was made, and the path taken was ${branchName}.`;
    }
    return `[Condition]: ${conditionText}`;
  }

  private defaultRenderFork(ctx: ForkRenderContext): string {
    const names = ctx.children.join(', ');
    return `[Parallel]: Forking into ${ctx.children.length} parallel paths: ${names}.`;
  }

  private defaultRenderSelected(ctx: SelectedRenderContext): string {
    if (ctx.evidence) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evidence = ctx.evidence as any;
      const matched = evidence.rules?.filter((r: any) => r.matched) ?? [];
      const parts = matched.map((r: any) => {
        const label = r.label ? ` "${r.label}"` : '';
        if (r.type === 'filter') {
          const conds = r.conditions
            .map(
              (c: any) =>
                `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`,
            )
            .join(', ');
          return `${r.branch}${label} (${conds})`;
        }
        const inputs = r.inputs.map((i: any) => `${i.key}=${i.valueSummary}`).join(', ');
        return `${r.branch}${label} (${inputs})`;
      });
      return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected: ${parts.join('; ')}.`;
    }
    const names = ctx.selected.join(', ');
    return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected for execution: ${names}.`;
  }

  private defaultRenderSubflow(ctx: SubflowRenderContext): string {
    if (ctx.direction === 'exit') {
      return `Exiting the ${ctx.name} subflow.`;
    }
    return ctx.description
      ? `Entering the ${ctx.name} subflow: ${ctx.description}.`
      : `Entering the ${ctx.name} subflow.`;
  }

  private defaultRenderLoop(ctx: LoopRenderContext): string {
    return ctx.description
      ? `On pass ${ctx.iteration}: ${ctx.description} again.`
      : `On pass ${ctx.iteration} through ${ctx.target}.`;
  }

  private defaultRenderBreak(ctx: BreakRenderContext): string {
    return `Execution stopped at ${ctx.stageName}.`;
  }

  private defaultRenderError(ctx: ErrorRenderContext): string {
    let text = `An error occurred at ${ctx.stageName}: ${ctx.message}.`;
    if (ctx.validationIssues) {
      text += ` Validation issues: ${ctx.validationIssues}.`;
    }
    return `[Error]: ${text}`;
  }
}
