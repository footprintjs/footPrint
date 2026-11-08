import { summarizeValue, SUMMARY_PREVIEW_LENGTH } from '../../../../capture/summarize.js';
import type { FilterCondition } from '../../../../decide/types.js';
import { SCOPE_PLACEHOLDER } from '../../../../memory/redaction.js';
import type { DecisionRenderContext, SelectedRenderContext } from '../../narrativeTypes.js';
import { decisionSentence } from '../sentences.js';

/** A condition's threshold as a sentence prints it: a value is quoted, a masked threshold is bare, so a hole never reads as a value. */
function thresholdText(
  condition: Pick<FilterCondition, 'threshold' | 'thresholdRedacted'>,
  inertPreview = false,
): string {
  if (inertPreview) {
    // Newly shown failed rules must not call object accessors/toJSON, or expand author-sized strings.
    if (condition.thresholdRedacted) return SCOPE_PLACEHOLDER;
    const value = condition.threshold;
    return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
      ? summarizeValue(value, SUMMARY_PREVIEW_LENGTH)
      : '[recorded threshold]';
  }
  return condition.thresholdRedacted ? String(condition.threshold) : JSON.stringify(condition.threshold);
}

export function defaultRenderDecision(ctx: DecisionRenderContext): string {
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
          (c: any) => `${c.key} ${c.actualSummary} ${c.op} ${thresholdText(c)} ${c.result ? '\u2713' : '\u2717'}`,
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
      // The default branch is chosen by no rule, so no rule label can explain
      // it. When decide() was given the object form of its default, evidence
      // carries that meaning — print it, exactly as a matched rule's label is
      // printed. Absent, the sentence is unchanged from before this field.
      const defaultLabel = evidence.defaultLabel ? ` "${evidence.defaultLabel}"` : '';
      conditionText = `No rules matched${errorNote}, fell back to default${defaultLabel}: ${branchName}.`;
    }
  } else {
    conditionText = decisionSentence(ctx);
  }
  return `[Condition]: ${conditionText}`;
}

export function defaultRenderSelected(ctx: SelectedRenderContext): string {
  if (ctx.evidence) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evidence = ctx.evidence as any;
    const matched = evidence.rules?.filter((r: any) => r.matched) ?? [];
    // Explain an observed empty selection with its evaluated rules, without evaluating them again.
    const shown = ctx.selected.length === 0 ? evidence.rules ?? [] : matched;
    const parts = shown.map((r: any) => {
      const label = r.label ? ` "${r.label}"` : '';
      if (r.type === 'filter') {
        const conds = r.conditions
          .map(
            (c: any) =>
              `${c.key} ${c.actualSummary} ${c.op} ${thresholdText(c, ctx.selected.length === 0)} ${
                c.result ? '\u2713' : '\u2717'
              }`,
          )
          .join(', ');
        return `${r.branch}${label} (${conds})`;
      }
      const inputs = r.inputs.map((i: any) => `${i.key}=${i.valueSummary}`).join(', ');
      return `${r.branch}${label} (${inputs})`;
    });
    if (ctx.selected.length === 0) {
      return `[Selected]: 0 of ${ctx.total} paths selected; no rules matched${
        parts.length ? `: ${parts.join('; ')}` : ''
      }.`;
    }
    return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected: ${parts.join('; ')}.`;
  }
  const names = ctx.selected.join(', ');
  return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected for execution: ${names}.`;
}
