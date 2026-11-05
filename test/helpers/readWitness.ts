/** Test-only side channel over the SAME native classes used by the commit witness. */
export type { Header, Hooks, NativeFact, Receipt, ValueFact } from './readWitness/observation.js';
export {
  installReadLawObservation,
  requireDeletedReadInput,
  sameStageDeletedReadInputs,
  UnsupportedReadLawObservation,
} from './readWitness/observation.js';
