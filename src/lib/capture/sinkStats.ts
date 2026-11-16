import type { CaptureHistoryStatus } from './historyTypes.js';

/** `getSnapshot().sink` — what the run handed its sink, and what the sink did not take (10.1, P6). */
export interface RecordSinkStats {
  /** Present only when explicit capture persistence was requested. Never inferred from an ordinary flush. */
  readonly capture?: CaptureHistoryStatus;
  /** Entries handed to the adapter (each `opened`, `commit`, `note`, `closed` call). */
  readonly entries: number;
  /**
   * Losses — a method that threw or rejected, an entry the log refused to send, a `meta` the log could not copy
   * (that entry was still stored, without it), and failed or timed-out flushes. A rejection that settles after the
   * run finished is counted when it settles.
   */
  readonly failed: number;
  /** The last loss's error, as text. Absent while nothing was lost. */
  readonly lastError?: string;
}
