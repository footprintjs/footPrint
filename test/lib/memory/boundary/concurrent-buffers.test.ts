/**
 * Boundary: concurrent buffers — a fork's children, each a stage frame (`RecordFrame`, footprintjs/write) at
 * the run's address (`['runs', 'p1']`), staged side by side: a hundred commit without loss, the last commit
 * of one key wins, no child sees another's uncommitted write, and the log keeps every child's bundle.
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** A child's frame at run `p1`. */
const childOf = (mem: SharedMemory, log: EventLog) => new RecordFrame(mem, log, ['runs', 'p1']);

/** Commit the frame as `stage` and release it, as the engine's frame does at the end of a stage. */
function commit(frame: RecordFrame, stage: string): void {
  frame.commit(() => ({ stage, stageId: stage, runtimeStageId: `${stage}#0` }));
  frame.release();
}

describe('Boundary: concurrent buffers', () => {
  it('100 parallel children all commit without data loss', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const children: Array<{ frame: RecordFrame; stage: string }> = [];
    for (let i = 0; i < 100; i++) {
      const child = childOf(mem, log);
      child.write(child.at(['results'], `child${i}`), i, 'set');
      children.push({ frame: child, stage: `child${i}` });
    }

    // Commit all children
    for (const { frame, stage } of children) {
      commit(frame, stage);
    }

    // Verify all results are present
    for (let i = 0; i < 100; i++) {
      expect(mem.getValue(['runs', 'p1'], ['results'], `child${i}`)).toBe(i);
    }
  });

  it('parallel children writing the same key — last commit wins', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const c1 = childOf(mem, log);
    const c2 = childOf(mem, log);
    const c3 = childOf(mem, log);

    c1.write(c1.at([], 'winner'), 'c1', 'set');
    c2.write(c2.at([], 'winner'), 'c2', 'set');
    c3.write(c3.at([], 'winner'), 'c3', 'set');

    commit(c1, 'child1');
    commit(c2, 'child2');
    commit(c3, 'child3');

    // Last commit wins
    expect(mem.getValue(['runs', 'p1'], [], 'winner')).toBe('c3');
  });

  it('parallel buffers do not see each others uncommitted writes', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const c1 = childOf(mem, log);
    const c2 = childOf(mem, log);

    c1.write(c1.at([], 'secret1'), 'from-c1', 'set');
    c2.write(c2.at([], 'secret2'), 'from-c2', 'set');

    // Neither can see the other's uncommitted writes
    expect(c1.read([], 'secret2')).toBeUndefined();
    expect(c2.read([], 'secret1')).toBeUndefined();
  });

  it('EventLog captures commits from all children', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    for (let i = 0; i < 10; i++) {
      const child = childOf(mem, log);
      child.write(child.at([], `data${i}`), i, 'set');
      commit(child, `child${i}`);
    }

    expect(log.list()).toHaveLength(10);
    const stages = log.list().map((b) => b.stage);
    for (let i = 0; i < 10; i++) {
      expect(stages).toContain(`child${i}`);
    }
  });
});
