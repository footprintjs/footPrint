import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

describe('Scenario: multi-stage isolation', () => {
  it('parallel children get isolated transaction buffers', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const parent = new StageContext('p1', 'fork', mem, '', log);

    const child1 = parent.createChild('p1', 'b1', 'child1');
    const child2 = parent.createChild('p1', 'b2', 'child2');

    child1.setObject([], 'result', 'from-child1');
    child2.setObject([], 'result', 'from-child2');

    // Before commit, each child sees its own write
    expect(child1.getValue([], 'result')).toBe('from-child1');
    expect(child2.getValue([], 'result')).toBe('from-child2');

    // After child1 commits, child2 still sees its own buffered value
    child1.commit();
    expect(child2.getValue([], 'result')).toBe('from-child2');
  });

  it('parent can read children results after their commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const parent = new StageContext('p1', 'fork', mem, '', log);

    const child1 = parent.createChild('p1', 'b1', 'child1');
    const child2 = parent.createChild('p1', 'b2', 'child2');

    child1.setObject(['results'], 'child1', 'done');
    child1.commit();

    child2.setObject(['results'], 'child2', 'done');
    child2.commit();

    // Parent creates a fresh buffer and can see committed results
    const join = parent.createNext('p1', 'join');
    expect(join.getValue(['results'], 'child1')).toBe('done');
    expect(join.getValue(['results'], 'child2')).toBe('done');
  });

  it('stages in a linear chain do not share buffers', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const s1 = new StageContext('p1', 's1', mem, '', log);
    s1.setObject([], 'counter', 1);
    s1.commit();

    const s2 = s1.createNext('p1', 's2');
    // s2 has fresh buffer, sees committed value
    expect(s2.getValue([], 'counter')).toBe(1);

    s2.setObject([], 'counter', 2);
    s2.commit();

    const s3 = s2.createNext('p1', 's3');
    expect(s3.getValue([], 'counter')).toBe(2);
  });
});
