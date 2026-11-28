import type { SubflowCapturePort } from '../../capture/subflowCapability.js';
import { type RedactionPolicy, RedactionRule } from '../../memory/redaction.js';
import type { SubflowResult } from '../types.js';

const disclosures = new WeakMap<SubflowResult, { policy: string; capture: SubflowCapturePort | undefined }>();

function selectors(policy: Pick<RedactionPolicy, 'keys' | 'patterns' | 'fields'> | undefined) {
  return [
    [...(policy?.keys ?? [])],
    policy?.patterns?.map(({ source, flags }) => [source, flags]) ?? [],
    Object.entries(policy?.fields ?? {}).map(([key, paths]) => [key, [...paths]]),
  ];
}

/** Copy the policy's inputs by value. The rule and its caller's settings can both change. */
export function childEvidencePolicy(rule: RedactionRule | undefined): string {
  const policy = rule?.getPolicy();
  const marks = rule?.marksForCheckpoint();
  // A mark already required by the declarative policy adds no restriction.
  const declared = marks?.keys.length ? new RedactionRule(policy) : undefined;
  const additionalKeys = marks?.keys.filter((key) => !declared?.isKeyRedacted(key)) ?? [];
  return JSON.stringify([
    selectors(policy),
    selectors(policy?.diagnostics),
    policy?.emitPatterns?.map(({ source, flags }) => [source, flags]) ?? [],
    additionalKeys,
    Object.entries(marks?.fields ?? {}),
  ]);
}

export function rememberChildDisclosure(
  result: SubflowResult,
  entryPolicy: string,
  rule: RedactionRule | undefined,
  hasMirror: boolean,
  capture: SubflowCapturePort | undefined,
): void {
  // An entry that changed during collection has no single established disclosure.
  // A dynamic mark can affect state without enabling a mirror.
  if (entryPolicy === childEvidencePolicy(rule) && (hasMirror || rule?.isInert() !== false)) {
    disclosures.set(result, { policy: entryPolicy, capture });
  }
}

export function canServeRetainedChild(
  result: SubflowResult,
  policy: string,
  capture: SubflowCapturePort | undefined,
): boolean {
  const disclosure = disclosures.get(result);
  return disclosure?.policy === policy && disclosure.capture === capture;
}
