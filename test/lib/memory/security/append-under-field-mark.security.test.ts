/**
 * The admitted record (9.30.0) — security: a field mark BELOW an array path.
 *
 * A field redaction addresses an element of the WHOLE array (`list.1.token`).
 * A delta `append` row holds only the tail, so `redactPatch` finds no element 1
 * there and the secret would stay in the commit log and the redacted mirror.
 * `deltaEncoding · pushValueRow` takes the `set` of the whole value whenever a
 * mark sits below the path. Two shapes reach that row:
 *   - `lossyMerge` — a merge family that does not fold back, re-encoded as its
 *     read-back (base + tail); found by the PR #11 review, a 9.30.0 regression;
 *   - `setAppend` — a hard write of base + tail; open since before 9.29.0.
 *
 * Written through footprintjs/write: two stage frames over one heap, one log and
 * one redacted mirror (`RecordFrame · useMirror`), each write of `list` carrying
 * the bytes of the policy `fields: { list: ['1.token'] }` — the scrub
 * `{ fields: ['1.token'] }` the engine's verdict hands the frame. The same log,
 * mirror and heap the flowchart with that policy writes.
 */
import { describe, expect, it } from 'vitest';

import type { WriteScrub } from '../../../../src/write';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

const SECRET = 'SECRET-tail';
/** The verdict's bytes for every write of `list` under `fields: { list: ['1.token'] }`. */
const FIELD_MARK: WriteScrub = { fields: ['1.token'] };

function run(commitValues: 'full' | 'delta', variant: 'setAppend' | 'lossyMerge') {
  const state = new SharedMemory();
  const mirror = new SharedMemory();
  const log = new EventLog(state.getState());
  const stage = (stageId: string, stage: string, index: number, body: (frame: RecordFrame) => void) => {
    const frame = new RecordFrame(state, log);
    frame.useEncoding({ commitValues, writeProvenance: 'off' });
    frame.useMirror(mirror);
    body(frame);
    frame.commit(() => ({ stage, stageId, runtimeStageId: `${stageId}#${index}` }));
    frame.release();
  };

  stage('seed', 'Seed', 0, (frame) => {
    frame.write(['list'], [{ id: 1 }], 'set', FIELD_MARK);
  });
  stage('probe', 'Probe', 1, (frame) => {
    if (variant === 'setAppend') {
      const list = frame.read([], 'list') as unknown[];
      frame.write(['list'], [...list, { id: 3, token: SECRET }], 'set', FIELD_MARK);
    } else {
      frame.write(['list'], [{ id: 2 }], 'merge', FIELD_MARK);
      frame.write(['list'], [], 'merge', FIELD_MARK);
      frame.write(['list'], [{ id: 1 }, { id: 3, token: SECRET }], 'merge', FIELD_MARK);
    }
  });
  return { log, mirror, state };
}

describe('a field mark below an array path is never lost to a compact append', () => {
  for (const variant of ['setAppend', 'lossyMerge'] as const) {
    it.each(['full', 'delta'] as const)(`${variant}: no secret in the log or the redacted mirror (%s)`, (mode) => {
      const ex = run(mode, variant);
      const log = JSON.stringify(ex.log.list());
      expect(log).not.toContain(SECRET);
      const mirror = ex.mirror.getState() as any;
      expect(JSON.stringify(mirror)).not.toContain(SECRET);
      expect(mirror.list[1].token).toBe('REDACTED');
      // The live heap keeps the value (the redaction law never touches it).
      expect((ex.state.getState() as any).list[1].token).toBe(SECRET);
    });
  }
});
