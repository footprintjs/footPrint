import type { CaptureHistoryTarget } from './historyTypes.js';
import type { NativeCaptureNote } from './nativeCoverage.js';
import { CAPTURE_BASE_LIMITATIONS } from './nativeCoverage.js';
import { copyChannels, copyIdentity, copyLimitations, copyModes } from './noteShape.js';

/** @internal Called only after the bounded inert-data copier. Retains native observations, not storage authority. */
export function historyNote(value: unknown, target: CaptureHistoryTarget): NativeCaptureNote | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as NativeCaptureNote;
  const identity = copyIdentity(v, true);
  const limitations = copyLimitations(v.limitations);
  if (
    !identity ||
    JSON.stringify(identity) !== JSON.stringify(copyIdentity(target)) ||
    v.scope !== 'root-log' ||
    v.persistence !== 'memory-only' ||
    !v.boundary ||
    !['completed', 'failed', 'paused', 'cancelled'].includes(v.boundary.status) ||
    !v.modes ||
    !v.channels ||
    !limitations ||
    !CAPTURE_BASE_LIMITATIONS.every((g) => limitations.includes(g)) ||
    !copyModes(v.modes, true) ||
    !copyChannels(v.channels, true)
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
