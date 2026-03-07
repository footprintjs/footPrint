import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

function createRun(runId = 'p1') {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  return { mem, log, runId };
}

describe('Scenario: write → commit → read', () => {
  it('stage writes are visible after commit', () => {
    const { mem, log, runId } = createRun();
    const ctx = new StageContext(runId, 'validate', mem, '', log);

    ctx.setObject([], 'userName', 'Alice');
    ctx.setObject([], 'age', 30);
    ctx.commit();

    expect(mem.getValue(runId, [], 'userName')).toBe('Alice');
    expect(mem.getValue(runId, [], 'age')).toBe(30);
  });

  it('stage writes are visible to the next stage after commit', () => {
    const { mem, log, runId } = createRun();
    const stage1 = new StageContext(runId, 'stage1', mem, '', log);
    stage1.setObject([], 'counter', 1);
    stage1.commit();

    const stage2 = stage1.createNext(runId, 'stage2');
    expect(stage2.getValue([], 'counter')).toBe(1);
  });

  it('uncommitted writes are NOT visible to another stage', () => {
    const { mem, log, runId } = createRun();
    const stage1 = new StageContext(runId, 'stage1', mem, '', log);
    stage1.setObject([], 'secret', 'hidden');
    // NOT committed

    const stage2 = new StageContext(runId, 'stage2', mem, '', log);
    expect(stage2.getValue([], 'secret')).toBeUndefined();
  });

  it('read-after-write within same stage sees uncommitted writes', () => {
    const { mem, log, runId } = createRun();
    const ctx = new StageContext(runId, 'stage1', mem, '', log);

    ctx.setObject([], 'temp', 'value');
    expect(ctx.getValue([], 'temp')).toBe('value'); // before commit
  });

  it('multiple commits accumulate state', () => {
    const { mem, log, runId } = createRun();

    const s1 = new StageContext(runId, 's1', mem, '', log);
    s1.setObject([], 'a', 1);
    s1.commit();

    const s2 = s1.createNext(runId, 's2');
    s2.setObject([], 'b', 2);
    s2.commit();

    const s3 = s2.createNext(runId, 's3');
    s3.setObject([], 'c', 3);
    s3.commit();

    expect(mem.getValue(runId, [], 'a')).toBe(1);
    expect(mem.getValue(runId, [], 'b')).toBe(2);
    expect(mem.getValue(runId, [], 'c')).toBe(3);
  });

  it('EventLog records all commits', () => {
    const { mem, log, runId } = createRun();

    const s1 = new StageContext(runId, 's1', mem, '', log);
    s1.setObject([], 'x', 1);
    s1.commit();

    const s2 = s1.createNext(runId, 's2');
    s2.setObject([], 'y', 2);
    s2.commit();

    expect(log.list()).toHaveLength(2);
    expect(log.list()[0].stage).toBe('s1');
    expect(log.list()[1].stage).toBe('s2');
  });
});
