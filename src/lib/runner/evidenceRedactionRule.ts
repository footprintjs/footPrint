import { bindChildEvidencePolicy } from '../engine/handlers/childEvidencePolicy.js';
import { type RedactionPolicy, RedactionRule } from '../memory/redaction.js';

const regex = RegExp.prototype;
const array = Array.prototype;
const prototypes = [regex, array, Object.prototype, Array].map(
  (prototype) =>
    [
      prototype,
      Reflect.ownKeys(prototype).map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)!] as const),
    ] as const,
);

function assertNativePrototypes(): void {
  for (const [prototype, shape] of prototypes) {
    if (Reflect.ownKeys(prototype).length !== shape.length) throw new TypeError();
    for (const [key, known] of shape) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor?.get !== known.get || descriptor?.value !== known.value) throw new TypeError();
    }
  }
}

/** Validate before cloning so verification does not invoke caller accessors. */
function assertSelectorData(value: unknown): void {
  if (value === undefined || typeof value === 'string') return;
  if (!value || typeof value !== 'object') throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (prototype === regex && keys.length === 1) return;
  const list = Array.isArray(value);
  if (list ? prototype !== array : prototype !== Object.prototype && prototype !== null) throw new TypeError();
  keys.forEach((key, index) => {
    if (list && index === value.length && key === 'length') return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof key !== 'string' ||
      (list && key !== String(index))
    )
      throw new TypeError();
    assertSelectorData(descriptor.value);
  });
}

function policyStamp(policy: RedactionPolicy | undefined): string | undefined {
  if (!policy) return '';
  try {
    assertNativePrototypes();
    assertSelectorData(policy);
    // The descriptor walk also protects the native clone from policy getters.
    // The clone refuses proxy objects that can emulate ordinary descriptors.
    return JSON.stringify(structuredClone(policy), (_, value) =>
      value instanceof RegExp ? 'r' + String(value) : typeof value === 'string' ? 's' + value : value,
    );
  } catch {
    return undefined;
  }
}

export function evidenceRedactionRule(policy?: RedactionPolicy): RedactionRule {
  const rule = new RedactionRule(policy);
  const admitted = policyStamp(policy);
  return bindChildEvidencePolicy(rule, () => {
    // The native rule caches path and diagnostic selectors when installed.
    if (admitted === undefined || policyStamp(rule.getPolicy()) !== admitted) return {};
    const marks = rule.marksForCheckpoint();
    const declared = marks?.keys.length ? new RedactionRule(policy) : undefined;
    return JSON.stringify([admitted, marks?.keys.filter((key) => !declared?.isKeyRedacted(key)) ?? [], marks?.fields]);
  });
}
