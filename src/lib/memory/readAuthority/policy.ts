import { dataField, objectPrototype, ownDescriptor, prototypeOf, weaklyAdd, weaklyHas } from './intrinsics.js';
import type { RuleObservation } from './rule.js';

const policies = new WeakSet<object>();

/** Called only on objects produced at DEFAULT/runPolicy/derivePolicy's existing freeze sites. */
export function mintPolicy<T extends object>(policy: T): T {
  weaklyAdd(policies, policy);
  return policy;
}

export function observePolicy(policy: unknown, observeRule: RuleObservation): boolean | undefined {
  if (!weaklyHas(policies, policy)) return undefined;
  if (prototypeOf(policy) !== objectPrototype) return undefined;
  const descriptor = ownDescriptor(policy, 'redaction');
  if (descriptor === undefined) return true;
  const field = dataField(policy, 'redaction');
  if (!field) return undefined;
  return field.value === undefined ? true : observeRule(field.value);
}
