import type { OriginProof } from './commitOrigin.js';
import type { IdentityGraph } from './identityGraph.js';

export type Segment = string | number;
export type Method = (this: object, ...args: any[]) => any;
export type ValueFact = Readonly<{ kind: string; value?: unknown; entries?: readonly unknown[]; ref?: number }>;
export interface Hooks {
  StageContext: { prototype: object };
  TransactionBuffer: { prototype: object };
}
export interface Header {
  readonly stageId: string;
  readonly runId: string;
  readonly runtimeStageId?: string;
}
export interface NativeFact {
  readonly tier?: 'stage-call' | 'buffer-call';
  readonly operation?: readonly Segment[];
  readonly call?: {
    readonly args: readonly ValueFact[];
    readonly objects: readonly (number | undefined)[];
    readonly identities?: readonly IdentityGraph[];
  };
  readonly retention?: {
    readonly nativeId: number;
    readonly frame: number;
    readonly key: string;
    readonly value: ValueFact;
    readonly eligibility: {
      readonly layout: 'baseline-own-readTracking' | 'build-own-policy';
      readonly mode: 'full' | 'summary';
    };
  };
  readonly valueObject?: number;
  readonly encoder?: OriginProof;
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly leg: string;
  readonly method: string;
  readonly outcome: 'returned' | 'threw';
  readonly frame?: number;
  readonly header?: Header;
  readonly phase?: 'read' | 'write' | 'commit';
  readonly buffer?: number;
  readonly epoch?: number;
  readonly address?: readonly Segment[];
  readonly value?: ValueFact;
  readonly result?: ValueFact;
  readonly resultObject?: number;
  readonly resultIdentities?: IdentityGraph;
  readonly base?: Readonly<{ found: boolean; value: ValueFact; object?: number }>;
  readonly gets?: readonly number[];
}
export interface Receipt {
  readonly leg: string;
  readonly events: readonly NativeFact[];
  readonly issues: readonly string[];
}
