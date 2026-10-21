import type { CommitBundle, StoredLog } from 'foottrace';

import { validateAbsentEntries } from '../capture/absentEntries.js';
import { copyHistoryData, historyDigest } from '../capture/historyData.js';
import { historyNote } from '../capture/historyNote.js';
import { copyHistoryReceipt, copyHistoryTarget } from '../capture/historyTarget.js';
import type { CaptureHistoryReceipt, CaptureHistoryTarget } from '../capture/historyTypes.js';
import { CAPTURE_HISTORY_NOTE, CAPTURE_RECEIPT_NOTE } from '../capture/historyTypes.js';
import type { NativeCaptureNote } from '../capture/nativeCoverage.js';
import { ownData } from '../capture/noteShape.js';
import type { StageSnapshot } from '../memory/frameTypes.js';
import type { RecorderSnapshot } from './ExecutionRuntime.js';
import type { StoredCaptureResult } from './readStoredCapture.js';

type Pair = {
  payload: Record<string, unknown>;
  target: CaptureHistoryTarget;
  receipt: CaptureHistoryReceipt;
  basis: { commitLog: readonly CommitBundle[]; initialState?: Record<string, unknown> };
};

/** One exact pair only; nothing here interprets commits, causal links or business values. */
function capturePair(log: StoredLog, runId: string, maxBytes: number): Pair | string {
  const evidence = log.notes.filter((n) => n.kind === CAPTURE_HISTORY_NOTE);
  const receipts = log.notes.filter((n) => n.kind === CAPTURE_RECEIPT_NOTE);
  if (!receipts.length) return 'receipt-missing';
  if (evidence.length !== 1 || receipts.length !== 1) return 'history-ambiguous';
  const payload = copyHistoryData(evidence[0]!.data, maxBytes) as Record<string, unknown>;
  const target = copyHistoryTarget(payload.target);
  if (
    !target ||
    target.runId !== runId ||
    target.logAddress.logRunId !== runId ||
    target.commits.from !== 0 ||
    target.commits.to !== log.commitLog.length
  )
    return 'scope-mismatch';
  const receipt = copyHistoryReceipt(receipts[0]!.data, target);
  if (!receipt) return 'receipt-refused';
  const basis = copyHistoryData(
    { commitLog: log.commitLog, ...(log.initialState !== undefined && { initialState: log.initialState }) },
    maxBytes,
  ) as Pair['basis'];
  return { payload, target, receipt, basis };
}

function captureEnding(log: StoredLog, capture: NativeCaptureNote, target: CaptureHistoryTarget): string | undefined {
  const expected =
    capture.boundary.status === 'completed' ? 'ok' : capture.boundary.status === 'paused' ? 'paused' : 'failed';
  if (expected !== log.outcome) return 'boundary-mismatch';
  let close = -1;
  let closes = 0;
  log.entries.forEach((e, index) => {
    if (e.kind === 'closed') {
      close = index;
      closes++;
    }
  });
  const observation = log.entries.findIndex((e) => e.kind === 'note' && e.note === CAPTURE_HISTORY_NOTE);
  const acknowledgement = log.entries.findIndex((e) => e.kind === 'note' && e.note === CAPTURE_RECEIPT_NOTE);
  if (close < 0 || observation <= close || acknowledgement <= observation) return 'sequence-mismatch';
  if (
    closes !== 1 ||
    ownData(log.meta.closed, 'runId') !== target.runId ||
    ownData(log.meta.opened, 'runId') !== target.runId
  )
    return 'boundary-mismatch';
  return undefined;
}

function captureEvidence(payload: Record<string, unknown>, capture: NativeCaptureNote): string | undefined {
  if (!payload.executionTree || typeof payload.executionTree !== 'object' || Array.isArray(payload.executionTree))
    return 'evidence-missing';
  if (
    capture.channels.control === 'captured' &&
    (!Array.isArray(payload.recorders) ||
      !payload.recorders.some((r) => r?.capture?.runId === capture.runId && r.capture.control === 'captured'))
  )
    return 'recorder-evidence-missing';
  return undefined;
}

/** @internal Engine-metadata admission after Foottrace's generic record validation. */
export async function admitStoredCapture(
  log: StoredLog,
  runId: string,
  maxBytes: number,
): Promise<StoredCaptureResult> {
  const unknown = (reason: string): StoredCaptureResult => ({ status: 'unknown', reason });
  const pair = capturePair(log, runId, maxBytes);
  if (typeof pair === 'string') return unknown(pair);
  const { payload, target, receipt, basis } = pair;
  const body = {
    capture: payload.capture,
    executionTree: payload.executionTree,
    ...(payload.recorders !== undefined && { recorders: payload.recorders }),
    ...(payload.absent !== undefined && { absent: payload.absent }),
  };
  if ((await historyDigest({ evidence: body, record: basis })) !== target.digest) return unknown('evidence-mismatch');
  if (!validateAbsentEntries(payload)) return unknown('absent-evidence-refused');
  const capture = historyNote(payload.capture, target);
  if (!capture || capture.limitations.includes('resumed-segment')) return unknown('capture-refused');
  const refusal = captureEnding(log, capture, target) ?? captureEvidence(payload, capture);
  if (refusal) return unknown(refusal);
  return Object.freeze({
    status: 'acknowledged',
    history: Object.freeze({
      runId,
      capture,
      executionTree: payload.executionTree as StageSnapshot,
      ...(payload.absent !== undefined ? { absent: payload.absent as readonly (readonly string[])[] } : {}),
      ...(payload.recorders !== undefined ? { recorders: payload.recorders as RecorderSnapshot[] } : {}),
      commitLog: basis.commitLog,
      ...(basis.initialState && { initialState: basis.initialState }),
      receipt,
    }),
  });
}
