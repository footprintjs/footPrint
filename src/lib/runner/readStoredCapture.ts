import type { CommitBundle, StoredRecordLimits } from 'foottrace';
import { readStoredRecord } from 'foottrace';

import { copyHistoryData, HistoryDataError } from '../capture/historyData.js';
import type { CaptureHistoryReceipt } from '../capture/historyTypes.js';
import type { NativeCaptureNote } from '../capture/nativeCoverage.js';
import type { StageSnapshot } from '../memory/frameTypes.js';
import type { RecorderSnapshot } from './ExecutionRuntime.js';
import { admitStoredCapture } from './storedCaptureAdmission.js';

/** Engine history whose storage evidence matched. Channels and native limitations retain their original meanings. */
export interface StoredCaptureHistory {
  readonly runId: string;
  readonly capture: NativeCaptureNote;
  readonly executionTree: StageSnapshot;
  readonly recorders?: readonly RecorderSnapshot[];
  readonly commitLog: readonly CommitBundle[];
  readonly initialState?: Record<string, unknown>;
  readonly receipt: CaptureHistoryReceipt;
}
export type StoredCaptureResult =
  | { readonly status: 'acknowledged'; readonly history: StoredCaptureHistory }
  | { readonly status: 'unknown'; readonly reason: string; readonly history?: never };

/** Only inert bounded data reaches the generic record reader. The outer iterable remains host-owned. */
function* inertEntries(entries: Iterable<unknown>, maxBytes: number): Iterable<unknown> {
  let remaining = maxBytes * 4;
  for (const entry of entries) {
    const copied = copyHistoryData(entry, remaining);
    remaining -= new TextEncoder().encode(JSON.stringify(copied)).length;
    yield copied;
  }
}

/**
 * Read authorized stored entries using Foottrace's sequence/gap checks, then validate FootPrint's opaque metadata.
 * A receipt is a host-adapter assertion, not a signature. Callers still own storage authorization and trust.
 * Never performs causal analysis or upgrades partial native capture to complete.
 */
export async function readStoredCapture(
  entries: Iterable<unknown>,
  options: { runId: string; limits?: StoredRecordLimits; maxBytes?: number },
): Promise<StoredCaptureResult> {
  const unknown = (reason: string): StoredCaptureResult => ({ status: 'unknown', reason });
  try {
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) return unknown('reader-limit');
    const stored = readStoredRecord(inertEntries(entries, maxBytes), options.limits);
    const log = stored.root(options.runId);
    if (!log) return unknown('root-missing');
    if (!log.complete || log.gaps.length || stored.unread.length) return unknown('history-incomplete');
    return await admitStoredCapture(log, options.runId, maxBytes);
  } catch (error) {
    return unknown(
      error instanceof HistoryDataError && error.code === 'too-large' ? 'history-too-large' : 'history-refused',
    );
  }
}
