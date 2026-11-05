/** Test-only named read-retention relation. No native execution or causal replay. */
export { readRetention124 } from './readLawWitness/index.js';
export { checkedPair, equalNativeTrace } from './readLawWitness/readPair.js';
export { projectSite } from './readLawWitness/retained.js';
export type { JoinedRun, OperationRead, ReadPair, Relation, RetainedSite } from './readLawWitness/types.js';
export type { Segment } from './readLawWitness/types.js';
export { equal, refuse, Unproven124 } from './readLawWitness/types.js';
