/**
 * Boundary: deep nesting — a write 20 levels deep, staged by one stage's frame (`RecordFrame`,
 * footprintjs/write) at a run's address, commits and reads back.
 *
 * The frame's own deep trees (a 50-stage `createNext` chain, a branching `createChild` tree) are the
 * engine's frame, not the record: they live in unit/StageContext.test.ts ("deep trees").
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

describe('Boundary: deep nesting', () => {
  it('handles deeply nested paths (20 levels)', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const frame = new RecordFrame(mem, log, ['runs', 'p1']);

    const path = Array.from({ length: 19 }, (_, i) => `level${i}`);
    frame.write(frame.at(path, 'leaf'), 'deepValue', 'set');
    frame.commit(() => ({ stage: 's1', stageId: 's1', runtimeStageId: 's1#0' }));
    frame.release();

    expect(frame.read(path, 'leaf')).toBe('deepValue');
  });
});
