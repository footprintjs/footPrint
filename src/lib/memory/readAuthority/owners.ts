import { originalOwners } from './identity.js';

/** Only fixed owner data is retained by constructor registration. */
export function createRuleAuthority(prototype: object) {
  return originalOwners(prototype, ['isInert']);
}

export function createContextAuthority(prototype: object) {
  return originalOwners(prototype, ['getPolicy', 'getRedactionRule', 'usePolicy', 'useRedactionRule', 'adoptPolicy']);
}
