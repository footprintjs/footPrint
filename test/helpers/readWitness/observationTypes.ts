/** Test-only native facts. No fixture program, retained record, heap or value model. */
export type Segment = string | number;
export type Method = (this: object, ...args: unknown[]) => unknown;
export interface Hooks {
  readonly StageContext: { readonly prototype: object };
  readonly TransactionBuffer: { readonly prototype: object };
}
export interface Header {
  readonly stageId: string;
  readonly runId: string;
  readonly runtimeStageId?: string;
}
export type Definedness = Readonly<{ kind: 'undefined' | 'defined' }>;
export interface NativeFact {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly leg: string;
  readonly tier: 'stage-call' | 'buffer-call';
  readonly method: string;
  readonly outcome: 'returned' | 'threw';
  readonly phase?: 'read' | 'write' | 'commit';
  readonly frame?: number;
  readonly header?: Header;
  readonly buffer?: number;
  readonly epoch?: number;
  readonly address?: readonly Segment[];
  readonly value?: Definedness;
  readonly result?: Definedness;
  readonly gets?: readonly number[];
}
export interface Receipt {
  readonly leg: string;
  readonly events: readonly NativeFact[];
  readonly issues: readonly string[];
}
export interface DeletedReadInput {
  readonly read: NativeFact;
  readonly get: NativeFact;
  readonly deletedBy: NativeFact;
}
/** A read the stage's buffer could not answer, and the last hard write of the stage that owns its path. */
export interface HardWrittenReadInput {
  readonly read: NativeFact;
  readonly get: NativeFact;
  readonly writtenBy: NativeFact;
}
