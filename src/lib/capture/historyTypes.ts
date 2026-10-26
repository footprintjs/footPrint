import type { LogAddress } from 'foottrace';

/** Exact root segment and evidence entry acknowledged by a storage adapter. */
export interface CaptureHistoryTarget {
  readonly version: 1;
  readonly evidenceId: string;
  readonly runId: string;
  /** SHA-256 of the exact inert JSON evidence (including opted-in source metadata) plus canonical commit log and served starting state. */
  readonly digest: string;
  readonly logAddress: LogAddress;
  readonly commits: { readonly from: number; readonly to: number };
}

/** Adapter assertion about the preceding evidence and end entry, not about this receipt's delivery. */
export interface CaptureHistoryReceipt extends CaptureHistoryTarget {
  readonly durability: 'durable';
}

/** Explicit host-owned durability capability. A normal RecordSink.flush is not this promise. */
export interface CaptureHistoryOptions {
  /** Resolve only after this target's evidence, commits and end entry are durably stored together. */
  readonly acknowledge: (
    target: CaptureHistoryTarget,
    context: { readonly signal: AbortSignal },
  ) => Promise<CaptureHistoryReceipt>;
  /** Maximum UTF-8 bytes of the evidence payload and target. Default 1 MiB, maximum 8 MiB. */
  readonly maxBytes?: number;
  /** Total time allowed for evidence delivery, acknowledgement and receipt delivery. Default 10s, maximum 30s. */
  readonly timeoutMs?: number;
}

/** Persistence result only. An acknowledged failed/paused prefix is not a completed business workflow. */
export type CaptureHistoryStatus =
  | { readonly status: 'acknowledged' }
  | { readonly status: 'unknown'; readonly reason: string };

/** @internal Opaque note names; Foottrace keeps them without interpreting engine metadata. */
export const CAPTURE_HISTORY_NOTE = 'capture-history';
export const CAPTURE_RECEIPT_NOTE = 'capture-receipt';
