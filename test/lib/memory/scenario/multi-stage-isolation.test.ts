/**
 * Scenario: multi-stage isolation — each stage's frame (`RecordFrame`, footprintjs/write) stages into its own
 * buffer: a fork's children (two frames at the run's address, `['runs', 'p1']`) and a linear chain alike
 * see only their own uncommitted writes and every committed one.
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** A stage's frame at run `p1` — the address the engine's frame of that run writes at. */
const frameOf = (mem: SharedMemory, log: EventLog) => new RecordFrame(mem, log, ['runs', 'p1']);

/** Commit the frame as `stage` and release it, as the engine's frame does at the end of a stage. */
function commit(frame: RecordFrame, stage: string): void {
  frame.commit(() => ({ stage, stageId: stage, runtimeStageId: `${stage}#0` }));
  frame.release();
}

describe('Scenario: multi-stage isolation', () => {
  it('parallel children get isolated transaction buffers', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const child1 = frameOf(mem, log);
    const child2 = frameOf(mem, log);

    child1.write(child1.at([], 'result'), 'from-child1', 'set');
    child2.write(child2.at([], 'result'), 'from-child2', 'set');

    // Before commit, each child sees its own write
    expect(child1.read([], 'result')).toBe('from-child1');
    expect(child2.read([], 'result')).toBe('from-child2');

    // After child1 commits, child2 still sees its own buffered value
    commit(child1, 'child1');
    expect(child2.read([], 'result')).toBe('from-child2');
  });

  it('parent can read children results after their commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const child1 = frameOf(mem, log);
    const child2 = frameOf(mem, log);

    child1.write(child1.at(['results'], 'child1'), 'done', 'set');
    commit(child1, 'child1');

    child2.write(child2.at(['results'], 'child2'), 'done', 'set');
    commit(child2, 'child2');

    // The join's fresh frame sees the committed results
    const join = frameOf(mem, log);
    expect(join.read(['results'], 'child1')).toBe('done');
    expect(join.read(['results'], 'child2')).toBe('done');
  });

  it('stages in a linear chain do not share buffers', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const s1 = frameOf(mem, log);
    s1.write(s1.at([], 'counter'), 1, 'set');
    commit(s1, 's1');

    const s2 = frameOf(mem, log);
    // s2 has fresh buffer, sees committed value
    expect(s2.read([], 'counter')).toBe(1);

    s2.write(s2.at([], 'counter'), 2, 'set');
    commit(s2, 's2');

    const s3 = frameOf(mem, log);
    expect(s3.read([], 'counter')).toBe(2);
  });
});
