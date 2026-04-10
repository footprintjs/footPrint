/**
 * CombinedNarrativeRecorder — Inline narrative builder that merges flow + data during traversal.
 *
 * Extends SequenceRecorder<CombinedNarrativeEntry> for dual-indexed storage (ordered sequence
 * + O(1) per-step lookup by runtimeStageId). Implements BOTH FlowRecorder (control-flow events)
 * and Recorder (scope data events).
 *
 * Event ordering guarantees this works:
 *   1. Scope events (onRead, onWrite) fire DURING stage execution
 *   2. Flow events (onStageExecuted, onDecision) fire AFTER stage execution
 *   3. Both carry the same `stageName` — no matching ambiguity
 *
 * So we buffer scope ops per-stage, then when the flow event arrives,
 * emit the stage entry + flush the buffered ops in one pass.
 */

import { SequenceRecorder } from '../../recorder/SequenceRecorder.js';
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

export class CombinedNarrativeRecorder
  extends SequenceRecorder<CombinedNarrativeEntry>
  implements FlowRecorder, Recorder
{
  readonly id: string;

  /**
   * Pending scope ops keyed by runtimeStageId. Flushed in onStageExecuted/onDecision.
   *
   * Keying by runtimeStageId (not stageName) ensures correctness when parallel fork
   * branches contain stages with the same name — each execution step has a unique ID.
   */
  private pendingOps = new Map<string, BufferedOp[]>();
  /** Per-subflow stage counters. Key '' = root flow. */
  private stageCounters = new Map<string, number>();
  /** Per-subflow first-stage flags. Key '' = root flow. */
  private firstStageFlags = new Map<string, boolean>();
  /** Visit count per stageId — detects loop iterations (count > 1 = loop). */
  private stageVisitCounts = new Map<string, number>();

  private includeStepNumbers: boolean;
  private includeValues: boolean;
  private maxValueLength: number;
  private formatValue: (value: unknown, maxLen: number) => string;
  private renderer?: NarrativeRenderer;

  constructor(options?: CombinedNarrativeRecorderOptions & { id?: string }) {
    super();
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
    this.bufferOp(event.runtimeStageId, {
      type: 'read',
      key: event.key,
      rawValue: event.value,
    });
  }

  onWrite(event: WriteEvent): void {
    this.bufferOp(event.runtimeStageId, {
      type: 'write',
      key: event.key,
      rawValue: event.value,
      operation: event.operation,
    });
  }

  // ── Flow channel (fires after stage execution) ────────────────────────

  onStageExecuted(event: FlowStageEvent): void {
    const stageId = event.traversalContext?.stageId;
    const runtimeStageId = event.traversalContext?.runtimeStageId;
    const sfKey = event.traversalContext?.subflowId ?? '';
    const stageNum = this.incrementStageCounter(sfKey);
    const isFirst = this.consumeFirstStageFlag(sfKey);

    // Track visit count per stageId to detect loop iterations
    const visitKey = stageId ?? event.stageName;
    const visitCount = (this.stageVisitCounts.get(visitKey) ?? 0) + 1;
    this.stageVisitCounts.set(visitKey, visitCount);

    const ctx: StageRenderContext = {
      stageName: event.stageName,
      stageNumber: stageNum,
      isFirst,
      description: event.description,
      loopIteration: visitCount > 1 ? visitCount - 1 : undefined,
    };
    const text = this.renderer?.renderStage?.(ctx) ?? this.defaultRenderStage(ctx);

    const sfId = event.traversalContext?.subflowId;
    this.emit({
      type: 'stage',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId,
      runtimeStageId,
      subflowId: sfId,
    });
    this.flushOps(runtimeStageId, sfId, stageId, event.stageName);
  }

  onDecision(event: FlowDecisionEvent): void {
    const stageId = event.traversalContext?.stageId;
    const runtimeStageId = event.traversalContext?.runtimeStageId;

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

    this.emit({
      type: 'stage',
      text: stageText,
      depth: 0,
      stageName: event.decider,
      stageId,
      runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
    this.flushOps(runtimeStageId, event.traversalContext?.subflowId, stageId, event.decider);

    // Emit the condition entry as a nested sub-item (depth 1) of the stage above.
    const decisionCtx: DecisionRenderContext = {
      decider: event.decider,
      chosen: event.chosen,
      description: event.description,
      rationale: event.rationale,
      evidence: event.evidence,
    };
    const conditionText = this.renderer?.renderDecision?.(decisionCtx) ?? this.defaultRenderDecision(decisionCtx);
    this.emit({
      type: 'condition',
      text: conditionText,
      depth: 1,
      stageName: event.decider,
      stageId,
      runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onNext(): void {
    // No-op. onStageExecuted already has the description for the next stage.
  }

  onFork(event: FlowForkEvent): void {
    const ctx: ForkRenderContext = { children: event.children };
    const text = this.renderer?.renderFork?.(ctx) ?? this.defaultRenderFork(ctx);
    this.emit({
      type: 'fork',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
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
    this.emit({
      type: 'selector',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const sfKey = event.subflowId ?? '';
    this.stageCounters.delete(sfKey);
    this.firstStageFlags.delete(sfKey);

    const ctx: SubflowRenderContext = {
      name: event.name,
      direction: 'entry',
      description: event.description,
    };
    const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
    this.emit({
      type: 'subflow',
      text,
      depth: 0,
      stageName: event.name,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
      direction: 'entry',
    });
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const ctx: SubflowRenderContext = {
      name: event.name,
      direction: 'exit',
    };
    const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
    this.emit({
      type: 'subflow',
      text,
      depth: 0,
      stageName: event.name,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
      direction: 'exit',
    });
  }

  onLoop(event: FlowLoopEvent): void {
    const ctx: LoopRenderContext = {
      target: event.target,
      iteration: event.iteration,
      description: event.description,
    };
    const text = this.renderer?.renderLoop?.(ctx) ?? this.defaultRenderLoop(ctx);
    this.emit({
      type: 'loop',
      text,
      depth: 0,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onBreak(event: FlowBreakEvent): void {
    const ctx: BreakRenderContext = { stageName: event.stageName };
    const text = this.renderer?.renderBreak?.(ctx) ?? this.defaultRenderBreak(ctx);
    this.emit({
      type: 'break',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onPause(event: FlowPauseEvent | { stageName?: string; stageId?: string }): void {
    // CombinedNarrativeRecorder implements BOTH Recorder and FlowRecorder, so onPause fires
    // from both channels. Discriminant: scope PauseEvent (extends RecorderContext) has 'pipelineId',
    // FlowPauseEvent does not. Skip scope events to avoid duplicate entries.
    if (Object.prototype.hasOwnProperty.call(event, 'pipelineId')) return;
    const flowEvent = event as FlowPauseEvent;
    if (!flowEvent.stageName || !flowEvent.stageId) return;
    const text = `Execution paused at ${flowEvent.stageName}.`;
    this.emit({
      type: 'pause',
      text,
      depth: 0,
      stageName: flowEvent.stageName,
      stageId: flowEvent.traversalContext?.stageId ?? flowEvent.stageId,
      runtimeStageId: flowEvent.traversalContext?.runtimeStageId,
      subflowId: flowEvent.traversalContext?.subflowId,
    });
  }

  onResume(event: FlowResumeEvent | { stageName?: string; stageId?: string }): void {
    // Same dual-interface discriminant as onPause — skip scope ResumeEvent (has pipelineId).
    if (Object.prototype.hasOwnProperty.call(event, 'pipelineId')) return;
    const flowEvent = event as FlowResumeEvent;
    if (!flowEvent.stageName || !flowEvent.stageId) return;
    const suffix = flowEvent.hasInput ? ' with input.' : '.';
    const text = `Execution resumed at ${flowEvent.stageName}${suffix}`;
    this.emit({
      type: 'resume',
      text,
      depth: 0,
      stageName: flowEvent.stageName,
      stageId: flowEvent.traversalContext?.stageId ?? flowEvent.stageId,
      runtimeStageId: flowEvent.traversalContext?.runtimeStageId,
      subflowId: flowEvent.traversalContext?.subflowId,
    });
  }

  onError(event: FlowErrorEvent | { stageName?: string; message?: string }): void {
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
    this.emit({
      type: 'error',
      text,
      depth: 0,
      stageName: flowEvent.stageName,
      stageId: flowEvent.traversalContext?.stageId,
      runtimeStageId: flowEvent.traversalContext?.runtimeStageId,
      subflowId: flowEvent.traversalContext?.subflowId,
    });
  }

  // ── Output (narrative-specific) ───────────────────────────────────────

  /** Returns formatted narrative lines (same output as CombinedNarrativeBuilder.build). */
  getNarrative(indent = '  '): string[] {
    const lines: string[] = [];
    this.forEachEntry((entry) => lines.push(`${indent.repeat(entry.depth)}${entry.text}`));
    return lines;
  }

  /**
   * Returns entries grouped by subflowId for structured access.
   * Root-level entries have subflowId = undefined.
   */
  getEntriesBySubflow(): Record<string, CombinedNarrativeEntry[]> {
    const result: Record<string, CombinedNarrativeEntry[]> = { '': [] };
    this.forEachEntry((entry) => {
      const key = entry.subflowId ?? '';
      if (!result[key]) result[key] = [];
      result[key].push(entry);
    });
    return result;
  }

  /** Clears all state. Called automatically before each run. */
  override clear(): void {
    super.clear();
    this.pendingOps.clear();
    this.stageCounters.clear();
    this.firstStageFlags.clear();
    this.stageVisitCounts.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private incrementStageCounter(subflowKey: string): number {
    const current = this.stageCounters.get(subflowKey) ?? 0;
    const next = current + 1;
    this.stageCounters.set(subflowKey, next);
    return next;
  }

  private consumeFirstStageFlag(subflowKey: string): boolean {
    if (!this.firstStageFlags.has(subflowKey)) {
      this.firstStageFlags.set(subflowKey, false);
      return true;
    }
    return false;
  }

  private bufferOp(runtimeStageId: string, op: Omit<BufferedOp, 'stepNumber'>): void {
    let ops = this.pendingOps.get(runtimeStageId);
    if (!ops) {
      ops = [];
      this.pendingOps.set(runtimeStageId, ops);
    }
    ops.push({ ...op, stepNumber: ops.length + 1 });
  }

  private flushOps(runtimeStageId: string | undefined, subflowId?: string, stageId?: string, stageName?: string): void {
    if (runtimeStageId === undefined) return;
    const ops = this.pendingOps.get(runtimeStageId);
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

      if (text == null) continue;

      this.emit({
        type: 'step',
        text,
        depth: 1,
        stageName,
        stageId,
        runtimeStageId,
        stepNumber: op.stepNumber,
        subflowId,
        key: op.key,
        rawValue: op.rawValue,
      });
    }

    this.pendingOps.delete(runtimeStageId);
  }

  // ── Default renderers ─────────────────────────────────────────────────

  private defaultRenderStage(ctx: StageRenderContext): string {
    let inner: string;
    if (ctx.isFirst) {
      inner = ctx.description ? `The process began: ${ctx.description}.` : `The process began with ${ctx.stageName}.`;
    } else if (ctx.loopIteration && ctx.loopIteration > 0) {
      inner = ctx.description
        ? `Looped back: ${ctx.description} (pass ${ctx.loopIteration}).`
        : `Looped back to ${ctx.stageName} (pass ${ctx.loopIteration}).`;
    } else {
      inner = ctx.description ? `Next step: ${ctx.description}.` : `Next, it moved on to ${ctx.stageName}.`;
    }
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
