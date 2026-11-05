/** Import-free metadata describing the actual native comparison domain. */
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
