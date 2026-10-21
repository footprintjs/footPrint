/** A checkpoint must accept the producer's vocabulary, not a second handwritten list. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { copyCheckpointCapture } from '../../../src/lib/capture/checkpointCapture.js';
import type { NativeCaptureNote } from '../../../src/lib/capture/nativeCoverage.js';
import {
  CAPTURE_BASE_LIMITATIONS,
  CAPTURE_CHANNEL_STATUSES,
  CAPTURE_COMMIT_VALUE_MODES,
  CAPTURE_LIMITATIONS,
  CAPTURE_PROVENANCE_MODES,
  CAPTURE_RETENTION_MODES,
  NativeCapture,
} from '../../../src/lib/capture/nativeCoverage.js';

const modes = fc.record(
  {
    readTracking: fc.constantFrom(...CAPTURE_RETENTION_MODES),
    writeTracking: fc.constantFrom(...CAPTURE_RETENTION_MODES),
    commitValues: fc.constantFrom(...CAPTURE_COMMIT_VALUE_MODES),
    writeProvenance: fc.constantFrom(...CAPTURE_PROVENANCE_MODES),
  },
  { noNullPrototype: true },
);
// Native notes and JSON records contain plain objects, never null-prototype channel bags.
const channels = fc.record(
  {
    reads: fc.constantFrom(...CAPTURE_CHANNEL_STATUSES),
    writes: fc.constantFrom(...CAPTURE_CHANNEL_STATUSES),
    attention: fc.constantFrom(...CAPTURE_CHANNEL_STATUSES),
    control: fc.constantFrom(...CAPTURE_CHANNEL_STATUSES),
    readSources: fc.constant('not-collected' as const),
  },
  { noNullPrototype: true },
);

function observation(policy: NativeCaptureNote['modes'], limitations: NativeCaptureNote['limitations'] = []) {
  const collector = new NativeCapture('run', { logRunId: 'log', drillPath: [] }, 3, policy);
  for (const gap of limitations) collector.limit(gap);
  collector.end('paused');
  return collector;
}

function accepted(note: NativeCaptureNote) {
  const before = JSON.stringify(note);
  const copied = copyCheckpointCapture(note);
  expect(copied).toBeDefined();
  expect(copied?.modes).toEqual(note.modes);
  expect(copied?.channels).toMatchObject({
    reads: note.channels.reads,
    writes: note.channels.writes,
    attention: note.channels.attention,
    readSources: 'not-collected',
  });
  expect(copied?.channels.control).toBe(note.channels.control === 'captured' ? 'unknown' : note.channels.control);
  for (const gap of [...CAPTURE_BASE_LIMITATIONS, ...note.limitations, 'checkpoint-history-not-included'])
    expect(copied?.limitations).toContain(gap);
  expect(copied?.persistence).toBe('memory-only');
  expect(copied?.boundary).toEqual({ status: 'paused' });
  expect(JSON.stringify(note)).toBe(before);
  expect(copyCheckpointCapture(JSON.parse(JSON.stringify(note)))).toEqual(copied);
}

describe('producer/checkpoint vocabulary contract', () => {
  it('accepts every declared mode combination produced by the native collector', () => {
    let combinations = 0;
    for (const readTracking of CAPTURE_RETENTION_MODES)
      for (const writeTracking of CAPTURE_RETENTION_MODES)
        for (const commitValues of CAPTURE_COMMIT_VALUE_MODES)
          for (const writeProvenance of CAPTURE_PROVENANCE_MODES) {
            accepted(observation({ readTracking, writeTracking, commitValues, writeProvenance }).snapshot(7));
            combinations++;
          }
    expect(combinations).toBe(
      CAPTURE_RETENTION_MODES.length ** 2 * CAPTURE_COMMIT_VALUE_MODES.length * CAPTURE_PROVENANCE_MODES.length,
    );
  });

  it('accepts every declared per-channel combination without upgrading missing control evidence', () => {
    const note = observation({
      readTracking: 'full',
      writeTracking: 'full',
      commitValues: 'full',
      writeProvenance: 'off',
    }).snapshot(7);
    for (const reads of CAPTURE_CHANNEL_STATUSES)
      for (const writes of CAPTURE_CHANNEL_STATUSES)
        for (const attention of CAPTURE_CHANNEL_STATUSES)
          for (const control of CAPTURE_CHANNEL_STATUSES)
            accepted({ ...note, channels: { reads, writes, attention, control, readSources: 'not-collected' } });
  });

  it('accepts generated native observations across mode, control and limitation subsets', () => {
    fc.assert(
      fc.property(
        modes,
        fc.constantFrom(...CAPTURE_CHANNEL_STATUSES),
        fc.subarray(CAPTURE_LIMITATIONS),
        fc.boolean(),
        (policy, control, limitations, redacted) =>
          accepted(observation(policy, limitations).snapshot(7, control, redacted)),
      ),
      { seed: 120111, numRuns: 512 },
    );
  });

  it('accepts generated declared channel statuses together with varied modes and limitation subsets', () => {
    fc.assert(
      fc.property(modes, channels, fc.subarray(CAPTURE_LIMITATIONS), (policy, channel, limitations) => {
        const note = observation(policy, limitations).snapshot(7);
        accepted({ ...note, channels: channel });
      }),
      { seed: 120112, numRuns: 512 },
    );
  });

  it('still refuses values outside each declared mode/status vocabulary', () => {
    const note = observation({
      readTracking: 'full',
      writeTracking: 'full',
      commitValues: 'full',
      writeProvenance: 'off',
    }).snapshot(7);
    for (const group of ['modes', 'channels'] as const)
      for (const field of Object.keys(note[group]))
        expect(
          copyCheckpointCapture({ ...note, [group]: { ...note[group], [field]: 'UNRECOGNIZED' } }),
        ).toBeUndefined();
  });

  it('keeps non-plain channel bags outside the accepted stored-note contract', () => {
    const note = observation({
      readTracking: 'full',
      writeTracking: 'full',
      commitValues: 'full',
      writeProvenance: 'off',
    }).snapshot(7);
    expect(
      copyCheckpointCapture({ ...note, channels: Object.assign(Object.create(null), note.channels) }),
    ).toBeUndefined();
  });
});
