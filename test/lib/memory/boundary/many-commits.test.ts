/**
 * Boundary: many commits — a chain of stage frames (`RecordFrame`, footprintjs/write), one per commit, at a
 * run's address (`['runs', 'p1']`): the log keeps every bundle, folds at any step, and accumulates merges.
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** Stage `s<i>`: a fresh frame at run `p1`, `body` staged on it, then committed and released. */
function stage(mem: SharedMemory, log: EventLog, i: number, body: (frame: RecordFrame) => void): void {
  const frame = new RecordFrame(mem, log, ['runs', 'p1']);
  body(frame);
  frame.commit(() => ({ stage: `s${i}`, stageId: `s${i}`, runtimeStageId: `s${i}#${i}` }));
  frame.release();
}

describe('Boundary: many commits', () => {
  it('handles 200 sequential commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    for (let i = 0; i < 200; i++) {
      stage(mem, log, i, (frame) => frame.write(frame.at([], 'counter'), i, 'set'));
    }

    expect(log.list()).toHaveLength(200);
    expect(mem.getValue(['runs', 'p1'], [], 'counter')).toBe(199);
  });

  it('materialise at any step within 200 commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    for (let i = 0; i < 200; i++) {
      stage(mem, log, i, (frame) => frame.write(frame.at([], 'step'), i, 'set'));
    }

    // Check a few points
    const at50 = log.materialise(50);
    expect(at50.runs.p1.step).toBe(49);

    const at100 = log.materialise(100);
    expect(at100.runs.p1.step).toBe(99);

    const at200 = log.materialise(200);
    expect(at200.runs.p1.step).toBe(199);
  });

  it('accumulative merges across many commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    for (let i = 0; i < 100; i++) {
      stage(mem, log, i, (frame) => frame.write(frame.at([], 'items'), [`item${i}`], 'merge'));
    }

    const items = mem.getValue(['runs', 'p1'], [], 'items') as string[];
    expect(items).toHaveLength(100);
    expect(items[0]).toBe('item0');
    expect(items[99]).toBe('item99');
  });
});
