import type { Meta } from 'foottrace';

import { copyCaptureEvidence, validateAbsentEntries } from '../capture/absentEntries.js';
import { copyHistoryData, historyDigest, historyEvidence, historyFailureReason } from '../capture/historyData.js';
import { historyNote } from '../capture/historyNote.js';
import { copyHistoryReceipt, copyHistoryTarget } from '../capture/historyTarget.js';
import { CAPTURE_HISTORY_NOTE, CAPTURE_RECEIPT_NOTE } from '../capture/historyTypes.js';
import { storedReadSources } from '../capture/storedReadSources.js';
import { setLongTimeout } from '../timers/longTimeout.js';
import type { ExecutionRuntime, RuntimeSnapshot } from './ExecutionRuntime.js';
import type { RunRecord } from './recordSink.js';

/** @internal Keeps a timed-out operation leased until its actual settlement. */
export interface CaptureHistoryLease {
  pending: boolean;
}

/** Persist one terminal native root segment, without changing its memory-only engine observation. */
export async function persistCaptureHistory(
  runtime: ExecutionRuntime,
  record: RunRecord,
  snapshot: () => RuntimeSnapshot,
  lease: CaptureHistoryLease,
): Promise<void> {
  const options = record.captureOptions;
  if (!options) return;
  if (lease.pending) {
    record.captureResult({ status: 'unknown', reason: 'acknowledgement-pending' });
    return;
  }
  lease.pending = true;
  const controller = new AbortController();
  let active = true;
  let cancelTimer: () => void = () => undefined;
  const unknown = (reason: string) => record.captureResult({ status: 'unknown', reason });
  const work = async (): Promise<void> => {
    try {
      if (!runtime.capture || record.stats().failed > 0) return unknown('prior-delivery-failed');
      const view = snapshot();
      const note = view.capture;
      if (!note || note.boundary.status === 'running') return unknown('capture-unavailable');
      const payload = historyEvidence(
        copyCaptureEvidence(
          record.serve({
            capture: note,
            executionTree: view.executionTree,
            ...(view.recorders && { recorders: view.recorders }),
            ...(view.readSources && { readSources: view.readSources }),
          }),
          options.maxBytes ?? 1024 * 1024,
        ),
      ) as Meta;
      const basis = copyHistoryData(
        {
          commitLog: view.commitLog,
          ...(view.initialState !== undefined && { initialState: record.captureInitialState(view.initialState) }),
        },
        options.maxBytes ?? 1024 * 1024,
      );
      const target = copyHistoryTarget({
        version: 1,
        evidenceId: note.runId,
        runId: note.runId,
        digest: await historyDigest({ evidence: payload, record: basis }),
        logAddress: note.logAddress,
        commits: note.commits,
      });
      if (!active) return;
      if (!target) return unknown('capture-unavailable');
      const evidence = copyHistoryData(record.serve({ target, ...payload }), options.maxBytes ?? 1024 * 1024) as Meta;
      // A redaction rule may mask protocol fields too. Such a record is not eligible for acknowledgement.
      if (
        !validateAbsentEntries(evidence) ||
        !copyHistoryTarget(evidence.target) ||
        JSON.stringify(copyHistoryTarget(evidence.target)) !== JSON.stringify(target)
      )
        return unknown('evidence-refused');
      if (view.readSources) {
        // Preserve the version-1 producer stream, including historically masked protocol notes.
        const admittedNote = historyNote(evidence.capture, target);
        if (
          !admittedNote ||
          admittedNote.version !== 2 ||
          !storedReadSources(
            evidence.readSources,
            admittedNote,
            view.commitLog,
            (basis as { initialState?: Record<string, unknown> }).initialState,
            evidence.executionTree,
          )
        )
          return unknown('evidence-refused');
      }
      runtime.noteRecord(CAPTURE_HISTORY_NOTE, evidence);
      const delivered = await record.flush(options.timeoutMs ?? 10_000);
      if (!active) return;
      if (!delivered.done || record.pendingCaptureDeliveries || record.stats().failed > 0)
        return unknown('evidence-delivery-unknown');
      const receipt = copyHistoryReceipt(await options.acknowledge(target, { signal: controller.signal }), target);
      if (!active) return;
      if (!receipt) return unknown('acknowledgement-refused');
      const servedReceipt = record.serve({ ...receipt });
      if (!copyHistoryReceipt(servedReceipt, target)) return unknown('acknowledgement-refused');
      runtime.noteRecord(CAPTURE_RECEIPT_NOTE, servedReceipt);
      const persisted = await record.flush(options.timeoutMs ?? 10_000);
      if (!active) return;
      if (!persisted.done || record.pendingCaptureDeliveries || record.stats().failed > 0)
        return unknown('receipt-delivery-unknown');
      record.captureResult({ status: 'acknowledged' });
    } catch (error) {
      if (active) unknown(historyFailureReason(error, 'evidence'));
    }
  };
  try {
    await Promise.race([
      work().finally(() => {
        lease.pending = false;
      }),
      new Promise<void>((resolve) => {
        // The one long-timer law (`timers/longTimeout.ts`); the door admits at most 30 000 ms today.
        cancelTimer = setLongTimeout(() => {
          active = false;
          controller.abort();
          unknown('acknowledgement-timeout');
          resolve();
        }, options.timeoutMs ?? 10_000);
      }),
    ]);
  } finally {
    active = false;
    cancelTimer();
  }
}
