import { copyHistoryTarget } from './historyTarget.js';
import type { CaptureHistoryTarget } from './historyTypes.js';
import type { NativeCaptureNote } from './nativeCoverage.js';
import {
  CAPTURE_BASE_LIMITATIONS,
  CAPTURE_CHANNEL_STATUSES,
  CAPTURE_COMMIT_VALUE_MODES,
  CAPTURE_LIMITATIONS,
  CAPTURE_PROVENANCE_MODES,
  CAPTURE_RETENTION_MODES,
  isCaptureValue,
} from './nativeCoverage.js';

/** @internal Called only after the bounded inert-data copier. Retains native observations, not storage authority. */
export function historyNote(value: unknown, target: CaptureHistoryTarget): NativeCaptureNote | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as NativeCaptureNote;
  const identity = copyHistoryTarget({ ...v, evidenceId: target.evidenceId, digest: target.digest });
  if (
    !identity ||
    JSON.stringify(identity) !== JSON.stringify(copyHistoryTarget(target)) ||
    v.scope !== 'root-log' ||
    v.persistence !== 'memory-only' ||
    !v.boundary ||
    !['completed', 'failed', 'paused', 'cancelled'].includes(v.boundary.status) ||
    !v.modes ||
    !v.channels ||
    !Array.isArray(v.limitations) ||
    v.limitations.length > 32 ||
    !v.limitations.every((g) => isCaptureValue(g, CAPTURE_LIMITATIONS)) ||
    !CAPTURE_BASE_LIMITATIONS.every((g) => v.limitations.includes(g)) ||
    !isCaptureValue(v.modes.readTracking, CAPTURE_RETENTION_MODES) ||
    !isCaptureValue(v.modes.writeTracking, CAPTURE_RETENTION_MODES) ||
    !isCaptureValue(v.modes.commitValues, CAPTURE_COMMIT_VALUE_MODES) ||
    !isCaptureValue(v.modes.writeProvenance, CAPTURE_PROVENANCE_MODES) ||
    ![v.channels.reads, v.channels.writes, v.channels.attention, v.channels.control].every((c) =>
      isCaptureValue(c, CAPTURE_CHANNEL_STATUSES),
    ) ||
    v.channels.readSources !== 'not-collected'
  )
    return undefined;
  // Reject extra metadata rather than handing arbitrary stored fields out as native facts.
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'version',
          'runId',
          'scope',
          'logAddress',
          'commits',
          'boundary',
          'modes',
          'channels',
          'persistence',
          'limitations',
        ].includes(k),
    )
  )
    return undefined;
  if (
    Object.keys(v.logAddress).length !== 2 ||
    Object.keys(v.commits).length !== 2 ||
    Object.keys(v.modes).length !== 4 ||
    Object.keys(v.channels).length !== 5
  )
    return undefined;
  const failure = v.boundary.failure;
  if (Object.keys(v.boundary).some((k) => k !== 'status' && k !== 'failure')) return undefined;
  if (
    failure &&
    (!['failed', 'cancelled'].includes(v.boundary.status) ||
      !['timeout', 'rate-limited', 'server', 'network', 'auth', 'permanent', 'unknown'].includes(failure.category) ||
      Object.keys(failure).some((k) => k !== 'category' && k !== 'stage') ||
      (failure.stage &&
        (Object.keys(failure.stage).some((k) => k !== 'runId' && k !== 'runtimeStageId') ||
          failure.stage.runId !== v.runId ||
          typeof failure.stage.runtimeStageId !== 'string' ||
          failure.stage.runtimeStageId.length > 1024)))
  )
    return undefined;
  return v;
}
