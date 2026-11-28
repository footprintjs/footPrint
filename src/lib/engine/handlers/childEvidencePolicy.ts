import type { SubflowCapturePort } from '../../capture/subflowCapability.js';
import type { RedactionRule } from '../../memory/redaction.js';
import type { SubflowResult } from '../types.js';

const disclosures = new WeakMap<SubflowResult, readonly [string | object, SubflowCapturePort | undefined]>();

type Stamp = string | object;
const verifiers = new WeakMap<RedactionRule, () => Stamp>();

/** Only the executor installs the verifier for a rule it admitted. */
export function bindChildEvidencePolicy(rule: RedactionRule, verify: () => Stamp): RedactionRule {
  verifiers.set(rule, verify);
  return rule;
}

export function childEvidencePolicy(rule: RedactionRule | undefined): Stamp {
  return (rule && verifiers.get(rule)?.()) ?? {};
}

export function rememberChildDisclosure(
  result: SubflowResult,
  entryPolicy: string | object,
  rule: RedactionRule | undefined,
  hasMirror: boolean,
  capture: SubflowCapturePort | undefined,
): void {
  // An entry that changed during collection has no single established disclosure.
  // A dynamic mark can affect state without enabling a mirror.
  if (entryPolicy === childEvidencePolicy(rule) && (hasMirror || rule?.isInert() !== false)) {
    disclosures.set(result, [entryPolicy, capture]);
  }
}

export function canServeRetainedChild(
  result: SubflowResult,
  policy: string | object,
  capture: SubflowCapturePort | undefined,
): boolean {
  const disclosure = disclosures.get(result);
  return disclosure?.[0] === policy && disclosure[1] === capture;
}
