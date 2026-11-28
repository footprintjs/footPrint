import type { RedactionRule } from '../../memory/redaction.js';

const verifiers = new WeakMap<RedactionRule, () => string | undefined>();

/** Only the executor installs the verifier for a rule it admitted. */
export function bindChildEvidencePolicy(rule: RedactionRule, verify: () => string | undefined): RedactionRule {
  verifiers.set(rule, verify);
  return rule;
}

export function childEvidencePolicy(rule: RedactionRule | undefined): string | undefined {
  return rule && verifiers.get(rule)?.();
}
