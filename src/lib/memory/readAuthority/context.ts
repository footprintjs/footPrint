import { originalOwners } from './identity.js';
import { dataField } from './intrinsics.js';
import { observePolicy } from './policy.js';
import type { RuleObservation } from './rule.js';

/** No saved Rule/policy: every observation reads the actual current admitted DATA carrier. */
export function createContextAuthority(prototype: object, observeRule: RuleObservation) {
  const owners = originalOwners(prototype, [
    'getPolicy',
    'getRedactionRule',
    'usePolicy',
    'useRedactionRule',
    'adoptPolicy',
  ]);
  return {
    register: owners.register,
    observe(context: unknown): boolean | undefined {
      if (!owners.admits(context)) return undefined;
      const policy = dataField(context, 'policy');
      return policy ? observePolicy(policy.value, observeRule) : undefined;
    },
  };
}
