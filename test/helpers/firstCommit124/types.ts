import type { FixtureEdit, IdentityGraph, NativeFact, ValueFact } from '../readWitness.js';
export type { FixtureEdit } from '../readWitness.js';
import type { JoinedRun, OperationRead, ReadPair, Segment } from '../readLawWitness.js';

/** Extra observations from the SAME installed adapter, never manufactured by the comparator. */
export interface FixtureCall extends NativeFact {
  readonly operation: readonly Segment[];
  readonly call: {
    readonly args: readonly ValueFact[];
    readonly objects: readonly (number | undefined)[];
    readonly identities?: readonly IdentityGraph[];
  };
}
export interface BranchReceipt {
  readonly operation: OperationRead;
  /** JSON pointer to the actual untouched operation in JoinedRun.program. */
  readonly programPath: readonly Segment[];
  /** The path array ALREADY selected by the existing fixture's WB_PATHS[o.path]. */
  readonly path: readonly string[];
  readonly calls: readonly FixtureCall[];
  readonly edits: readonly FixtureEdit[];
}
/** Captured below the mutable commit wrapper, from native encoder return(s) AFTER native admit. */
export interface CommitObservation extends NativeFact {
  readonly method: 'commit';
  readonly encoder: {
    readonly method: 'toChangeOnlyPayload' | 'toDeltaPayload';
    readonly start: number;
    readonly end: number;
    /** Existing witness-payload serialization of the actual encoder output + actual surviving redacted paths. */
    readonly bytes: string;
    readonly mode: 'full' | 'delta';
  };
}
export interface Cause {
  readonly pair: ReadPair;
  readonly baseline: BranchReceipt;
  readonly build: BranchReceipt;
  readonly baselineCommit: CommitObservation;
  readonly buildCommit: CommitObservation;
}
export type FirstCommitResult =
  | {
      readonly kind: 'cause';
      readonly name: 'read-after-delete-124';
      readonly commit: number;
      readonly coordinate: readonly Segment[];
    }
  | { readonly kind: 'unproven'; readonly reason: string };
export type Run = JoinedRun;
