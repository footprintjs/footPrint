/** Shared English sentence bodies, with no event capture or recorder state. */
import type { ValidationIssue } from '../../../schema/errors.js';
import type {
  BreakRenderContext,
  DecisionRenderContext,
  ErrorRenderContext,
  ForkRenderContext,
  LoopRenderContext,
  StageRenderContext,
} from '../narrativeTypes.js';
import type { FlowResumeEvent } from '../types.js';

export function nextStageSentence(ctx: Pick<StageRenderContext, 'stageName' | 'description'>): string {
  return ctx.description ? `Next step: ${ctx.description}.` : `Next, it moved on to ${ctx.stageName}.`;
}

/** Evidence takes precedence at the Combined recorder; this is only its fallback. */
export function decisionSentence(ctx: Pick<DecisionRenderContext, 'chosen' | 'description' | 'rationale'>): string {
  const branchName = ctx.chosen;
  if (ctx.description && ctx.rationale) {
    return `It ${ctx.description}: ${ctx.rationale}, so it chose ${branchName}.`;
  }
  if (ctx.description) return `It ${ctx.description} and chose ${branchName}.`;
  if (ctx.rationale) return `A decision was made: ${ctx.rationale}, so the path taken was ${branchName}.`;
  return `A decision was made, and the path taken was ${branchName}.`;
}

export function forkSentence(ctx: ForkRenderContext): string {
  const names = ctx.children.join(', ');
  return `Forking into ${ctx.children.length} parallel paths: ${names}.`;
}

export function loopSentence(ctx: LoopRenderContext): string {
  return ctx.description
    ? `On pass ${ctx.iteration}: ${ctx.description} again.`
    : `On pass ${ctx.iteration} through ${ctx.target}.`;
}

export function breakSentence(ctx: BreakRenderContext): string {
  return `Execution stopped at ${ctx.stageName}.`;
}

export function pauseSentence(ctx: BreakRenderContext): string {
  return `Execution paused at ${ctx.stageName}.`;
}

export function resumeSentence(ctx: Pick<FlowResumeEvent, 'stageName' | 'hasInput'>): string {
  const suffix = ctx.hasInput ? ' with input.' : '.';
  return `Execution resumed at ${ctx.stageName}${suffix}`;
}

export function validationDetails(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function errorSentence(ctx: Pick<ErrorRenderContext, 'stageName' | 'message'>): string {
  return `An error occurred at ${ctx.stageName}: ${ctx.message}.`;
}

/** Callers retain their distinct rules for whether to display empty details. */
export function validationSentence(details: string): string {
  return ` Validation issues: ${details}.`;
}
