import type { RedactionRule } from '../redaction.js';

const verifiers = new WeakMap<RedactionRule, () => string | undefined>();

/** Only the executor installs the verifier for a rule it admitted. */
export function registerRedactionDisclosure(rule: RedactionRule, verify: () => string | undefined): RedactionRule {
  verifiers.set(rule, verify);
  return rule;
}

export function observeRedactionDisclosure(rule: RedactionRule | undefined): string | undefined {
  return rule && verifiers.get(rule)?.();
}
