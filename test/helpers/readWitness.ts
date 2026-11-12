/** Test-only native observation and dynamic #124 oracle-domain rule. */
export type { NativeCapture } from './readWitness/capture.js';
export { captureNative, captureNativeSync } from './readWitness/capture.js';
export type { OracleDomain } from './readWitness/domain.js';
export {
  assertBuildDeletedReadsUndefined,
  assertBuildHardWrittenReadsUndefined,
  BuildHardWrittenReadViolation,
  BuildTombstoneReadViolation,
  commitsOfStaleReads,
  oracleDomain,
  staleReadsUnderHardWrite,
} from './readWitness/domain.js';
export {
  installReadLawObservation,
  requireDeletedReadInput,
  sameStageDeletedReadInputs,
  UnsupportedReadLawObservation,
} from './readWitness/observation.js';
export type {
  DeletedReadInput,
  HardWrittenReadInput,
  Header,
  Hooks,
  NativeFact,
  Receipt,
} from './readWitness/observationTypes.js';
export { assertDomainCount } from './readWitness/sampleCounts.js';
