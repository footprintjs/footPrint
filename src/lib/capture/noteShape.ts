import type { CaptureLimitation, NativeCaptureNote } from './nativeCoverage.js';
import {
  CAPTURE_CHANNEL_STATUSES,
  CAPTURE_COMMIT_VALUE_MODES,
  CAPTURE_LIMITATIONS,
  CAPTURE_PROVENANCE_MODES,
  CAPTURE_RETENTION_MODES,
  isCaptureValue,
} from './nativeCoverage.js';

/** @internal One inert-data boundary for checkpoint and history capture codecs. */
export function ownData(record: unknown, key: string): unknown {
  if (!record || typeof record !== 'object' || Object.getPrototypeOf(record) !== Object.prototype) return undefined;
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

export function captureIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Exact history shapes refuse extras; checkpoints deliberately project known fields. */
function shapeKeys(value: unknown, fields: readonly string[], exact: boolean): boolean {
  return !exact || (!!value && typeof value === 'object' && Object.keys(value).length === fields.length);
}

export function copyIdentity(
  value: unknown,
  exact = false,
  version: 1 | 2 = 1,
): Pick<NativeCaptureNote, 'runId' | 'logAddress' | 'commits'> | undefined {
  const runId = ownData(value, 'runId');
  const address = ownData(value, 'logAddress');
  const logRunId = ownData(address, 'logRunId');
  const drill = ownData(address, 'drillPath');
  const commits = ownData(value, 'commits');
  const from = ownData(commits, 'from');
  const to = ownData(commits, 'to');
  if (
    ownData(value, 'version') !== version ||
    !captureIdentifier(runId) ||
    !captureIdentifier(logRunId) ||
    !Array.isArray(drill) ||
    Object.getPrototypeOf(drill) !== Array.prototype ||
    Object.getOwnPropertyDescriptor(drill, 'length')?.value !== 0 ||
    !count(from) ||
    !count(to) ||
    from > to ||
    !shapeKeys(address, ['logRunId', 'drillPath'], exact) ||
    !shapeKeys(commits, ['from', 'to'], exact)
  )
    return undefined;
  return {
    runId,
    logAddress: Object.freeze({ logRunId, drillPath: Object.freeze([]) }),
    commits: Object.freeze({ from, to }),
  };
}

export function copyModes(value: unknown, exact = false): NativeCaptureNote['modes'] | undefined {
  const readTracking = ownData(value, 'readTracking');
  const writeTracking = ownData(value, 'writeTracking');
  const commitValues = ownData(value, 'commitValues');
  const writeProvenance = ownData(value, 'writeProvenance');
  if (
    !isCaptureValue(readTracking, CAPTURE_RETENTION_MODES) ||
    !isCaptureValue(writeTracking, CAPTURE_RETENTION_MODES) ||
    !isCaptureValue(commitValues, CAPTURE_COMMIT_VALUE_MODES) ||
    !isCaptureValue(writeProvenance, CAPTURE_PROVENANCE_MODES) ||
    !shapeKeys(value, ['readTracking', 'writeTracking', 'commitValues', 'writeProvenance'], exact)
  )
    return undefined;
  return Object.freeze({ readTracking, writeTracking, commitValues, writeProvenance });
}

export function copyChannels(value: unknown, exact = false): NativeCaptureNote['channels'] | undefined {
  const observed = copyObservedChannels(value);
  if (
    !observed ||
    ownData(value, 'readSources') !== 'not-collected' ||
    !shapeKeys(value, ['reads', 'writes', 'attention', 'control', 'readSources'], exact)
  )
    return undefined;
  return Object.freeze({ ...observed, readSources: 'not-collected' });
}

/** Shared native statuses; source version admission remains explicit at each codec boundary. */
export function copyObservedChannels(value: unknown): Omit<NativeCaptureNote['channels'], 'readSources'> | undefined {
  const reads = ownData(value, 'reads');
  const writes = ownData(value, 'writes');
  const attention = ownData(value, 'attention');
  const control = ownData(value, 'control');
  if (
    !isCaptureValue(reads, CAPTURE_CHANNEL_STATUSES) ||
    !isCaptureValue(writes, CAPTURE_CHANNEL_STATUSES) ||
    !isCaptureValue(attention, CAPTURE_CHANNEL_STATUSES) ||
    !isCaptureValue(control, CAPTURE_CHANNEL_STATUSES)
  )
    return undefined;
  return Object.freeze({ reads, writes, attention, control });
}

export function copyLimitations(value: unknown): readonly CaptureLimitation[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!count(length) || length > 32) return undefined;
  const limitations: CaptureLimitation[] = [];
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index))?.value;
    if (!isCaptureValue(entry, CAPTURE_LIMITATIONS)) return undefined;
    limitations.push(entry);
  }
  return Object.freeze(limitations);
}
