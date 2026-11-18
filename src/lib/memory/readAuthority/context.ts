import { type OwnerData, admitsOwner } from './identity.js';
import { dataField } from './intrinsics.js';
import { observePolicy } from './policyObservation.js';
import type { RuleObservation } from './rule.js';

/** No saved Rule/policy: every observation reads the actual current admitted DATA carrier. */
export function observeContext(owners: OwnerData, context: unknown, observeRule: RuleObservation): boolean | undefined {
  if (!admitsOwner(owners, context)) return undefined;
  const policy = dataField(context, 'policy');
  return policy ? observePolicy(policy.value, observeRule) : undefined;
}
