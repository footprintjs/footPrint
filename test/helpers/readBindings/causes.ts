import type { BranchReceipt, Cause, CommitObservation, FixtureCall } from '../firstCommit124.js';
import type { Coordinate } from '../witnessDecision.js';
import type { ObservedKept, QualifiedPair } from './types.js';

export function commitCoordinate(run: ObservedKept, index: number): Coordinate {
  const id = run.commits[index]?.nativeId;
  const row = id === undefined ? undefined : run.native.events.find((event) => event.id === id);
  if (!row || row.tier !== 'buffer-call' || row.method !== 'commit') return { kind: 'not-collected' };
  return {
    kind: 'native-commit',
    leg: row.leg,
    id: row.id,
    ...(row.frame === undefined ? {} : { frame: row.frame }),
    ...(row.buffer === undefined ? {} : { buffer: row.buffer }),
    ...(row.epoch === undefined ? {} : { epoch: row.epoch }),
    ...(row.header === undefined ? {} : { stageId: row.header.stageId, runtimeStageId: row.header.runtimeStageId }),
  };
}
/** Metadata assembly only: the closed branch + FIRST/producer checks still must validate this Cause. */
export function causeAtFirstCommit(
  a: ObservedKept,
  b: ObservedKept,
  pair: QualifiedPair,
  first: number,
): { kind: 'candidate'; cause: Cause } | { kind: 'unproven'; reason: string } {
  try {
    if (!Number.isSafeInteger(first) || first < 0 || !a.commits[first] || !b.commits[first])
      throw new Error('Missing actual first commit.');
    const initial = Array.from({ length: Math.max(a.commits.length, b.commits.length) }, (_, index) => index).find(
      (index) => a.commits[index]?.bytes !== b.commits[index]?.bytes,
    );
    if (initial !== first) throw new Error('Requested cause is not the first raw differing commit.');
    const commit = (run: ObservedKept): CommitObservation => {
      const id = run.commits[first].nativeId;
      if (id === undefined) throw new Error('Witnessed commit has no actual receiver join.');
      const row = run.native.events.find((event) => event.id === id);
      if (!row || row.method !== 'commit' || row.tier !== 'buffer-call' || row.outcome !== 'returned' || !row.encoder)
        throw new Error('Actual commit/inner producer observation is missing.');
      return row as CommitObservation;
    };
    const branch = (side: 'baseline' | 'build'): BranchReceipt => {
      const span = side === 'baseline' ? pair.baselineSpan : pair.buildSpan;
      const calls = side === 'baseline' ? pair.baselineCalls : pair.buildCalls;
      if (
        !span.path ||
        span.path.some((segment) => typeof segment !== 'string') ||
        calls.some((call) => !call.call || call.operation === undefined)
      )
        throw new Error('Unjoined actual branch metadata.');
      return {
        operation: pair.pair[side],
        programPath: span.programPath,
        path: span.path,
        calls: calls as readonly FixtureCall[],
        edits: span.edits,
      };
    };
    return {
      kind: 'candidate',
      cause: {
        pair: pair.pair,
        baseline: branch('baseline'),
        build: branch('build'),
        baselineCommit: commit(a),
        buildCommit: commit(b),
      },
    };
  } catch (error) {
    return { kind: 'unproven', reason: error instanceof Error ? error.message : 'Unreadable actual cause metadata.' };
  }
}
