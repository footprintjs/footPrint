import type { NativeFact, Receipt, ValueFact } from '../../../readWitness.js';
import type { BranchReceipt } from '../../types.js';

export type Op = Readonly<{ t: string; k: string; k2?: string; p?: string; v?: unknown; i?: number }>;
export type Write = {
  method: 'setObject' | 'updateObject';
  key: string;
  value: ValueFact;
  identity: 'same-read' | 'fresh' | 'none';
  embeddedRead?: { from: readonly string[]; to: readonly string[] };
  copiedRead?: readonly { from: readonly string[]; to: readonly string[] }[];
  literal?: { at: readonly string[]; value: ValueFact };
};
export type Bound = { branch: BranchReceipt; read: NativeFact; native?: Receipt };
export type Row = readonly [string, boolean, ValueFact];
