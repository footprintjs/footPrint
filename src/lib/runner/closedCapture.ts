import type { CommitBundle, Meta } from 'foottrace';

import { copyCaptureEvidence, validateAbsentEntries } from '../capture/absentEntries.js';
import {
  type NativeCaptureClosure,
  CAPTURE_CLOSURE_LIMITATIONS,
  copyCaptureClosure,
} from '../capture/closedCapture.js';
import { validateClosureEvidence } from '../capture/closedCaptureEvidence.js';
import { copyHistoryData, historyEvidence, historyFailureReason } from '../capture/historyData.js';
import { historyNote } from '../capture/historyNote.js';
import type { NativeCaptureExtent } from '../capture/nativeExtentFormat.js';
import type { EngineReadSources, NativeCaptureObservation } from '../capture/readSources.js';
import { storedReadSources } from '../capture/storedReadSources.js';
import type { SelectedNativeFailure } from '../errors/terminalFailure.js';
import type { StageSnapshot } from '../memory/frameTypes.js';
import type { RecorderSnapshot, RuntimeSnapshot } from './ExecutionRuntime.js';

/** The same immutable recorded prefix is served in memory and bound into its saved history. No live state. */
export interface NativeClosedCaptureRecord {
  readonly closure: NativeCaptureClosure;
  readonly capture: NativeCaptureObservation;
  readonly captureExtent: NativeCaptureExtent;
  readonly executionTree: StageSnapshot;
  readonly readSources?: EngineReadSources;
  readonly recorders?: readonly RecorderSnapshot[];
  readonly absent?: readonly (readonly string[])[];
  readonly commitLog: readonly CommitBundle[];
  readonly initialState?: Record<string, unknown>;
}

export type NativeClosedCaptureResult =
  | { readonly status: 'closed'; readonly record: NativeClosedCaptureRecord }
  | { readonly status: 'unknown'; readonly reason: string; readonly record?: never };

/** @internal Shared absent result; the default-off path allocates no per-run cut. */
export const NO_CLOSED_CAPTURE: NativeClosedCaptureResult = Object.freeze({
  status: 'unknown',
  reason: 'not-collected',
});

/** @internal Copy and validate collected evidence; never re-execute stages or reconstruct uncollected events. */
export function closeNativeCapture(
  view: RuntimeSnapshot,
  selected: SelectedNativeFailure | undefined,
  serve: (value: Meta) => Meta,
  maxBytes = 1024 * 1024,
): NativeClosedCaptureResult {
  const unknown = (reason: string): NativeClosedCaptureResult => Object.freeze({ status: 'unknown', reason });
  try {
    const capture = view.capture;
    const extent = view.captureExtent;
    if (!capture || !extent) return unknown('capture-unavailable');
    const marker = {
      version: 1,
      policy: 'native-root-prefix-v1',
      scope: 'root-log',
      runId: capture.runId,
      logAddress: capture.logAddress,
      commits: capture.commits,
      status: 'closed',
      boundary: capture.boundary.status,
      ...(selected && { selectedFailure: selected }),
      limitations: CAPTURE_CLOSURE_LIMITATIONS,
    };
    if (!copyCaptureClosure(marker, capture, extent)) return unknown('native-prefix-unverified');
    const payload = historyEvidence(
      copyCaptureEvidence(
        serve({
          capture,
          captureExtent: extent,
          executionTree: view.executionTree,
          ...(view.recorders && { recorders: view.recorders }),
          ...(view.readSources && { readSources: view.readSources }),
          closure: marker,
        }),
        maxBytes,
      ),
    );
    const record = copyHistoryData(
      {
        ...payload,
        commitLog: view.commitLog,
        ...(view.initialState !== undefined && { initialState: view.initialState }),
      },
      maxBytes,
    ) as unknown as NativeClosedCaptureRecord;
    const admitted = historyNote(record.capture, {
      version: 1,
      runId: capture.runId,
      logAddress: capture.logAddress,
      commits: capture.commits,
    });
    if (
      !admitted ||
      !validateAbsentEntries(record as unknown as Record<string, unknown>) ||
      !copyCaptureClosure(record.closure, admitted, record.captureExtent) ||
      !validateClosureEvidence(record.closure, record.captureExtent, record.executionTree, record.commitLog)
    )
      return unknown('closure-evidence-refused');
    if (
      admitted.version === 2 &&
      !storedReadSources(record.readSources, admitted, record.commitLog, record.initialState, record.executionTree)
    )
      return unknown('source-evidence-refused');
    return Object.freeze({ status: 'closed', record });
  } catch (error) {
    return unknown(historyFailureReason(error, 'evidence'));
  }
}
