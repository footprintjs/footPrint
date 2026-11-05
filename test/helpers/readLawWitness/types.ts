import type { NativeFact, Receipt, ValueFact } from '../readWitness.js';

export type Segment = string | number;
/** Created by the actual interpreter boundary, not reconstructed from its opcode. */
export interface OperationRead {
  readonly coordinate: readonly Segment[];
  readonly frame: number;
  readonly start: number;
  readonly end: number;
  readonly nativeId: number;
  /** Actual returned native-read ordinal within this observed operation, when constructed by the driver. */
  readonly occurrence?: number;
}
/** Eligible immediate own-data retention captured by the SAME native observer. */
export type RetentionFact = NonNullable<NativeFact['retention']>;
export type RetainedSite =
  | { readonly kind: 'read-line'; readonly line: number }
  | {
      readonly kind: 'stage-read';
      readonly field: 'executionTree' | 'snapshots' | 'subflowResults' | 'redactedSubflows' | `cp${number}.tree`;
      readonly line?: number;
      readonly treeRoot?: readonly string[];
      /** Only next / children[index] edges within this actual stage tree. */
      readonly nodePath: readonly Segment[];
      readonly baseline: RetentionFact;
      readonly build: RetentionFact;
    };
export interface ReadPair {
  readonly baseline: OperationRead;
  readonly build: OperationRead;
  readonly sites: readonly RetainedSite[];
}
export interface JoinedRun {
  readonly kept: Readonly<Record<string, string>>;
  readonly commits: readonly { readonly bytes: string; readonly foldsBack: boolean; readonly nativeId?: number }[];
  readonly native: Receipt;
  /** Exact bytes of the program actually applied, from the unchanged program object. */
  readonly program: string;
}
export type Relation =
  | {
      readonly kind: 'related';
      readonly name: 'read-after-delete-124';
      readonly coordinates: readonly (readonly Segment[])[];
    }
  | { readonly kind: 'unproven'; readonly reason: string };
export interface CheckedRead {
  readonly read: NativeFact;
  readonly get: NativeFact;
  readonly deletedBy: NativeFact;
}
export class Unproven124 extends Error {}
export const refuse = (message: string): never => {
  throw new Unproven124(message);
};
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
