import type { NativeCaptureNote } from './nativeCoverage.js';
import { CAPTURE_BASE_LIMITATIONS, CAPTURE_CHANNEL_STATUSES, isCaptureValue } from './nativeCoverage.js';
import { copyChannels, copyIdentity, copyLimitations, copyModes, copyObservedChannels, ownData } from './noteShape.js';
import type { NativeCaptureObservation } from './readSources.js';

function captureRefusal(): Error {
  return new Error('Invalid checkpoint: capture must be a bounded paused root-log observation.');
}

/**
 * A checkpoint retains an observation ABOUT its paused root leg, not the log itself.
 * Validates shape, not authenticity. Never promotes it to durable evidence or copies arbitrary fields.
 * Returning undefined lets the checkpoint codec give one fixed refusal, without untrusted text.
 */
export function copyCheckpointCapture(value: unknown): NativeCaptureObservation | undefined {
  try {
    if (
      ownData(value, 'scope') !== 'root-log' ||
      ownData(value, 'persistence') !== 'memory-only' ||
      ownData(ownData(value, 'boundary'), 'status') !== 'paused'
    )
      return undefined;
    const version = ownData(value, 'version') === 2 ? 2 : 1;
    const identity = copyIdentity(value, false, version);
    if (!identity) return undefined;
    const modes = copyModes(ownData(value, 'modes'));
    if (!modes) return undefined;
    const storedChannels = ownData(value, 'channels');
    const channels = version === 1 ? copyChannels(storedChannels) : copyObservedChannels(storedChannels);
    if (!channels) return undefined;
    if (version === 2 && !isCaptureValue(ownData(storedChannels, 'readSources'), CAPTURE_CHANNEL_STATUSES))
      return undefined;
    const limitations = copyLimitations(ownData(value, 'limitations'));
    if (!limitations) return undefined;
    const common = {
      runId: identity.runId,
      scope: 'root-log',
      logAddress: identity.logAddress,
      commits: identity.commits,
      boundary: Object.freeze({ status: 'paused' as const }),
      modes,
      channels: {
        ...channels,
        // Recorder history is absent; reads/writes describe the paused segment's native funnels.
        control:
          channels.control === 'failed' || channels.control === 'partial' || channels.control === 'disabled'
            ? channels.control
            : ('unknown' as const),
      },
      persistence: 'memory-only' as const,
    };
    if (version === 2)
      return Object.freeze({
        ...common,
        version: 2,
        scope: 'root-log',
        channels: Object.freeze({ ...common.channels, readSources: 'unknown' }),
        limitations: Object.freeze([
          ...new Set([...limitations, 'checkpoint-history-not-included', 'source-history-not-included'] as const),
        ]),
      });
    return Object.freeze({
      version: 1,
      ...common,
      scope: 'root-log',
      channels: Object.freeze({ ...common.channels, readSources: 'not-collected' }),
      limitations: Object.freeze([
        ...new Set([...CAPTURE_BASE_LIMITATIONS, ...limitations, 'checkpoint-history-not-included'] as const),
      ]),
    }) as NativeCaptureNote;
  } catch {
    return undefined;
  }
}

/** Read the optional field before the general checkpoint upcaster could evaluate a supplied getter. */
export function readCheckpointCapture(stored: object): NativeCaptureObservation | undefined {
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
