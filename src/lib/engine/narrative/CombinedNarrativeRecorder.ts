/**
 * CombinedNarrativeRecorder — Inline narrative builder that merges flow + data during traversal.
 *
 * Extends SequenceRecorder<CombinedNarrativeEntry> for dual-indexed storage (ordered sequence
 * + O(1) per-step lookup by runtimeStageId). Implements `CombinedRecorder` — the library's
 * first-class abstraction for observers that span both data-flow and control-flow streams.
 *
 * Event ordering guarantees this works:
 *   1. Scope events (onRead, onWrite) fire DURING stage execution
 *   2. Flow events (onStageExecuted, onDecision) fire AFTER stage execution
 *   3. Both carry the same `stageName` — no matching ambiguity
 *
 * So we buffer scope ops per-stage, then when the flow event arrives,
 * emit the stage entry + flush the buffered ops in one pass.
 */

import type { CombinedRecorder } from '../../recorder/CombinedRecorder.js';
import { isFlowEvent } from '../../recorder/CombinedRecorder.js';
import type { EmitEvent } from '../../recorder/EmitRecorder.js';
import { SequenceRecorder } from '../../recorder/SequenceRecorder.js';
import { summarizeValue } from '../../scope/recorders/summarizeValue.js';
import type { ErrorEvent, PauseEvent, ReadEvent, ResumeEvent, WriteEvent } from '../../scope/types.js';
import type {
  BreakRenderContext,
  CombinedNarrativeEntry,
  DecisionRenderContext,
  EmitRenderContext,
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
  FlowResumeEvent,
  FlowSelectedEvent,
  FlowStageEvent,
  FlowSubflowEvent,
} from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface BufferedOp {
  type: 'read' | 'write' | 'emit';
  /** For read/write: scope key. For emit: the event name. */
  key: string;
  rawValue: unknown;
  operation?: 'set' | 'update' | 'delete';
  stepNumber: number;
  /** Only set for type='emit' — carries the full EmitEvent for rendering. */
  emitEvent?: EmitEvent;
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

/**
 * Implements `CombinedRecorder` — the library's first-class abstraction for
 * observers that span both data-flow (`Recorder`) and control-flow
 * (`FlowRecorder`) streams. One `id`, routed to both channels via
 * `executor.attachCombinedRecorder(...)` (or equivalently via
 * `executor.enableNarrative(...)` which auto-creates an instance).
 *
 * For shared-method-name events (`onError`, `onPause`, `onResume`) the
 * handler accepts the union payload type; we discriminate via `isFlowEvent`.
 * Scope variants of these events are deliberately ignored here — the
 * narrative only surfaces control-flow lifecycle events.
 */
export class CombinedNarrativeRecorder extends SequenceRecorder<CombinedNarrativeEntry> implements CombinedRecorder {
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
      mappedInput: event.mappedInput,
    };
    const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
    const rid = event.traversalContext?.runtimeStageId;
    const sid = event.traversalContext?.stageId;
    const sfId = event.traversalContext?.subflowId;
    this.emit({
      type: 'subflow',
      text,
      depth: 0,
      stageName: event.name,
      stageId: sid,
      runtimeStageId: rid,
      subflowId: sfId,
      direction: 'entry',
    });
    // Emit per-key step entries for mapped inputs.
    //
    // Route EACH key through the consumer's `renderer.renderOp` hook before
    // falling back to the hardcoded `Input: ${key} = ${valueSummary}`
    // template. Without this routing, a consumer that provided a
    // domain-aware `renderer.renderOp` (to render e.g. `parsedResponse`
    // objects semantically) would see beautiful output for scope writes
    // but get the generic key-list fallback for subflow inputs — the
    // library's "combined narrative" promise (one renderer controls the
    // whole narrative) would silently break. We honour it here.
    //
    // The OpRenderContext is built with `type: 'write'` because semantically
    // the subflow's initial scope IS being written via the parent's
    // inputMapper. `operation: 'set'` likewise — this is the subflow's
    // first sight of the key.
    //
    // Values shown when includeValues=true — consumer responsible for
    // redaction policy on the parent scope (redacted keys produce
    // '[REDACTED]' via ScopeFacade).
    if (event.mappedInput && Object.keys(event.mappedInput).length > 0) {
      let stepNumber = 0;
      for (const [key, value] of Object.entries(event.mappedInput)) {
        const valueSummary = this.formatValue(value, this.maxValueLength);
        const opCtx: OpRenderContext = {
          type: 'write',
          key,
          rawValue: value,
          valueSummary,
          operation: 'set',
          stepNumber: ++stepNumber,
        };

        // If the consumer supplied `renderer.renderOp`, use its return value:
        //   - string → use as the narrative line
        //   - null   → deliberately exclude this entry (same semantics as
        //              `flushOps` above at line ~540)
        //   - undefined → renderer does not handle this op → fall through
        //                 to the hardcoded template
        // If no renderer at all, use the hardcoded template.
        let text: string | null;
        if (this.renderer?.renderOp) {
          const customText = this.renderer.renderOp(opCtx);
          if (customText === null) continue; // excluded on purpose
          text =
            customText !== undefined
              ? customText
              : this.includeValues
              ? `Input: ${key} = ${valueSummary}`
              : `Input: ${key}`;
        } else {
          text = this.includeValues ? `Input: ${key} = ${valueSummary}` : `Input: ${key}`;
        }

        this.emit({
          type: 'step',
          text,
          depth: 1,
          stageName: event.name,
          stageId: sid,
          runtimeStageId: rid,
          subflowId: sfId,
          key,
          rawValue: value,
        });
      }
    }
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const rid = event.traversalContext?.runtimeStageId;
    const sid = event.traversalContext?.stageId;
    const sfId = event.traversalContext?.subflowId;
    // NOTE: output state is NOT emitted as step entries because it may contain
    // unredacted values from the subflow's internal scope. The subflow exit
    // header is sufficient — drill into the subflow for details.
    const ctx: SubflowRenderContext = {
      name: event.name,
      direction: 'exit',
      outputState: event.outputState,
    };
    const text = this.renderer?.renderSubflow?.(ctx) ?? this.defaultRenderSubflow(ctx);
    this.emit({
      type: 'subflow',
      text,
      depth: 0,
      stageName: event.name,
      stageId: sid,
      runtimeStageId: rid,
      subflowId: sfId,
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

  onPause(event: PauseEvent | FlowPauseEvent): void {
    // Both channels fire onPause with different payload shapes. Narrative only
    // surfaces the control-flow variant (which has stageName/stageId). Data
    // channel's PauseEvent is ignored to avoid duplicate entries.
    if (!isFlowEvent(event)) return;
    if (!event.stageName || !event.stageId) return;
    const text = `Execution paused at ${event.stageName}.`;
    this.emit({
      type: 'pause',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId: event.traversalContext?.stageId ?? event.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onResume(event: ResumeEvent | FlowResumeEvent): void {
    // Same isFlowEvent discriminant as onPause — ignore scope ResumeEvent.
    if (!isFlowEvent(event)) return;
    if (!event.stageName || !event.stageId) return;
    const suffix = event.hasInput ? ' with input.' : '.';
    const text = `Execution resumed at ${event.stageName}${suffix}`;
    this.emit({
      type: 'resume',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId: event.traversalContext?.stageId ?? event.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  onError(event: ErrorEvent | FlowErrorEvent): void {
    // Narrative only surfaces the control-flow variant of errors (has
    // stageName + message). Scope-level ErrorEvent is captured elsewhere.
    if (!isFlowEvent(event)) return;
    if (typeof event.message !== 'string') return;

    let validationIssues: string | undefined;
    if (event.structuredError?.issues?.length) {
      validationIssues = event.structuredError.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          return `${path}: ${issue.message}`;
        })
        .join('; ');
    }

    const ctx: ErrorRenderContext = {
      stageName: event.stageName,
      message: event.message,
      validationIssues,
    };
    const text = this.renderer?.renderError?.(ctx) ?? this.defaultRenderError(ctx);
    this.emit({
      type: 'error',
      text,
      depth: 0,
      stageName: event.stageName,
      stageId: event.traversalContext?.stageId,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      subflowId: event.traversalContext?.subflowId,
    });
  }

  // ── Emit channel (Phase 3) ────────────────────────────────────────────

  /**
   * Receive a consumer-emitted event from `scope.$emit(name, payload)`.
   *
   * Buffered alongside `onRead`/`onWrite` per-stage so that the final
   * narrative preserves ordering:
   *
   *   1. stage header (emitted by `onStageExecuted` / `onDecision`)
   *   2. buffered ops for that stage — in call order — flushed right after
   *
   * Without buffering, emit events would fire BEFORE the stage header
   * (which only lands at `onStageExecuted`), producing out-of-order
   * narrative entries. Flush happens in `flushOps` which routes `emit`-
   * typed buffered ops through `renderEmit` instead of `renderOp`.
   */
  onEmit(event: EmitEvent): void {
    this.bufferOp(event.runtimeStageId, {
      type: 'emit',
      key: event.name,
      rawValue: event.payload,
      emitEvent: event,
    });
  }

  private defaultRenderEmit(ctx: EmitRenderContext): string {
    return `[emit] ${ctx.name}: ${ctx.payloadSummary}`;
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
      // ── Emit events take a different render path ───────────────────────
      //
      // Emit events are buffered alongside reads/writes (so they appear
      // under their owning stage's header in narrative order, not inline
      // at call time). At flush, they route through `renderEmit` instead
      // of `renderOp` — consumers wanting custom emit rendering implement
      // the dedicated hook. Unhandled / missing renderer falls back to
      // the same compact `[emit] name: payloadSummary` default used by
      // the pre-buffering onEmit path.
      if (op.type === 'emit' && op.emitEvent) {
        const e = op.emitEvent;
        const payloadSummary = this.formatValue(e.payload, this.maxValueLength);
        const emitCtx: EmitRenderContext = {
          name: e.name,
          payload: e.payload,
          stageName: e.stageName,
          runtimeStageId: e.runtimeStageId,
          subflowPath: e.subflowPath,
          pipelineId: e.pipelineId,
          timestamp: e.timestamp,
          payloadSummary,
        };
        let emitText: string;
        if (this.renderer?.renderEmit) {
          const custom = this.renderer.renderEmit(emitCtx);
          if (custom === null) continue; // deliberately excluded
          emitText = custom !== undefined ? custom : this.defaultRenderEmit(emitCtx);
        } else {
          emitText = this.defaultRenderEmit(emitCtx);
        }
        this.emit({
          type: 'emit',
          text: emitText,
          depth: 1,
          stageName,
          stageId,
          runtimeStageId,
          stepNumber: op.stepNumber,
          subflowId,
        });
        continue;
      }

      // At this point op.type is narrowed to 'read' | 'write' (emit branch
      // above uses `continue`). TypeScript can't follow that narrowing
      // through the continue, so we assert at render time.
      const opType = op.type as 'read' | 'write';
      const valueSummary = this.formatValue(op.rawValue, this.maxValueLength);
      const opCtx: OpRenderContext = {
        type: opType,
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
    return ctx.description ? `Entering ${ctx.name}: ${ctx.description}.` : `Entering the ${ctx.name} subflow.`;
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
