/** Test-only side channel over the SAME native classes used by the commit witness. */
export type { OriginPort, OriginProof, Profile } from './readWitness/commitOrigin.js';
export { installCommitOrigins } from './readWitness/commitOrigin.js';
export type { IdentityGraph } from './readWitness/identityGraph.js';
export { identityGraph } from './readWitness/identityGraph.js';
export type { Header, Hooks, NativeFact, Receipt, ValueFact } from './readWitness/observation.js';
export {
  installReadLawObservation,
  requireDeletedReadInput,
  sameStageDeletedReadInputs,
  UnsupportedReadLawObservation,
} from './readWitness/observation.js';
export type { FixtureEdit, FixtureOperations, OperationSpan, OperationStamp } from './readWitness/operationPort.js';
export { createOperationPort } from './readWitness/operationPort.js';
