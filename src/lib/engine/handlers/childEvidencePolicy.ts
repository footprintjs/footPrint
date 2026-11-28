import type { SubflowCapturePort } from '../../capture/subflowCapability.js';
import { type RedactionPolicy, RedactionRule } from '../../memory/redaction.js';
import type { SubflowResult } from '../types.js';

const disclosures = new WeakMap<SubflowResult, readonly [string | object, SubflowCapturePort | undefined]>();

const regex = RegExp.prototype;
const descriptors = Object.getOwnPropertyDescriptors(regex);
const properties = Object.keys(descriptors);

function policySelectors(policy: RedactionPolicy | undefined): unknown[] {
  return [[...(policy?.keys ?? [])], Object.entries(policy?.fields ?? {}), policy?.patterns?.map(patternSignature)];
}

/** An intrinsic matcher with untouched accessors is described by source and flags. */
function patternSignature(pattern: RegExp): string[] {
  if (
    Object.getPrototypeOf(pattern) !== regex ||
    Reflect.ownKeys(pattern).length !== 1 ||
    properties.some((key) => {
      const current = Object.getOwnPropertyDescriptor(regex, key);
      return current?.get !== descriptors[key].get || current?.value !== descriptors[key].value;
    })
  )
    throw new TypeError();
  return [descriptors.source.get!.call(pattern), pattern.flags];
}

/** Copy the effective policy by value; custom matchers cannot prove continuity. */
export function childEvidencePolicy(rule: RedactionRule | undefined): string | object {
  const policy = rule?.getPolicy();
  const marks = rule?.marksForCheckpoint();
  try {
    const selectors = [
      policySelectors(policy),
      policySelectors(policy?.diagnostics),
      policy?.emitPatterns?.map(patternSignature),
    ];
    // A mark already required by the declarative policy adds no restriction.
    const declared = marks?.keys.length ? new RedactionRule(policy) : undefined;
    return JSON.stringify([selectors, marks?.keys.filter((key) => !declared?.isKeyRedacted(key)) ?? [], marks?.fields]);
  } catch {
    // An unverified observation never compares equal to another observation.
    return {};
  }
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
