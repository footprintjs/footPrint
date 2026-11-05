/** Test-only named read-retention relation. No native execution or causal replay. */
export { rootArrayAuxiliaryProfile } from './readLawWitness/auxiliaryProfile.js';
export { readRetention124 } from './readLawWitness/index.js';
export { priorRetainedWindows } from './readLawWitness/priorWindows.js';
export { checkedPair, equalNativeTrace, nativeTraceComparison } from './readLawWitness/readPair.js';
export { delivered as fixtureValue, projectSite } from './readLawWitness/retained.js';
export { ownsFinalSlot, stageReads } from './readLawWitness/retentionOwner.js';
export type { JoinedRun, OperationRead, ReadPair, Relation, RetainedSite } from './readLawWitness/types.js';
export type { Segment } from './readLawWitness/types.js';
export { equal, refuse, Unproven124 } from './readLawWitness/types.js';
