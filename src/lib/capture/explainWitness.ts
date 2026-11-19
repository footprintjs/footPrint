import type { LogAddress } from 'foottrace';

import type { NativeCapture, NativeCaptureNote } from './nativeCoverage.js';

export interface ExplainCaptureWitness {
  readonly logAddress: LogAddress;
  readonly runId: string;
  readonly commits: { readonly from: number; readonly to: number };
  readonly boundary: NativeCaptureNote['boundary']['status'];
  readonly source: 'live';
}

let witnesses: WeakMap<object, ExplainCaptureWitness> | undefined;

/**
 * Get the native witness for an exact served snapshot or mounted subflow's
 * `treeContext`. The engine associates this evidence with the live record.
 * Copies and saved records do not carry that association.
 */
export function captureWitnessOf(record: object): ExplainCaptureWitness | undefined {
  return witnesses?.get(record);
}

/** Bind the engine's own capture facts to the object that serves this log. */
export function rememberCaptureWitness(
  record: { readonly logAddress?: LogAddress },
  capture: NativeCapture | undefined,
  to: number,
): void {
  const address = record.logAddress;
  if (!capture?.explanation || !address) return;
  (witnesses ??= new WeakMap()).set(
    record,
    Object.freeze({
      logAddress: Object.freeze({ logRunId: address.logRunId, drillPath: Object.freeze([...address.drillPath]) }),
      runId: capture.runId,
      commits: Object.freeze({ from: capture.from, to }),
      boundary: capture.boundaryStatus,
      source: 'live',
    }),
  );
}

/** A redacted view of the same log can carry its existing admitted witness. */
export function shareCaptureWitness(source: object, served: object): void {
  if (!witnesses) return;
  const witness = witnesses.get(source);
  if (witness) witnesses.set(served, witness);
}
