/**
 * Boundary: large state — one stage's frame (`RecordFrame`, footprintjs/write) commits a thousand keys and
 * a 100 KB value at a run's address (`['runs', 'p1']`, where the engine's frame of run `p1` writes), and the
 * log folds them back.
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** Commit the frame as stage `s1` and release it, as the engine's frame does at the end of a stage. */
function commit(frame: RecordFrame): void {
  frame.commit(() => ({ stage: 's1', stageId: 's1', runtimeStageId: 's1#0' }));
  frame.release();
}

describe('Boundary: large state', () => {
  it('handles 1000 keys in a single commit', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const frame = new RecordFrame(mem, log, ['runs', 'p1']);

    for (let i = 0; i < 1000; i++) {
      frame.write(frame.at([], `key${i}`), `value${i}`, 'set');
    }
    commit(frame);

    for (let i = 0; i < 1000; i++) {
      expect(mem.getValue(['runs', 'p1'], [], `key${i}`)).toBe(`value${i}`);
    }
  });

  it('handles a large object value (100KB+ serialised)', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const frame = new RecordFrame(mem, log, ['runs', 'p1']);

    const largeArray = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      data: 'x'.repeat(10),
    }));

    frame.write(frame.at([], 'bigData'), largeArray, 'set');
    commit(frame);

    const retrieved = mem.getValue(['runs', 'p1'], [], 'bigData');
    expect(retrieved).toHaveLength(10000);
    expect(retrieved[9999].id).toBe(9999);
  });

  it('EventLog materialise works with large state', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const frame = new RecordFrame(mem, log, ['runs', 'p1']);
    const data: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      data[`field${i}`] = i;
    }
    frame.write(frame.at([], 'bulk'), data, 'set');
    commit(frame);

    const state = log.materialise();
    expect(Object.keys(state.runs.p1.bulk)).toHaveLength(500);
  });
});
