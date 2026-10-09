/**
 * Scenario: write → commit → read — a stage's frame (`RecordFrame`, footprintjs/write) at its run's address
 * (`['runs', <runId>]`): its writes reach live state at its commit, a later frame reads them, an uncommitted
 * write stays the stage's own, and the log keeps every commit.
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

function createRun(runId = 'p1') {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  /** A stage's frame of this run. */
  const frame = () => new RecordFrame(mem, log, ['runs', runId]);
  return { mem, log, runId, frame };
}

/** Commit the frame as `stage` and release it, as the engine's frame does at the end of a stage. */
function commit(frame: RecordFrame, stage: string): void {
  frame.commit(() => ({ stage, stageId: stage, runtimeStageId: `${stage}#0` }));
  frame.release();
}

describe('Scenario: write → commit → read', () => {
  it('stage writes are visible after commit', () => {
    const { mem, runId, frame } = createRun();
    const ctx = frame();

    ctx.write(ctx.at([], 'userName'), 'Alice', 'set');
    ctx.write(ctx.at([], 'age'), 30, 'set');
    commit(ctx, 'validate');

    expect(mem.getValue(['runs', runId], [], 'userName')).toBe('Alice');
    expect(mem.getValue(['runs', runId], [], 'age')).toBe(30);
  });

  it('stage writes are visible to the next stage after commit', () => {
    const { frame } = createRun();
    const stage1 = frame();
    stage1.write(stage1.at([], 'counter'), 1, 'set');
    commit(stage1, 'stage1');

    const stage2 = frame();
    expect(stage2.read([], 'counter')).toBe(1);
  });

  it('uncommitted writes are NOT visible to another stage', () => {
    const { frame } = createRun();
    const stage1 = frame();
    stage1.write(stage1.at([], 'secret'), 'hidden', 'set');
    // NOT committed

    const stage2 = frame();
    expect(stage2.read([], 'secret')).toBeUndefined();
  });

  it('read-after-write within same stage sees uncommitted writes', () => {
    const { frame } = createRun();
    const ctx = frame();

    ctx.write(ctx.at([], 'temp'), 'value', 'set');
    expect(ctx.read([], 'temp')).toBe('value'); // before commit
  });

  it('multiple commits accumulate state', () => {
    const { mem, runId, frame } = createRun();

    const s1 = frame();
    s1.write(s1.at([], 'a'), 1, 'set');
    commit(s1, 's1');

    const s2 = frame();
    s2.write(s2.at([], 'b'), 2, 'set');
    commit(s2, 's2');

    const s3 = frame();
    s3.write(s3.at([], 'c'), 3, 'set');
    commit(s3, 's3');

    expect(mem.getValue(['runs', runId], [], 'a')).toBe(1);
    expect(mem.getValue(['runs', runId], [], 'b')).toBe(2);
    expect(mem.getValue(['runs', runId], [], 'c')).toBe(3);
  });

  it('EventLog records all commits', () => {
    const { log, frame } = createRun();

    const s1 = frame();
    s1.write(s1.at([], 'x'), 1, 'set');
    commit(s1, 's1');

    const s2 = frame();
    s2.write(s2.at([], 'y'), 2, 'set');
    commit(s2, 's2');

    expect(log.list()).toHaveLength(2);
    expect(log.list()[0].stage).toBe('s1');
    expect(log.list()[1].stage).toBe('s2');
  });
});
