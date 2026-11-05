import type { Cause, FirstCommitResult } from '../firstCommit124.js';
import {
  type BasicFamily,
  type ObservedKept,
  bindRetainedPairs,
  causeAtFirstCommit,
  commitCoordinate,
  pairObservedReads,
} from '../readBindings.js';
import { readRetention124 } from '../readLawWitness.js';
import type { DecisionPorts } from '../witnessDecision.js';
/** This must include common FIRST/native-origin/prefix checks, not just declared branch shape acceptance. */
export type ClosedFirstCause = (
  a: ObservedKept,
  b: ObservedKept,
  cause: Cause,
  family: BasicFamily,
) => FirstCommitResult;
export function readLawPorts(
  a: ObservedKept,
  b: ObservedKept,
  family: BasicFamily,
  closedFirstCause: ClosedFirstCause,
): Pick<DecisionPorts, 'coordinateOf' | 'firstReadCause' | 'retainedReadCause'> {
  let paired: ReturnType<typeof pairObservedReads> | undefined;
  const bindings = () => (paired ??= pairObservedReads(a, b));
  return {
    coordinateOf: (side, index) => commitCoordinate(side === 'baseline' ? a : b, index),
    firstReadCause(first) {
      const proof = bindings();
      if (proof.kind === 'unproven') return proof;
      const accepted: Extract<FirstCommitResult, { kind: 'cause' }>[] = [];
      let last = 'No native-bound deleted-read branch proves the first changed commit.';
      for (const read of proof.reads) {
        const candidate = causeAtFirstCommit(a, b, read, first);
        if (candidate.kind === 'unproven') {
          last = candidate.reason;
          continue;
        }
        const earlier = proof.reads.filter(
          (row) =>
            row.baselineRead.frame !== candidate.cause.pair.baseline.frame &&
            row.buildRead.frame !== candidate.cause.pair.build.frame &&
            row.baselineSpan.end < candidate.cause.baseline.operation.start &&
            row.buildSpan.end < candidate.cause.build.operation.start,
        );
        const retained = bindRetainedPairs(a, b, family, earlier);
        if (retained.kind === 'unproven') {
          last = retained.reason;
          continue;
        }
        const cause = closedFirstCause(a, b, { ...candidate.cause, priorRetainedPairs: retained.pairs }, family);
        if (cause.kind === 'cause') accepted.push(cause);
        else last = cause.reason;
      }
      if (accepted.length === 1 && accepted[0].commit === first) return accepted[0];
      return { kind: 'unproven', reason: accepted.length > 1 ? 'Ambiguous first native-read cause.' : last };
    },
    retainedReadCause() {
      const proof = bindings();
      if (proof.kind === 'unproven') return proof;
      const retained = bindRetainedPairs(a, b, family, proof.reads);
      return retained.kind === 'unproven' ? retained : readRetention124(a, b, retained.pairs);
    },
  };
}
