import type { AuxiliaryEvidence } from '../auxiliaryFacts.js';
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
      readonly commit: number;
      readonly coordinate: Coordinate;
    }
  | {
      readonly kind: 'cause';
      readonly name: 'read-after-delete-124';
      readonly shape: 'retained-only';
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
  firstReadCause?(
    first: number,
  ):
    | { kind: 'cause'; name: 'read-after-delete-124'; commit: number; coordinate: readonly (string | number)[] }
    | { kind: 'unproven'; reason: string };
  retainedReadCause?():
    | {
        kind: 'related';
        name: 'read-after-delete-124';
        coordinates: readonly (readonly (string | number)[])[];
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
      ...(retained.auxiliary === undefined ? {} : { auxiliary: retained.auxiliary }),
    };
  return {
    kind: 'broken',
    code: 'identical-commits',
    ...(retained?.kind === 'unproven' && { detail: retained.reason }),
  };
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
