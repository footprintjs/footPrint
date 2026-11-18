import { weaklyAdd, weaklyHas } from './intrinsics.js';

const policies = new WeakSet<object>();

/** Called only on objects produced at DEFAULT/runPolicy/derivePolicy's existing freeze sites. */
export function mintPolicy<T extends object>(policy: T): T {
  weaklyAdd(policies, policy);
  return policy;
}

export function isMintedPolicy(policy: unknown): policy is object {
  return weaklyHas(policies, policy);
}
