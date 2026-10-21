import type { NativeCaptureNote } from './nativeCoverage.js';
import { CAPTURE_BASE_LIMITATIONS } from './nativeCoverage.js';
import { copyChannels, copyIdentity, copyLimitations, copyModes, ownData } from './noteShape.js';

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
    if (
      ownData(value, 'scope') !== 'root-log' ||
      ownData(value, 'persistence') !== 'memory-only' ||
      ownData(ownData(value, 'boundary'), 'status') !== 'paused'
    )
      return undefined;
    const identity = copyIdentity(value);
    if (!identity) return undefined;
    const modes = copyModes(ownData(value, 'modes'));
    if (!modes) return undefined;
    const channels = copyChannels(ownData(value, 'channels'));
    if (!channels) return undefined;
    const limitations = copyLimitations(ownData(value, 'limitations'));
    if (!limitations) return undefined;
    return Object.freeze({
      version: 1,
      runId: identity.runId,
      scope: 'root-log',
      logAddress: identity.logAddress,
      commits: identity.commits,
      boundary: Object.freeze({ status: 'paused' }),
      modes,
      channels: Object.freeze({
        ...channels,
        // Recorder history is absent; reads/writes describe the paused segment's native funnels.
        control:
          channels.control === 'failed' || channels.control === 'partial' || channels.control === 'disabled'
            ? channels.control
            : 'unknown',
      }),
      persistence: 'memory-only',
      limitations: Object.freeze([
        ...new Set([...CAPTURE_BASE_LIMITATIONS, ...limitations, 'checkpoint-history-not-included'] as const),
      ]),
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
