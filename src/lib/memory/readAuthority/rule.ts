import { originalOwners } from './identity.js';
import { dataField, nativeSetSize } from './intrinsics.js';

/** true = observed inert, false = observed active, undefined = unknown authority. */
export type RuleObservation = (rule: unknown) => boolean | undefined;

export function createRuleAuthority(prototype: object) {
  const owners = originalOwners(prototype, ['isInert']);
  return {
    register: owners.register,
    observe(rule: unknown): boolean | undefined {
      if (!owners.admits(rule)) return undefined;
      const marked = dataField(rule, 'marked');
      const active = dataField(rule, 'policyActive');
      const inherited = dataField(rule, 'inherited');
      if (!marked || !active || !inherited || typeof active.value !== 'boolean') return undefined;
      const size = nativeSetSize(marked.value);
      if (size === undefined) return undefined;
      return size === 0 && !active.value && inherited.value === undefined;
    },
  };
}
