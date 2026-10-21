import type { CaptureLimitation, NativeCaptureNote } from './nativeCoverage.js';
import { CAPTURE_BASE_LIMITATIONS, CAPTURE_LIMITATIONS } from './nativeCoverage.js';

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

/**
 * A checkpoint retains an observation ABOUT its paused root leg, not the log itself.
 * Validates shape, not authenticity. Never promotes it to durable evidence or copies arbitrary fields.
 * Returning undefined lets the checkpoint codec give one fixed refusal, without untrusted text.
 */
export function copyCheckpointCapture(value: unknown): NativeCaptureNote | undefined {
  try {
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

    const modes = data(value, 'modes');
    const readTracking = data(modes, 'readTracking');
    const writeTracking = data(modes, 'writeTracking');
    const commitValues = data(modes, 'commitValues');
    const writeProvenance = data(modes, 'writeProvenance');
    const retention = (v: unknown) => ['full', 'summary', 'off', 'unknown'].includes(v as string);
    if (
      !retention(readTracking) ||
      !retention(writeTracking) ||
      !['full', 'delta', 'unknown'].includes(commitValues as string) ||
      !['off', 'reads-prefix', 'unknown'].includes(writeProvenance as string)
    )
      return undefined;

    const channels = data(value, 'channels');
    const reads = data(channels, 'reads');
    const writes = data(channels, 'writes');
    const attention = data(channels, 'attention');
    const control = data(channels, 'control');
    const validChannel = (v: unknown) => ['captured', 'disabled', 'partial', 'failed', 'unknown'].includes(v as string);
    if (![reads, writes, attention, control].every(validChannel) || data(channels, 'readSources') !== 'not-collected')
      return undefined;
    const list = data(value, 'limitations');
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(list, 'length')?.value;
    if (!count(length) || length > 32) return undefined;
    const limitations = new Set<CaptureLimitation>(CAPTURE_BASE_LIMITATIONS);
    for (let i = 0; i < length; i++) {
      const entry = Object.getOwnPropertyDescriptor(list, String(i))?.value;
      if (!CAPTURE_LIMITATIONS.includes(entry)) return undefined;
      limitations.add(entry);
    }
    limitations.add('checkpoint-history-not-included');
    return Object.freeze({
      version: 1,
      runId,
      scope: 'root-log',
      logAddress: Object.freeze({ logRunId, drillPath: Object.freeze([]) }),
      commits: Object.freeze({ from, to }),
      boundary: Object.freeze({ status: 'paused' }),
      modes: Object.freeze({
        readTracking,
        writeTracking,
        commitValues,
        writeProvenance,
      }) as NativeCaptureNote['modes'],
      channels: Object.freeze({
        reads,
        writes,
        attention,
        control: control === 'failed' || control === 'partial' || control === 'disabled' ? control : 'unknown',
        readSources: 'not-collected',
      }) as NativeCaptureNote['channels'],
      persistence: 'memory-only',
      limitations: Object.freeze([...limitations]),
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
