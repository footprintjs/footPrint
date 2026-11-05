import type { ContinuationFact, NativeTraceComparison } from '../nativeTraceFacts.js';
import type { checkedPair, JoinedRun, OperationRead, ReadPair, Segment } from '../readLawWitness.js';
import type { FixtureEdit, IdentityGraph, NativeFact, ValueFact } from '../readWitness.js';
export type FixtureFamily = 'writeback' | 'chart' | 'nested';
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
  readonly programPath: readonly Segment[];
  readonly path: readonly string[];
  readonly calls: readonly FixtureCall[];
  readonly edits: readonly FixtureEdit[];
}
export interface CommitObservation extends NativeFact {
  readonly method: 'commit';
  readonly encoder: {
    readonly method: 'toChangeOnlyPayload' | 'toDeltaPayload';
    readonly start: number;
    readonly end: number;
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
      readonly nativeTrace: NativeTraceComparison;
      readonly continuation?: readonly ContinuationFact[];
    }
  | { readonly kind: 'unproven'; readonly reason: string };
export interface Context {
  readonly a: JoinedRun;
  readonly b: JoinedRun;
  readonly cause: Cause;
  readonly index: number;
  readonly family: FixtureFamily;
  readonly op: Readonly<Record<string, unknown>>;
  readonly reads: ReturnType<typeof checkedPair>;
}
/** Actual StageContext rows only. Common guard still joins every row to one real staged producer. */
export interface BranchPlan {
  readonly kind: 'declared-branches';
  readonly strategy: 'writeback-del-readback' | 'chart';
  readonly baselineWrites: readonly FixtureCall[];
  readonly buildWrites: readonly FixtureCall[];
}
