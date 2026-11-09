import type { ReadTrackingMode, WriteTrackingMode } from '../frameTypes.js';
import { type RedactionVerdict, RedactionRule, SCOPE_PLACEHOLDER } from '../redaction.js';

/**
 * The form of a value the engine RETAINS (reads and writes retention):
 * the placeholder beats every dial; a field-level scrub happens before the
 * dial sees the value; a clear value is summarized or cloned as the dial
 * says. Callers handle `undefined` before asking.
 */
export function retainedForm(
  verdict: RedactionVerdict,
  value: unknown,
  mode: ReadTrackingMode | WriteTrackingMode,
  summarize: (value: unknown) => unknown,
): unknown {
  if (verdict.kind === 'whole') return SCOPE_PLACEHOLDER;
  const scrubbed = verdict.kind === 'fields' ? RedactionRule.scrubFields(value, verdict.paths) : undefined;
  if (mode === 'summary') return summarize(scrubbed ?? value);
  return scrubbed ?? structuredClone(value);
}

/**
 * The rule with something to say — `undefined` on the no-policy path (no
 * rule installed, or a rule with no policy entries and no marked keys), so
 * a tracked read or a staged write there pays no verdict call and no path
 * allocation. The default run is byte-identical AND cost-identical.
 */
export function activeRule(rule: RedactionRule | undefined): RedactionRule | undefined {
  return rule !== undefined && !rule.isInert() ? rule : undefined;
}
