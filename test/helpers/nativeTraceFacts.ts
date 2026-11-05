/** Import-free metadata describing the actual native comparison domain. */
/** Same cause's actually joined continuation. The explicit missing-value fact is JSON-stable. */
export interface ContinuationFact {
  readonly operation: readonly (string | number)[];
  readonly address: readonly (string | number)[];
  readonly baselineObjectId: number;
  readonly buildRead: { readonly kind: 'undefined' };
  readonly write: false; // BUILD no-write; baseline's SAME-object write is independently proved.
}
export interface NativeTraceComparison {
  readonly windows: readonly {
    readonly coordinate: readonly (string | number)[];
    readonly baseline: { readonly start: number; readonly end: number };
    readonly build: { readonly start: number; readonly end: number };
  }[];
  readonly crossEngineFields: 'semantic';
  readonly actorIdentity: 'record-level (r13 view)';
  readonly encoder: { readonly crossEngine: 'bytes'; readonly ownEngine: 'method↔mode↔outer' };
  readonly recordViews: readonly ['r13', 'c-f5-seed-policy-order'];
}
