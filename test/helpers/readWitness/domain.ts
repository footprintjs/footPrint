import type { DeletedReadInput, Receipt } from './observationTypes.js';
import { sameStageDeletedReadInputs } from './selector.js';

export type OracleDomain =
  | { readonly kind: 'in-domain' }
  | { readonly kind: 'out-of-domain'; readonly violations: readonly DeletedReadInput[] };
/** Only actual defined BASELINE returns after native tombstones exclude a program. */
export function oracleDomain(receipt: Receipt): OracleDomain {
  const violations = sameStageDeletedReadInputs(receipt).filter(({ read }) => read.result!.kind !== 'undefined');
  return violations.length
    ? Object.freeze({ kind: 'out-of-domain', violations: Object.freeze(violations) })
    : Object.freeze({ kind: 'in-domain' });
}
export class BuildTombstoneReadViolation extends Error {
  constructor(readonly violations: readonly DeletedReadInput[]) {
    super('BUILD returned a defined value after an unreestablished same-frame native tombstone.');
  }
}
/** Unconditional BUILD law; baseline classification is deliberately not an argument. */
export function assertBuildDeletedReadsUndefined(receipt: Receipt): void {
  const result = oracleDomain(receipt);
  if (result.kind === 'out-of-domain') throw new BuildTombstoneReadViolation(result.violations);
}
