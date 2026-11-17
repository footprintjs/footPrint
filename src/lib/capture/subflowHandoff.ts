/** Value-free native boundary observations. These are not storage or semantic receipts. */
import type { LogAddress } from 'foottrace';

export interface InputHandoff {
  readonly version: 1;
  readonly attribution: 'observed-read-prefix';
  readonly parent: { readonly address: LogAddress; readonly beforeCommitIdx: number };
  readonly child: { readonly address: LogAddress; readonly runtimeStageId: string; readonly commitIdx: number };
  readonly writes: readonly { readonly path: string; readonly reads: readonly string[] }[];
  readonly status: 'captured' | 'partial';
  readonly limitations: readonly InputLimitation[];
}
export type InputLimitation =
  | 'privacy-active'
  | 'budget-exhausted'
  | 'parent-log-advanced'
  | 'resume-seed'
  | 'commit-time-read'
  | 'selector-reads-unavailable';
export interface FanoutCollection {
  readonly version: 1;
  readonly attribution: 'observed-scope-collection';
  readonly parent: {
    readonly address: LogAddress;
    readonly runtimeStageId: string;
    readonly commitIdx: number;
    readonly path: string;
  };
  readonly totalItems: number;
  readonly branchCount: number;
  readonly slots: readonly FanoutSlot[];
  readonly status: 'captured' | 'partial';
  readonly limitations: readonly FanoutLimitation[];
}
export interface FanoutSlot {
  readonly index: number;
  readonly child: { readonly address: LogAddress; readonly beforeCommitIdx: number };
  readonly observation: 'scope-snapshot' | 'explicit-output' | 'failed-slot';
}
export type FanoutLimitation =
  | 'privacy-active'
  | 'budget-exhausted'
  | 'branches-truncated'
  | 'missing-child-record'
  | 'explicit-output'
  | 'failed-slot';
export interface FanoutCollections {
  readonly version: 1;
  readonly status: 'captured' | 'partial';
  readonly collections: readonly FanoutCollection[];
}
/** The optional channel's retained fields; the rest of a native result stays opaque to this leaf. */
export interface CaptureResult {
  readonly inputHandoff?: InputHandoff;
  readonly treeContext: { readonly fanoutCollections?: FanoutCollections };
}
/** Project only this optional protocol's fields, retaining identity when it supplied none. */
export function privateCaptureResult<T extends CaptureResult>(result: T): T {
  const input = result.inputHandoff;
  const collections = result.treeContext.fanoutCollections;
  if (input === undefined && collections === undefined) return result;
  return {
    ...result,
    ...(input && { inputHandoff: privateInput(input) }),
    treeContext: {
      ...result.treeContext,
      ...(collections && { fanoutCollections: privateCollections(collections) }),
    },
  };
}
/** Copy address components; a later caller cannot retarget retained metadata. */
export function frozenLogAddress(address: LogAddress): LogAddress {
  return Object.freeze({ logRunId: address.logRunId, drillPath: Object.freeze([...address.drillPath]) });
}
/** Explicit safe serving: reference channels are withheld even without a configured policy. */
export function privateInput(handoff: InputHandoff): InputHandoff {
  return Object.freeze({
    ...handoff,
    status: 'partial',
    limitations: Object.freeze([...new Set([...handoff.limitations, 'privacy-active' as const])]),
    writes: Object.freeze(handoff.writes.map((write) => Object.freeze({ path: write.path, reads: Object.freeze([]) }))),
  });
}
export function privateCollections(view: FanoutCollections): FanoutCollections {
  return Object.freeze({
    version: 1,
    status: 'partial',
    collections: Object.freeze(
      view.collections.map((collection) =>
        Object.freeze({
          ...collection,
          status: 'partial' as const,
          slots: Object.freeze([]),
          limitations: Object.freeze([...new Set([...collection.limitations, 'privacy-active' as const])]),
        }),
      ),
    ),
  });
}

/** UTF-8 bytes, including replacement encoding of lone surrogates, without allocating a byte array. */
export function referenceBytes(name: string): number {
  let bytes = 0;
  for (const char of name) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Existing output-v1 structural shape; unchanged observation semantics. */
export interface OutputHandoffRecord {
  readonly version: 1;
  readonly attribution: 'observed-read-prefix';
  readonly parent: {
    readonly address: LogAddress;
    readonly runtimeStageId: string;
    readonly commitIdx: number;
  };
  readonly child: { readonly address: LogAddress; readonly beforeCommitIdx: number };
  readonly writes: readonly { readonly path: string; readonly reads: readonly string[] }[];
  readonly status: 'captured' | 'partial';
  readonly limitations: readonly (
    | 'explicit-output'
    | 'privacy-active'
    | 'budget-exhausted'
    | 'output-mutated'
    | 'commit-time-read'
  )[];
}
