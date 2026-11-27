import { couldHaveChanged } from 'foottrace/cause';
import { EventLog, memorySink, RecordFrame, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import {
  beginStoredControl,
  noteStoredControlDecision,
  noteStoredControlLoop,
  noteStoredControlStage,
  storedControlAbout,
  storedControlLanded,
} from '../../../src/lib/memory/storedControlEvidence.js';

const address = { logRunId: 'native-control', drillPath: [] };

describe.each(['full', 'delta'] as const)('native control note ordering (%s)', (commitValues) => {
  it.skipIf(typeof couldHaveChanged !== 'function')(
    'admits only the exact post-commit dispatch and static loop target',
    () => {
      const sink = memorySink();
      const memory = new SharedMemory();
      const log = new EventLog(memory.getState(), { sink, address, collects: { reads: 'off' } });
      const frame = new RecordFrame(memory, log);
      frame.useEncoding({ commitValues, writeProvenance: 'off' });
      beginStoredControl(frame, log, { id: 'choose#0' });

      noteStoredControlDecision(frame, { by: 'plain', chosen: 'Ignored' });
      noteStoredControlLoop(frame, 'ignored');
      frame.commit(() => ({
        stage: 'Choose',
        stageId: 'choose',
        runtimeStageId: 'choose#0',
        about: storedControlAbout(frame),
      }));
      storedControlLanded(frame);
      expect(storedControlAbout(frame)).toBeUndefined();
      noteStoredControlDecision(frame, { by: 'plain', chosen: 'Again' });
      noteStoredControlDecision(frame, { by: 'plain', chosen: 'Duplicate' });
      noteStoredControlLoop(frame, 'tick');
      noteStoredControlLoop(frame, 'duplicate');

      expect(sink.entries).toMatchObject([
        { kind: 'opened', collects: { v: 2, reads: 'off' } },
        { kind: 'commit', about: {}, bundle: { runtimeStageId: 'choose#0' } },
        { kind: 'note', note: 'run.decision', data: { seq: 0, id: 'choose#0', chosen: 'Again', by: 'plain' } },
        { kind: 'note', note: 'run.loop', data: { seq: 1, id: 'choose#0', target: 'tick' } },
      ]);
    },
  );

  it('preserves an entry edge without claiming a choice or a loop', () => {
    const sink = memorySink();
    const log = new EventLog({}, { sink, address, collects: { reads: 'off' } });
    const frame = {};
    beginStoredControl(frame, log, { id: 'join#3', parent: 'choose#2' });

    noteStoredControlStage(frame);
    noteStoredControlStage(frame);
    noteStoredControlDecision(frame, { by: 'plain', chosen: 'Unavailable' });
    noteStoredControlLoop(frame, 'unavailable');

    expect(sink.entries).toMatchObject([
      { kind: 'opened' },
      { kind: 'note', note: 'run.stage', data: { seq: 0, id: 'join#3', parent: 'choose#2' } },
    ]);
  });
});
