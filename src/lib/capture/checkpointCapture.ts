import type { CaptureLimitation, NativeCaptureNote } from './nativeCoverage.js';
import {
  CAPTURE_BASE_LIMITATIONS,
  CAPTURE_CHANNEL_STATUSES,
  CAPTURE_COMMIT_VALUE_MODES,
  CAPTURE_LIMITATIONS,
  CAPTURE_PROVENANCE_MODES,
  CAPTURE_RETENTION_MODES,
  isCaptureValue,
} from './nativeCoverage.js';

/** Own data only: a stored note cannot run getters or carry an unbounded identity/list. */
function data(record: unknown, key: string): unknown {
  if (!record || typeof record !== 'object' || Object.getPrototypeOf(record) !== Object.prototype) return undefined;
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function captureRefusal(): Error {
  return new Error('Invalid checkpoint: capture must be a bounded paused root-log observation.');
}

function copyIdentity(value: unknown): Pick<NativeCaptureNote, 'runId' | 'logAddress' | 'commits'> | undefined {
  const runId = data(value, 'runId');
  const address = data(value, 'logAddress');
  const logRunId = data(address, 'logRunId');
  const drill = data(address, 'drillPath');
  const commits = data(value, 'commits');
  const from = data(commits, 'from');
  const to = data(commits, 'to');
  if (
    data(value, 'version') !== 1 ||
    data(value, 'scope') !== 'root-log' ||
    data(value, 'persistence') !== 'memory-only' ||
    !identity(runId) ||
    !identity(logRunId) ||
    !Array.isArray(drill) ||
    Object.getPrototypeOf(drill) !== Array.prototype ||
    Object.getOwnPropertyDescriptor(drill, 'length')?.value !== 0 ||
    !count(from) ||
    !count(to) ||
    from > to ||
    data(data(value, 'boundary'), 'status') !== 'paused'
  )
    return undefined;
  return {
    runId,
    logAddress: Object.freeze({ logRunId, drillPath: Object.freeze([]) }),
    commits: Object.freeze({ from, to }),
  };
}

function copyModes(value: unknown): NativeCaptureNote['modes'] | undefined {
  const readTracking = data(value, 'readTracking');
  const writeTracking = data(value, 'writeTracking');
  const commitValues = data(value, 'commitValues');
  const writeProvenance = data(value, 'writeProvenance');
  if (
    !isCaptureValue(readTracking, CAPTURE_RETENTION_MODES) ||
    !isCaptureValue(writeTracking, CAPTURE_RETENTION_MODES) ||
    !isCaptureValue(commitValues, CAPTURE_COMMIT_VALUE_MODES) ||
    !isCaptureValue(writeProvenance, CAPTURE_PROVENANCE_MODES)
  )
    return undefined;
  return Object.freeze({ readTracking, writeTracking, commitValues, writeProvenance });
}

function copyChannels(value: unknown): NativeCaptureNote['channels'] | undefined {
  const reads = data(value, 'reads');
  const writes = data(value, 'writes');
  const attention = data(value, 'attention');
  const control = data(value, 'control');
  if (
    !isCaptureValue(reads, CAPTURE_CHANNEL_STATUSES) ||
    !isCaptureValue(writes, CAPTURE_CHANNEL_STATUSES) ||
    !isCaptureValue(attention, CAPTURE_CHANNEL_STATUSES) ||
    !isCaptureValue(control, CAPTURE_CHANNEL_STATUSES) ||
    data(value, 'readSources') !== 'not-collected'
  )
    return undefined;
  return Object.freeze({
    reads,
    writes,
    attention,
    // Recorder history is absent; reads/writes describe the paused segment's native funnels.
    control: control === 'failed' || control === 'partial' || control === 'disabled' ? control : 'unknown',
    readSources: 'not-collected',
  });
}

function copyLimitations(value: unknown): readonly CaptureLimitation[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!count(length) || length > 32) return undefined;
  const limitations = new Set<CaptureLimitation>(CAPTURE_BASE_LIMITATIONS);
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index))?.value;
    if (!isCaptureValue(entry, CAPTURE_LIMITATIONS)) return undefined;
    limitations.add(entry);
  }
  limitations.add('checkpoint-history-not-included');
  return Object.freeze([...limitations]);
}

/**
 * A checkpoint retains an observation ABOUT its paused root leg, not the log itself.
 * Validates shape, not authenticity. Never promotes it to durable evidence or copies arbitrary fields.
 * Returning undefined lets the checkpoint codec give one fixed refusal, without untrusted text.
 */
export function copyCheckpointCapture(value: unknown): NativeCaptureNote | undefined {
  try {
    const identity = copyIdentity(value);
    if (!identity) return undefined;
    const modes = copyModes(data(value, 'modes'));
    if (!modes) return undefined;
    const channels = copyChannels(data(value, 'channels'));
    if (!channels) return undefined;
    const limitations = copyLimitations(data(value, 'limitations'));
    if (!limitations) return undefined;
    return Object.freeze({
      version: 1,
      runId: identity.runId,
      scope: 'root-log',
      logAddress: identity.logAddress,
      commits: identity.commits,
      boundary: Object.freeze({ status: 'paused' }),
      modes,
      channels,
      persistence: 'memory-only',
      limitations,
    });
  } catch {
    return undefined;
  }
}

/** Read the optional field before the general checkpoint upcaster could evaluate a supplied getter. */
export function readCheckpointCapture(stored: object): NativeCaptureNote | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(stored, 'capture');
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) throw captureRefusal();
    if (descriptor.value === undefined) return undefined;
    const note = copyCheckpointCapture(descriptor.value);
    if (!note) throw captureRefusal();
    return note;
  } catch {
    throw captureRefusal();
  }
}

/** Keep the general upcaster from re-reading capture through a getter or Proxy get trap. */
export function withoutCheckpointCapture(stored: Record<string, unknown>): Record<string, unknown> {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(stored);
    delete descriptors.capture;
    // Preserve every other field's existing descriptor/prototype behavior. No Get(capture).
    return Object.defineProperties(Object.create(Object.getPrototypeOf(stored)), descriptors);
  } catch {
    throw captureRefusal();
  }
}
