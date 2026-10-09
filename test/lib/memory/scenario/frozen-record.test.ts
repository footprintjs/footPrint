/** The record owns sealing. Engine snapshot/fork/subflow witnesses stay in frozen-log.test.ts. */
import type { CommitBundle } from '../../../../src/trace';
import { EventLog } from '../../../../src/write';
import { unfrozen } from '../../../helpers/unfrozen';

describe('the record is frozen — the writer door', () => {
  it('EventLog.record freezes the bundle it is handed, after stamping its position; materialise still folds', () => {
    const log = new EventLog({ k: 0 });
    const bundle: CommitBundle = {
      stage: 'S',
      stageId: 's',
      runtimeStageId: 's#0',
      trace: [{ path: 'k', verb: 'set' }],
      overwrite: { k: { v: [1] } },
      updates: {},
      redactedPaths: [],
    };
    log.record(bundle);
    expect(bundle.idx).toBe(0);
    expect(unfrozen(bundle)).toEqual([]);
    expect(log.list()[0]).toBe(bundle);
    expect(log.materialise()).toEqual({ k: { v: [1] } });
  });
});
