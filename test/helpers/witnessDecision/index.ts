import type { AuxiliaryEvidence } from '../auxiliaryFacts.js';
import type {
  ContinuationFact,
  NativeTraceComparison,
  PropagationFact,
  RetainedReadWindow,
} from '../nativeTraceFacts.js';
export interface Row {
  readonly bytes: string;
  readonly foldsBack: boolean;
  readonly nativeId?: number;
}
export type Coordinate =
  | {
      readonly kind: 'native-commit';
      readonly leg: string;
      readonly id: number;
      readonly frame?: number;
      readonly buffer?: number;
      readonly epoch?: number;
      readonly stageId?: string;
      readonly runtimeStageId?: string;
    }
  | { readonly kind: 'fixture-operation'; readonly at: readonly (string | number)[] }
  | { readonly kind: 'not-collected' };
export type Decision =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'cause';
      readonly name: 'admitted-record-9.30' | 'read-after-delete-124';
      readonly shape: 'first-commit';
      readonly nativeTrace?: NativeTraceComparison;
      readonly continuation?: readonly ContinuationFact[];
      readonly propagation?: readonly PropagationFact[];
      readonly readOperation?: readonly (string | number)[];
      readonly writeOperation?: readonly (string | number)[];
      readonly retainedReadWindows?: readonly RetainedReadWindow[];
      readonly also?: { readonly cause: 'admitted-record-9.30'; readonly commit: number };
      readonly commit: number;
      readonly coordinate: Coordinate;
    }
  | {
      readonly kind: 'cause';
      readonly name: 'read-after-delete-124';
      readonly shape: 'retained-only';
      readonly nativeTrace?: NativeTraceComparison;
      readonly coordinates: readonly (readonly (string | number)[])[];
      readonly auxiliary?: AuxiliaryEvidence;
    }
  | {
      readonly kind: 'broken';
      readonly code: 'build-fold-back' | 'commit-count' | 'coherent-commit-difference' | 'identical-commits';
      readonly index?: number;
      readonly detail?: string;
    };
export interface DecisionPorts {
  readonly differs: boolean;
  /** The EXISTING sameCommit closure, with its existing redaction-only law. */
  sameCommit(a: string | undefined, b: string | undefined): boolean;
  /** Actual native commit occurrence, else explicit not-collected for legacy hand-made rows. */
  coordinateOf?(side: 'baseline' | 'build', commit: number): Coordinate;
  firstReadCause?(first: number):
    | {
        kind: 'cause';
        name: 'read-after-delete-124';
        commit: number;
        coordinate: readonly (string | number)[];
        nativeTrace?: NativeTraceComparison;
        continuation?: readonly ContinuationFact[];
        propagation?: readonly PropagationFact[];
        readOperation?: readonly (string | number)[];
        writeOperation?: readonly (string | number)[];
        retainedReadWindows?: readonly RetainedReadWindow[];
      }
    | { kind: 'unproven'; reason: string };
  retainedReadCause?():
    | {
        kind: 'related';
        name: 'read-after-delete-124';
        coordinates: readonly (readonly (string | number)[])[];
        nativeTrace?: NativeTraceComparison;
        readonly auxiliary?: AuxiliaryEvidence;
      }
    | { kind: 'unproven'; reason: string };
}
/** One FIRST boundary, two named causes. Neither optional proof can bypass the build half. */
export function decideWitness(baseline: readonly Row[], build: readonly Row[], ports: DecisionPorts): Decision {
  const unadmitted = build.findIndex((row) => !row.foldsBack);
  if (unadmitted >= 0) return { kind: 'broken', code: 'build-fold-back', index: unadmitted };
  if (!ports.differs) return { kind: 'pass' };
  const n = Math.max(baseline.length, build.length);
  for (let i = 0; i < n; i++) {
    if (ports.sameCommit(baseline[i]?.bytes, build[i]?.bytes)) continue;
    if (baseline[i] === undefined || build[i] === undefined) return { kind: 'broken', code: 'commit-count', index: i };
    if (!baseline[i].foldsBack)
      return {
        kind: 'cause',
        name: 'admitted-record-9.30',
        shape: 'first-commit',
        commit: i,
        coordinate: ports.coordinateOf?.('baseline', i) ?? { kind: 'not-collected' },
      };
    const cause = ports.firstReadCause?.(i);
    if (
      cause?.kind === 'cause' &&
      cause.name === 'read-after-delete-124' &&
      cause.commit === i &&
      cause.coordinate.length
    )
      return {
        kind: 'cause',
        name: 'read-after-delete-124',
        shape: 'first-commit',
        commit: i,
        coordinate: { kind: 'fixture-operation', at: cause.coordinate },
        ...(cause.nativeTrace === undefined ? {} : { nativeTrace: cause.nativeTrace }),
        ...(cause.continuation === undefined ? {} : { continuation: cause.continuation }),
        ...(cause.propagation === undefined ? {} : { propagation: cause.propagation }),
        ...(cause.readOperation === undefined ? {} : { readOperation: cause.readOperation }),
        ...(cause.writeOperation === undefined ? {} : { writeOperation: cause.writeOperation }),
        ...(cause.retainedReadWindows === undefined ? {} : { retainedReadWindows: cause.retainedReadWindows }),
        ...historicalEvidence(baseline, build, i),
      };
    return {
      kind: 'broken',
      code: 'coherent-commit-difference',
      index: i,
      ...(cause?.kind === 'unproven' && { detail: cause.reason }),
    };
  }
  const retained = ports.retainedReadCause?.();
  if (retained?.kind === 'related' && retained.name === 'read-after-delete-124' && retained.coordinates.length)
    return {
      kind: 'cause',
      name: 'read-after-delete-124',
      shape: 'retained-only',
      coordinates: retained.coordinates,
      ...(retained.nativeTrace === undefined ? {} : { nativeTrace: retained.nativeTrace }),
      ...(retained.auxiliary === undefined ? {} : { auxiliary: retained.auxiliary }),
    };
  return {
    kind: 'broken',
    code: 'identical-commits',
    ...(retained?.kind === 'unproven' && { detail: retained.reason }),
  };
}
/** Baseline-only old9.30 evidence, separate from the already proved FIRST cause. */
function historicalEvidence(baseline: readonly Row[], build: readonly Row[], first: number) {
  const commit = baseline.findIndex((row) => !row.foldsBack);
  return commit > first && build[commit]?.foldsBack ? { also: { cause: 'admitted-record-9.30' as const, commit } } : {};
}
/** A listed historical change must still exhibit its original fold-back failure. */
export function hasAdmittedRecordEvidence(
  decision: Decision,
  baseline: readonly Row[],
  build: readonly Row[],
): boolean {
  if (decision.kind !== 'cause' || decision.shape !== 'first-commit' || build.some((row) => !row.foldsBack))
    return false;
  const firstFailure = baseline.findIndex((row) => !row.foldsBack);
  if (firstFailure < 0 || !build[firstFailure]?.foldsBack) return false;
  if (decision.name === 'admitted-record-9.30') return decision.commit === firstFailure;
  return (
    decision.coordinate.kind === 'fixture-operation' &&
    decision.coordinate.at.length > 0 &&
    decision.also?.cause === 'admitted-record-9.30' &&
    decision.also.commit === firstFailure &&
    firstFailure > decision.commit
  );
}
/** Original public-to-tests diagnostic strings, byte for byte; named decisions travel beside them as data. */
export function formatWitnessDecision(decision: Decision): string {
  if (decision.kind !== 'broken') return '';
  switch (decision.code) {
    case 'build-fold-back':
      return `the build's commit ${decision.index} does not fold back to what its stage read`;
    case 'commit-count':
      return `the engines made a different number of commits (${decision.index})`;
    case 'coherent-commit-difference':
      return `commit ${decision.index} differs, but 9.28.0's bundle there folded back`;
    case 'identical-commits':
      return 'the runs differ but every commit is byte-identical';
  }
}
